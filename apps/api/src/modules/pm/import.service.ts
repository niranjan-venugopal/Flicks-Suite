import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { parseCsv } from '@flicks/shared';
import {
  importBatches,
  pmTeams,
  pmTeamCounters,
  pmWorkflowStates,
  pmLabels,
  pmIssues,
  pmIssueLabels,
  pmProjects,
  pmCycles,
  memberships,
  users,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';

/**
 * PM importers (PRD v6 §14) — CSV / Linear export / Jira Cloud export on the
 * CRM import framework's lifecycle (parse → dry-run → run → 24h undo, batch
 * stamping, 10k cap, per-row errors). external_ref = '<preset>:<external id>'
 * makes re-runs idempotent: an existing ref updates instead of duplicating.
 * Direct bulk inserts (numbering reserved per team in one counter bump);
 * clients converge via chunked pm.import.completed events carrying sync refs.
 */

const MAX_ROWS = 10_000;
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENT_CHUNK = 200;

export const PM_IMPORT_TARGETS = [
  'title',
  'description',
  'team',
  'state',
  'priority',
  'estimate',
  'assignee_email',
  'labels',
  'external_id',
  'project',
  'cycle',
  'due_date',
  'skip',
] as const;
type PmTarget = (typeof PM_IMPORT_TARGETS)[number];

export type PmImportPreset = 'linear' | 'jira' | 'csv';

// Header aliases per preset — Linear/Jira CSV export column names first.
const ALIASES: Record<string, PmTarget> = {
  title: 'title', summary: 'title', name: 'title',
  description: 'description',
  team: 'team', 'team key': 'team', 'project key': 'team',
  state: 'state', status: 'state',
  priority: 'priority',
  estimate: 'estimate', 'story point estimate': 'estimate', 'story points': 'estimate', points: 'estimate',
  assignee: 'assignee_email', 'assignee email': 'assignee_email',
  labels: 'labels', label: 'labels', tags: 'labels',
  id: 'external_id', identifier: 'external_id', 'issue key': 'external_id', key: 'external_id',
  project: 'project', 'epic link': 'project', epic: 'project', 'parent summary': 'project',
  cycle: 'cycle', sprint: 'cycle',
  'due date': 'due_date', due: 'due_date',
};

const PRIORITY_MAP: Record<string, number> = {
  urgent: 1, highest: 1, high: 2, medium: 3, normal: 3, low: 4, lowest: 4,
  'no priority': 0, none: 0, '': 0,
};

// Jira/Linear status names → workflow category when no exact state matches.
const STATUS_CATEGORY: Record<string, string> = {
  triage: 'triage',
  backlog: 'backlog',
  todo: 'unstarted', 'to do': 'unstarted', open: 'unstarted', unstarted: 'unstarted',
  'in progress': 'started', started: 'started', 'in review': 'started', review: 'started',
  done: 'completed', completed: 'completed', closed: 'completed', resolved: 'completed',
  canceled: 'canceled', cancelled: 'canceled', duplicate: 'canceled', "won't do": 'canceled',
};

interface RowPlan {
  row: number; // 1-based + header
  action: 'create' | 'update' | 'skip' | 'error';
  reason?: string;
  values: Record<string, string>;
  existing_id?: string;
  team_id?: string;
}

interface PlanContext {
  teamsByKey: Map<string, { id: string; default_state_id: string | null }>;
  statesByTeam: Map<string, Array<{ id: string; name: string; category: string; position: number }>>;
  usersByEmail: Map<string, string>;
  existingByRef: Map<string, string>;
}

function suggestTarget(header: string): PmTarget {
  const h = header.trim().toLowerCase();
  if (ALIASES[h]) return ALIASES[h];
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (h.includes(alias)) return target;
  }
  return 'skip';
}

@Injectable()
export class PmImportService {
  private readonly logger = new Logger(PmImportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  // ─── parse ─────────────────────────────────────────────────────────────────

  parse(dto: { csv: string; file_name?: string }) {
    const rows = parseCsv(dto.csv);
    if (rows.length < 2) throw new BadRequestException('CSV needs a header row and at least one data row');
    if (rows.length - 1 > MAX_ROWS) throw new BadRequestException(`Row cap is ${MAX_ROWS.toLocaleString()}`);
    const [header, ...data] = rows;
    return {
      data: {
        file_name: dto.file_name ?? 'import.csv',
        rows: data.length,
        headers: header!.map((column, i) => ({
          column,
          suggested: suggestTarget(column),
          samples: data.slice(0, 3).map((r) => r[i] ?? ''),
        })),
        targets: PM_IMPORT_TARGETS,
      },
    };
  }

  // ─── plan (shared by dry-run + run) ────────────────────────────────────────

  private async buildContext(tx: Db, tenantId: string, preset: PmImportPreset, refs: string[]): Promise<PlanContext> {
    const teams = await tx
      .select({ id: pmTeams.id, key: pmTeams.key, default_state_id: pmTeams.default_state_id })
      .from(pmTeams)
      .where(and(eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)));
    const states = await tx
      .select({ id: pmWorkflowStates.id, team_id: pmWorkflowStates.team_id, name: pmWorkflowStates.name, category: pmWorkflowStates.category, position: pmWorkflowStates.position })
      .from(pmWorkflowStates)
      .where(eq(pmWorkflowStates.tenant_id, tenantId));
    const members = await tx
      .select({ user_id: memberships.user_id, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.user_id))
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.status, 'active')));
    const existing = refs.length
      ? await tx
          .select({ id: pmIssues.id, external_ref: pmIssues.external_ref })
          .from(pmIssues)
          .where(and(eq(pmIssues.tenant_id, tenantId), inArray(pmIssues.external_ref, refs)))
      : [];
    const statesByTeam = new Map<string, Array<{ id: string; name: string; category: string; position: number }>>();
    for (const s of states) {
      const list = statesByTeam.get(s.team_id) ?? [];
      list.push(s);
      statesByTeam.set(s.team_id, list);
    }
    return {
      teamsByKey: new Map(teams.map((t) => [t.key.toUpperCase(), { id: t.id, default_state_id: t.default_state_id }])),
      statesByTeam,
      usersByEmail: new Map(members.map((m) => [m.email.toLowerCase(), m.user_id])),
      existingByRef: new Map(existing.map((e) => [e.external_ref!, e.id])),
    };
  }

  private resolveState(ctx: PlanContext, teamId: string, raw: string): string | null {
    const states = (ctx.statesByTeam.get(teamId) ?? []).slice().sort((a, b) => a.position - b.position);
    if (!states.length) return null;
    const wanted = raw.trim().toLowerCase();
    if (wanted) {
      const exact = states.find((s) => s.name.toLowerCase() === wanted);
      if (exact) return exact.id;
      const cat = STATUS_CATEGORY[wanted];
      if (cat) {
        const byCat = states.find((s) => s.category === cat);
        if (byCat) return byCat.id;
      }
    }
    return null; // caller falls back to the team default
  }

  private async plan(
    tx: Db,
    tenantId: string,
    dto: { csv: string; mapping: Record<string, string>; strategy?: 'skip' | 'update'; preset: PmImportPreset },
  ): Promise<{ plans: RowPlan[]; ctx: PlanContext }> {
    const rows = parseCsv(dto.csv);
    if (rows.length - 1 > MAX_ROWS) throw new BadRequestException(`Row cap is ${MAX_ROWS.toLocaleString()}`);
    const [header, ...data] = rows;
    const idx: Partial<Record<PmTarget, number>> = {};
    header!.forEach((col, i) => {
      const target = (dto.mapping[col] ?? 'skip') as PmTarget;
      if (target !== 'skip' && (PM_IMPORT_TARGETS as readonly string[]).includes(target) && idx[target] === undefined) {
        idx[target] = i;
      }
    });
    if (idx.title === undefined) throw new BadRequestException('Map a column to "title"');

    const val = (r: string[], t: PmTarget) => (idx[t] === undefined ? '' : (r[idx[t]!] ?? '').trim());
    const refFor = (r: string[]) => {
      const ext = val(r, 'external_id');
      return ext ? `${dto.preset}:${ext}` : null;
    };
    const refs = data.map(refFor).filter((x): x is string => !!x);
    const ctx = await this.buildContext(tx, tenantId, dto.preset, refs);
    const strategy = dto.strategy ?? 'update';
    const fallbackTeam = [...ctx.teamsByKey.values()][0] ?? null;

    const plans: RowPlan[] = data.map((r, i) => {
      const row = i + 2;
      const title = val(r, 'title');
      if (!title) return { row, action: 'error' as const, reason: 'missing title', values: {} };
      const teamKey = val(r, 'team').toUpperCase();
      const team = teamKey ? ctx.teamsByKey.get(teamKey) : fallbackTeam;
      if (!team) return { row, action: 'error' as const, reason: teamKey ? `unknown team "${teamKey}"` : 'no team in workspace', values: {} };
      const values: Record<string, string> = {
        title,
        description: val(r, 'description'),
        state: val(r, 'state'),
        priority: val(r, 'priority'),
        estimate: val(r, 'estimate'),
        assignee_email: val(r, 'assignee_email').toLowerCase(),
        labels: val(r, 'labels'),
        project: val(r, 'project'),
        cycle: val(r, 'cycle'),
        due_date: val(r, 'due_date'),
        external_ref: refFor(r) ?? '',
      };
      const existing = values.external_ref ? ctx.existingByRef.get(values.external_ref) : undefined;
      if (existing) {
        return strategy === 'update'
          ? { row, action: 'update' as const, values, existing_id: existing, team_id: team.id }
          : { row, action: 'skip' as const, reason: 'external id exists', values, team_id: team.id };
      }
      return { row, action: 'create' as const, values, team_id: team.id };
    });
    return { plans, ctx };
  }

  // ─── dry run ───────────────────────────────────────────────────────────────

  async dryRun(
    tenantId: string,
    userId: string,
    dto: { csv: string; mapping: Record<string, string>; strategy?: 'skip' | 'update'; preset: PmImportPreset },
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const { plans } = await this.plan(tx, tenantId, dto);
        return {
          data: {
            rows_read: plans.length,
            will_create: plans.filter((p) => p.action === 'create').length,
            will_update: plans.filter((p) => p.action === 'update').length,
            will_skip: plans.filter((p) => p.action === 'skip').length,
            errors: plans.filter((p) => p.action === 'error').length,
            preview: plans.slice(0, 50).map((p) => ({
              row: p.row,
              action: p.action,
              title: p.values.title ?? '',
              reason: p.reason,
            })),
          },
        };
      },
      userId,
    );
  }

  // ─── run ───────────────────────────────────────────────────────────────────

  async run(
    tenantId: string,
    userId: string,
    dto: { csv: string; file_name?: string; mapping: Record<string, string>; strategy?: 'skip' | 'update'; preset: PmImportPreset },
  ) {
    const result = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const { plans, ctx } = await this.plan(tx, tenantId, dto);
        const [batch] = await tx
          .insert(importBatches)
          .values({
            tenant_id: tenantId,
            object_type: 'pm_issues',
            file_name: dto.file_name ?? 'import.csv',
            created_by: userId,
            rows_read: plans.length,
          })
          .returning();
        const batchId = batch!.id;
        const errors: Array<{ row: number; error: string }> = [];
        const createdIds: string[] = [];
        const updatedIds: string[] = [];
        const projectCreatedIds: string[] = [];
        const projectIds = new Map<string, string>(); // name → id (find-or-create once)

        const resolveProject = async (name: string): Promise<string | null> => {
          if (!name) return null;
          if (projectIds.has(name)) return projectIds.get(name)!;
          const ref = `${dto.preset}:project:${name}`;
          const [existing] = await tx
            .select({ id: pmProjects.id })
            .from(pmProjects)
            .where(and(eq(pmProjects.tenant_id, tenantId), eq(pmProjects.external_ref, ref)))
            .limit(1);
          if (existing) {
            projectIds.set(name, existing.id);
            return existing.id;
          }
          const [byName] = await tx
            .select({ id: pmProjects.id })
            .from(pmProjects)
            .where(and(eq(pmProjects.tenant_id, tenantId), eq(pmProjects.name, name), isNull(pmProjects.deleted_at)))
            .limit(1);
          if (byName) {
            projectIds.set(name, byName.id);
            return byName.id;
          }
          const [proj] = await tx
            .insert(pmProjects)
            .values({ tenant_id: tenantId, name, created_by: userId, import_batch_id: batchId, external_ref: ref })
            .returning({ id: pmProjects.id });
          projectIds.set(name, proj!.id);
          projectCreatedIds.push(proj!.id); // refs only — undo covers it via batch
          return proj!.id;
        };

        const labelIds = new Map<string, string>();
        const resolveLabels = async (raw: string): Promise<string[]> => {
          const names = raw.split(/[;,]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
          const out: string[] = [];
          for (const name of names) {
            if (labelIds.has(name)) { out.push(labelIds.get(name)!); continue; }
            const [existing] = await tx
              .select({ id: pmLabels.id })
              .from(pmLabels)
              .where(and(eq(pmLabels.tenant_id, tenantId), isNull(pmLabels.team_id), eq(pmLabels.name, name)))
              .limit(1);
            const id = existing?.id ?? (
              await tx.insert(pmLabels).values({ tenant_id: tenantId, name, color: '#5C6477' }).returning({ id: pmLabels.id })
            )[0]!.id;
            labelIds.set(name, id);
            out.push(id);
          }
          return out;
        };

        const cycleByTeam = new Map<string, Map<number, string>>();
        const resolveCycle = async (teamId: string, raw: string): Promise<string | null> => {
          const m = raw.match(/(\d{1,4})/);
          if (!m) return null;
          const number = Number(m[1]);
          if (!cycleByTeam.has(teamId)) {
            const rows = await tx
              .select({ id: pmCycles.id, number: pmCycles.number })
              .from(pmCycles)
              .where(and(eq(pmCycles.tenant_id, tenantId), eq(pmCycles.team_id, teamId)));
            cycleByTeam.set(teamId, new Map(rows.map((c) => [c.number, c.id])));
          }
          return cycleByTeam.get(teamId)!.get(number) ?? null; // link-only; no back-dated cycle creation
        };

        // Reserve issue numbers per team in ONE counter bump each.
        const createsByTeam = new Map<string, RowPlan[]>();
        for (const p of plans) {
          if (p.action !== 'create') continue;
          const list = createsByTeam.get(p.team_id!) ?? [];
          list.push(p);
          createsByTeam.set(p.team_id!, list);
        }
        const nextNumber = new Map<string, number>();
        for (const [teamId, list] of createsByTeam) {
          const [counter] = await tx
            .update(pmTeamCounters)
            .set({ last_number: sql`${pmTeamCounters.last_number} + ${list.length}` })
            .where(eq(pmTeamCounters.team_id, teamId))
            .returning({ last_number: pmTeamCounters.last_number });
          nextNumber.set(teamId, counter!.last_number - list.length + 1);
        }

        for (const p of plans) {
          if (p.action === 'error') { errors.push({ row: p.row, error: p.reason ?? 'invalid row' }); continue; }
          if (p.action === 'skip') continue;
          try {
            const v = p.values;
            const teamId = p.team_id!;
            const team = [...ctx.teamsByKey.values()].find((t) => t.id === teamId)!;
            const stateId = this.resolveState(ctx, teamId, v.state ?? '') ?? team.default_state_id;
            if (!stateId) throw new Error('team has no workflow states');
            const priorityRaw = (v.priority ?? '').toLowerCase();
            const priority = /^[0-4]$/.test(priorityRaw) ? Number(priorityRaw) : (PRIORITY_MAP[priorityRaw] ?? 0);
            const estimate = v.estimate && !Number.isNaN(Number(v.estimate)) ? String(Number(v.estimate)) : null;
            const assignee = v.assignee_email ? (ctx.usersByEmail.get(v.assignee_email) ?? null) : null;
            const projectId = await resolveProject(v.project ?? '');
            const cycleId = v.cycle ? await resolveCycle(teamId, v.cycle) : null;
            const dueDate = v.due_date && /^\d{4}-\d{2}-\d{2}/.test(v.due_date) ? v.due_date.slice(0, 10) : null;

            if (p.action === 'update') {
              await tx
                .update(pmIssues)
                .set({
                  title: v.title!,
                  ...(v.description ? { description: v.description } : {}),
                  ...(stateId ? { state_id: stateId } : {}),
                  priority,
                  ...(estimate !== null ? { estimate } : {}),
                  ...(assignee ? { assignee_user_id: assignee } : {}),
                  ...(projectId ? { project_id: projectId } : {}),
                  updated_at: new Date(),
                })
                .where(and(eq(pmIssues.id, p.existing_id!), eq(pmIssues.tenant_id, tenantId)))
                .returning({ id: pmIssues.id });
              updatedIds.push(p.existing_id!);
            } else {
              const number = nextNumber.get(teamId)!;
              nextNumber.set(teamId, number + 1);
              const [issue] = await tx
                .insert(pmIssues)
                .values({
                  tenant_id: tenantId,
                  team_id: teamId,
                  number,
                  title: v.title!,
                  description: v.description || null,
                  state_id: stateId,
                  priority,
                  estimate,
                  assignee_user_id: assignee,
                  creator_user_id: userId,
                  project_id: projectId,
                  cycle_id: cycleId,
                  due_date: dueDate,
                  source: 'import',
                  import_batch_id: batchId,
                  external_ref: v.external_ref || null,
                  board_rank: 'zz',
                  backlog_rank: 'zz',
                })
                .returning({ id: pmIssues.id });
              createdIds.push(issue!.id);
              const labels = v.labels ? await resolveLabels(v.labels) : [];
              if (labels.length) {
                await tx
                  .insert(pmIssueLabels)
                  .values(labels.map((labelId) => ({ tenant_id: tenantId, issue_id: issue!.id, label_id: labelId })))
                  .onConflictDoNothing();
              }
            }
          } catch (err) {
            errors.push({ row: p.row, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          }
        }

        const created = createdIds.length;
        const updated = updatedIds.length;
        const skipped = plans.filter((x) => x.action === 'skip').length + errors.length;
        await tx
          .update(importBatches)
          .set({ rows_created: created, rows_updated: updated, rows_skipped: skipped, errors: errors.slice(0, 200) })
          .where(eq(importBatches.id, batchId));

        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.import.run',
          resourceType: 'import_batch',
          resourceId: batchId,
          metadata: { preset: dto.preset, created, updated, skipped, errors: errors.length },
        });
        // Chunked catch-up events — FSE clients pull the imported rows via delta.
        const allRefs = [
          ...[...createdIds, ...updatedIds].map((id) => ({ t: 'pm_issues', id })),
          ...projectCreatedIds.map((id) => ({ t: 'pm_projects', id })),
        ];
        for (let i = 0; i < allRefs.length; i += EVENT_CHUNK) {
          await this.domainEvents.publish(
            {
              name: 'pm.import.completed',
              tenantId,
              actorUserId: userId,
              payload: { batch_id: batchId, chunk: i / EVENT_CHUNK, sync: allRefs.slice(i, i + EVENT_CHUNK) },
            },
            tx,
          );
        }
        return { data: { batch_id: batchId, created, updated, skipped, errors: errors.slice(0, 200) } };
      },
      userId,
    );
    return result;
  }

  // ─── batches + undo ────────────────────────────────────────────────────────

  async batches(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx
          .select()
          .from(importBatches)
          .where(and(eq(importBatches.tenant_id, tenantId), inArray(importBatches.object_type, ['pm_issues', 'pm_projects'])))
          .orderBy(sql`${importBatches.created_at} DESC`)
          .limit(20);
        return { data: rows };
      },
      userId,
    );
  }

  async undo(tenantId: string, userId: string, batchId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [batch] = await tx
          .select()
          .from(importBatches)
          .where(
            and(
              eq(importBatches.id, batchId),
              eq(importBatches.tenant_id, tenantId),
              // import_batches is shared with CRM — without this guard a PM
              // undo would stamp a CRM lead batch 'undone', stranding it
              // (CRM's own undo then refuses with "Already undone").
              inArray(importBatches.object_type, ['pm_issues', 'pm_projects']),
            ),
          )
          .limit(1);
        if (!batch) throw new BadRequestException('Batch not found');
        if (batch.status === 'undone') throw new BadRequestException('Already undone');
        if (Date.now() - batch.created_at.getTime() > UNDO_WINDOW_MS) {
          throw new BadRequestException('Undo window (24h) has passed');
        }
        const issues = await tx
          .update(pmIssues)
          .set({ deleted_at: new Date() })
          .where(and(eq(pmIssues.tenant_id, tenantId), eq(pmIssues.import_batch_id, batchId), isNull(pmIssues.deleted_at)))
          .returning({ id: pmIssues.id });
        const projects = await tx
          .update(pmProjects)
          .set({ deleted_at: new Date() })
          .where(and(eq(pmProjects.tenant_id, tenantId), eq(pmProjects.import_batch_id, batchId), isNull(pmProjects.deleted_at)))
          .returning({ id: pmProjects.id });
        await tx
          .update(importBatches)
          .set({ status: 'undone', undone_at: new Date() })
          .where(eq(importBatches.id, batchId));
        await this.audit.log({
          tenantId,
          actorUserId: userId,
          action: 'pm.import.undo',
          resourceType: 'import_batch',
          resourceId: batchId,
          metadata: { issues: issues.length, projects: projects.length },
        });
        // Tombstone-driving refs: delta re-fetch misses soft-deleted rows.
        const refs = [
          ...issues.map((i) => ({ t: 'pm_issues', id: i.id })),
          ...projects.map((p) => ({ t: 'pm_projects', id: p.id })),
        ];
        for (let i = 0; i < refs.length; i += EVENT_CHUNK) {
          await this.domainEvents.publish(
            {
              name: 'pm.import.completed',
              tenantId,
              actorUserId: userId,
              payload: { batch_id: batchId, undo: true, sync: refs.slice(i, i + EVENT_CHUNK) },
            },
            tx,
          );
        }
        return { data: { undone: true, issues: issues.length, projects: projects.length } };
      },
      userId,
    );
  }
}
