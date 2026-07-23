import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  memberships,
  pmCycles,
  pmCycleSnapshots,
  pmInitiativeProjects,
  pmInitiatives,
  pmIssues,
  pmLabels,
  pmProjectMilestones,
  pmProjectTeams,
  pmProjectUpdates,
  pmProjects,
  pmSamplePacks,
  pmTeams,
  pmWorkflowStates,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { PmIssuesService } from './issues.service';

/**
 * Appendix B sample pack: 24 issues across states/priorities, 2 projects
 * (milestones + health updates), 2 initiatives, a completed cycle with a
 * Cycle Review + an active cycle mid-flight with daily snapshots, and a
 * triage queue — so every P8/P11–P14 surface has something honest to show.
 * Every created id lands in pm_sample_packs; removal deletes EXACTLY those.
 */

const MARK = ' (sample)';

interface SeedIssue {
  title: string;
  cat: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
  pr: number;
  est?: number;
  project?: 1 | 2;
  milestone?: number; // index into project 1's milestones
  cycle?: boolean; // joins the active cycle
  label?: string;
  due?: number; // days from now
}

// Realistic titles (data-pm.jsx voice — no lorem).
const ISSUES: SeedIssue[] = [
  { title: 'Login fails with SSO redirect loop on Safari', cat: 'started', pr: 1, est: 5, project: 1, milestone: 2, cycle: true, label: 'Bug', due: 2 },
  { title: 'Virtualize issue list at 10k rows', cat: 'started', pr: 2, est: 8, project: 2, cycle: true, label: 'Perf', due: 4 },
  { title: 'Cycle burn-up chart from snapshots', cat: 'unstarted', pr: 3, est: 3, project: 2, cycle: true, label: 'Feature' },
  { title: 'Delta endpoint P95 regression (210ms)', cat: 'started', pr: 1, est: 5, cycle: true, label: 'Perf', due: 1 },
  { title: 'Keyboard: G-then-X goto conflicts with palette', cat: 'unstarted', pr: 3, est: 2, cycle: true, label: 'Bug' },
  { title: 'IndexedDB reset flow — corrupted store recovery', cat: 'completed', pr: 2, est: 5, project: 2, label: 'Feature' },
  { title: 'Offline queue: replay ordering test matrix', cat: 'backlog', pr: 4, est: 3, project: 2 },
  { title: 'Palette fuzzy-match highlights wrong span on unicode', cat: 'canceled', pr: 4, est: 1, label: 'Bug' },
  { title: 'PR merged but issue stayed In Review — webhook retry', cat: 'triage', pr: 0, label: 'Bug' },
  { title: 'Import: Linear CSV maps "Duplicate" to Canceled', cat: 'triage', pr: 0 },
  { title: 'Add estimate to quick-create property row', cat: 'triage', pr: 0, label: 'Feature' },
  { title: 'Launch teaser — 3 short videos for beta wave', cat: 'started', pr: 2, project: 1, milestone: 1, due: 6 },
  { title: 'Beta landing page copy — pricing section', cat: 'started', pr: 2, project: 1, milestone: 1, due: 3 },
  { title: 'Case study: Ripen Labs migration story', cat: 'unstarted', pr: 3, project: 1 },
  { title: 'Webinar dry-run with sales team', cat: 'backlog', pr: 4, due: 10 },
  { title: 'Translate launch email to DE + PT-BR', cat: 'unstarted', pr: 3, project: 1, due: 8 },
  { title: 'Bootstrap NDJSON chunking — stream hydration', cat: 'completed', pr: 2, est: 8, project: 2, cycle: true, label: 'Perf' },
  { title: 'Undo stack: inverse patches for rank moves', cat: 'unstarted', pr: 3, est: 3, project: 2, cycle: true, label: 'Feature' },
  { title: 'Glyph set — state category ring variants', cat: 'started', pr: 2, est: 2, label: 'Feature', due: 5 },
  { title: 'Requirements sign-off checklist', cat: 'completed', pr: 2, est: 3, project: 1, milestone: 0 },
  { title: 'Data migration dry-run on staging tenant', cat: 'completed', pr: 1, est: 5, project: 1, milestone: 2, cycle: true },
  { title: 'UAT scenario pack for finance flows', cat: 'backlog', pr: 3, est: 3, project: 1, milestone: 3 },
  { title: 'Kill-switch drill — flag off, same UI on REST', cat: 'backlog', pr: 2, est: 2, project: 2 },
  { title: 'Presence dots on assignee pickers', cat: 'completed', pr: 4, est: 1, label: 'Feature' },
];

const DAY_MS = 86_400_000;

@Injectable()
export class PmSampleDataService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly issues: PmIssuesService,
  ) {}

  async status(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [pack] = await tx.select().from(pmSamplePacks).limit(1);
      return { data: { loaded: !!pack, created_at: pack?.created_at ?? null } };
    });
  }

  async seed(tenantId: string, userId: string) {
    // Issue creation goes through the real service (numbering, events, sync
    // refs) OUTSIDE the ledger tx; everything else runs in one tenant tx.
    const prep = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx.select().from(pmSamplePacks).limit(1);
        if (existing) throw new BadRequestException('Sample data is already loaded — remove it first');
        const [team] = await tx
          .select()
          .from(pmTeams)
          .where(and(eq(pmTeams.tenant_id, tenantId), isNull(pmTeams.deleted_at)))
          .orderBy(asc(pmTeams.created_at))
          .limit(1);
        if (!team) throw new BadRequestException('Open Projects → Issues once so the workspace seeds its team');
        const states = await tx
          .select()
          .from(pmWorkflowStates)
          .where(and(eq(pmWorkflowStates.tenant_id, tenantId), eq(pmWorkflowStates.team_id, team.id)));
        const roster = await tx
          .select({ user_id: memberships.user_id })
          .from(memberships)
          .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.status, 'active')));
        return { team, states, roster: roster.map((r) => r.user_id) };
      },
      userId,
    );

    const { team, states, roster } = prep;
    const stateByCat = (cat: string) => states.find((s) => s.category === cat)?.id;
    const now = Date.now();
    const ids: Record<string, string[]> = {
      pm_issues: [], pm_projects: [], pm_project_milestones: [], pm_project_updates: [],
      pm_initiatives: [], pm_labels: [], pm_cycles: [],
    };

    await this.db.withTenant(
      tenantId,
      async (tx) => {
        // Cycles + triage on — the whole point of the pack is seeing them work.
        await tx
          .update(pmTeams)
          .set({ cycles_enabled: true, triage_enabled: true, cooldown_days: 2 })
          .where(eq(pmTeams.id, team.id));

        // Labels.
        for (const [name, color] of [['Bug', '#F8786B'], ['Feature', '#3E7BFA'], ['Perf', '#FED800']] as const) {
          const [row] = await tx
            .insert(pmLabels)
            .values({ tenant_id: tenantId, name: `${name}${MARK}`, color })
            .onConflictDoNothing()
            .returning();
          if (row) ids.pm_labels.push(row.id);
        }

        // Projects (2) + team links + milestones + health updates.
        const mkProject = async (p: {
          name: string; icon: string; status: string; health: string;
          startDays: number; targetDays: number;
          milestones: Array<{ name: string; days: number }>;
          updates: Array<{ health: string; body: string; daysAgo: number }>;
        }) => {
          const [proj] = await tx
            .insert(pmProjects)
            .values({
              tenant_id: tenantId, name: `${p.name}${MARK}`, icon: p.icon,
              status: p.status, health: p.health, lead_user_id: userId,
              start_date: new Date(now + p.startDays * DAY_MS).toISOString().slice(0, 10),
              target_date: new Date(now + p.targetDays * DAY_MS).toISOString().slice(0, 10),
              created_by: userId,
            })
            .returning();
          ids.pm_projects.push(proj!.id);
          await tx.insert(pmProjectTeams).values({ tenant_id: tenantId, project_id: proj!.id, team_id: team.id });
          const msIds: string[] = [];
          for (const [i, m] of p.milestones.entries()) {
            const [ms] = await tx
              .insert(pmProjectMilestones)
              .values({
                tenant_id: tenantId, project_id: proj!.id, name: m.name,
                target_date: new Date(now + m.days * DAY_MS).toISOString().slice(0, 10), position: i,
              })
              .returning();
            ids.pm_project_milestones.push(ms!.id);
            msIds.push(ms!.id);
          }
          for (const u of p.updates) {
            const [up] = await tx
              .insert(pmProjectUpdates)
              .values({
                tenant_id: tenantId, project_id: proj!.id, health: u.health,
                body_md: u.body, author_user_id: userId,
                created_at: new Date(now - u.daysAgo * DAY_MS),
              })
              .returning();
            ids.pm_project_updates.push(up!.id);
          }
          return { id: proj!.id, msIds };
        };

        const p1 = await mkProject({
          name: 'TechCorp onboarding', icon: '🤝', status: 'in_progress', health: 'at_risk',
          startDays: -28, targetDays: 17,
          milestones: [
            { name: 'Kickoff', days: -26 }, { name: 'Requirements', days: -18 },
            { name: 'Setup & migration', days: -1 }, { name: 'UAT', days: 8 }, { name: 'Go-live', days: 17 },
          ],
          updates: [
            { health: 'at_risk', body: 'Data migration slower than planned — the SSO bug blocks UAT start. Mitigation: pairing on the redirect fix this cycle.', daysAgo: 2 },
            { health: 'on_track', body: 'Kickoff + requirements signed off. Setup starts Monday.', daysAgo: 12 },
          ],
        });
        const p2 = await mkProject({
          name: 'Sync engine GA', icon: '⚡', status: 'in_progress', health: 'on_track',
          startDays: -40, targetDays: 28,
          milestones: [
            { name: 'Spike gate', days: -35 }, { name: 'Bootstrap + delta', days: -12 }, { name: 'Offline queue', days: 4 },
          ],
          updates: [
            { health: 'on_track', body: 'Two-client convergence suite green. Warm render at 420ms on the 10k reference workspace.', daysAgo: 5 },
          ],
        });

        // Initiatives (2) + links.
        const mkInit = async (name: string, desc: string, projects: string[]) => {
          const [init] = await tx
            .insert(pmInitiatives)
            .values({ tenant_id: tenantId, name: `${name}${MARK}`, description: desc, owner_user_id: userId, target_quarter: 'Q3 2026' })
            .returning();
          ids.pm_initiatives.push(init!.id);
          await tx.insert(pmInitiativeProjects).values(
            projects.map((project_id, i) => ({ tenant_id: tenantId, initiative_id: init!.id, project_id, position: i })),
          );
          return init!.id;
        };
        await mkInit('Q3 · Platform reliability', 'Sync engine GA, perf budgets in CI, zero data-loss dogfood.', [p2.id]);
        await mkInit('Q3 · Beta go-to-market', 'First 20 beta tenants onboarded and referenceable.', [p1.id]);

        // Cycles: one COMPLETED (with a review) + one ACTIVE mid-flight —
        // unless an active cycle already exists (scheduler ran first).
        const existingCycles = await tx
          .select()
          .from(pmCycles)
          .where(and(eq(pmCycles.tenant_id, tenantId), eq(pmCycles.team_id, team.id)));
        const maxNumber = existingCycles.reduce((m, c) => Math.max(m, c.number), 0);
        const [completedCycle] = await tx
          .insert(pmCycles)
          .values({
            tenant_id: tenantId, team_id: team.id, number: maxNumber + 1,
            starts_at: new Date(now - 27 * DAY_MS), ends_at: new Date(now - 13 * DAY_MS),
            cooldown_ends_at: new Date(now - 11 * DAY_MS), status: 'completed',
          })
          .returning();
        ids.pm_cycles.push(completedCycle!.id);
        let activeCycle = existingCycles.find((c) => c.status === 'active') ?? null;
        if (!activeCycle) {
          const [created] = await tx
            .insert(pmCycles)
            .values({
              tenant_id: tenantId, team_id: team.id, number: maxNumber + 2,
              starts_at: new Date(now - 11 * DAY_MS), ends_at: new Date(now + 3 * DAY_MS),
              cooldown_ends_at: new Date(now + 5 * DAY_MS), status: 'active',
            })
            .returning();
          activeCycle = created!;
          ids.pm_cycles.push(created!.id);
        }

        // Snapshots: completed cycle finals (velocity source) + a daily ramp
        // for the active cycle up to today.
        await tx.insert(pmCycleSnapshots).values([
          {
            tenant_id: tenantId, cycle_id: completedCycle!.id,
            snapshot_date: new Date(now - 13 * DAY_MS).toISOString().slice(0, 10),
            scope_points: '24', started_points: '3', completed_points: '19',
          },
        ]).onConflictDoNothing();
        const activeStart = activeCycle.starts_at.getTime();
        const days = Math.max(1, Math.min(14, Math.floor((now - activeStart) / DAY_MS)));
        const snapRows = [];
        for (let d = 0; d <= days; d++) {
          const frac = d / Math.max(days, 1);
          snapRows.push({
            tenant_id: tenantId, cycle_id: activeCycle.id,
            snapshot_date: new Date(activeStart + d * DAY_MS).toISOString().slice(0, 10),
            scope_points: String(18 + Math.round(8 * frac)),
            started_points: String(2 + Math.round(9 * frac)),
            completed_points: String(Math.round(14 * frac)),
          });
        }
        await tx.insert(pmCycleSnapshots).values(snapRows).onConflictDoNothing();

        void p1;
        void p2;
        return null;
      },
      userId,
    );

    // Issues through the real service (numbering, events, sync refs).
    const projectIds = ids.pm_projects;
    const p1Milestones = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(pmProjectMilestones)
        .where(and(eq(pmProjectMilestones.tenant_id, tenantId), eq(pmProjectMilestones.project_id, projectIds[0]!)))
        .orderBy(asc(pmProjectMilestones.position)),
    );
    const labels = ids.pm_labels.length
      ? await this.db.withTenant(tenantId, (tx) => tx.select().from(pmLabels).where(inArray(pmLabels.id, ids.pm_labels)))
      : [];
    const labelByName = new Map(labels.map((l) => [l.name.replace(MARK, ''), l.id]));
    const [activeCycleRow] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(pmCycles)
        .where(and(eq(pmCycles.tenant_id, tenantId), eq(pmCycles.team_id, team.id), eq(pmCycles.status, 'active')))
        .limit(1),
    );

    const triageState = stateByCat('triage');
    const backlogState = stateByCat('backlog');
    const returnedIds: string[] = [];
    const movedIds: string[] = [];
    for (const [i, spec] of ISSUES.entries()) {
      const assignee = spec.cat === 'triage' ? null : roster[i % roster.length] ?? userId;
      const created = await this.issues.create(tenantId, userId, {
        team_id: team.id,
        title: `${spec.title}${MARK}`,
        state_id: (spec.cat === 'triage' ? triageState : stateByCat(spec.cat)) ?? backlogState,
        priority: spec.pr,
        estimate: spec.est ?? null,
        assignee_user_id: assignee,
        due_date: spec.due ? new Date(now + spec.due * DAY_MS).toISOString().slice(0, 10) : null,
      });
      const issueId = created.data.id;
      ids.pm_issues.push(issueId);
      const patch: Record<string, unknown> = {};
      if (spec.project) patch.project_id = projectIds[spec.project - 1] ?? null;
      if (spec.milestone !== undefined && spec.project === 1) patch.milestone_id = p1Milestones[spec.milestone]?.id ?? null;
      if (spec.cycle && activeCycleRow) patch.cycle_id = activeCycleRow.id;
      if (Object.keys(patch).length) {
        await this.db.withTenant(tenantId, (tx) => tx.update(pmIssues).set(patch).where(eq(pmIssues.id, issueId)), userId);
      }
      if (spec.label && labelByName.get(spec.label)) {
        await this.issues.setLabels(tenantId, userId, issueId, [labelByName.get(spec.label)!]).catch(() => undefined);
      }
      // Feed the Cycle Review card: a couple of backlog rows "returned" from
      // the completed cycle; a couple of urgent/high "moved".
      if (spec.cat === 'backlog' && returnedIds.length < 3) returnedIds.push(issueId);
      if (spec.cycle && (spec.pr === 1 || spec.pr === 2) && movedIds.length < 2) movedIds.push(issueId);
    }

    // The completed cycle's Cycle Review (drives the P13 digest card).
    const completedId = ids.pm_cycles[0]!;
    const completedNumber = await this.db.withTenant(tenantId, async (tx) => {
      const [c] = await tx.select({ number: pmCycles.number }).from(pmCycles).where(eq(pmCycles.id, completedId));
      return c?.number ?? 1;
    });
    await this.domainEvents.publish({
      name: 'pm.cycle.rollover_completed',
      tenantId,
      actorUserId: userId,
      payload: {
        cycle_id: completedId,
        team_id: team.id,
        number: completedNumber,
        moved: movedIds.length,
        returned: returnedIds.length,
        moved_ids: movedIds,
        returned_ids: returnedIds,
        sync: [{ t: 'pm_cycles', id: completedId }],
      },
    });

    // Ledger + audit.
    await this.db.withTenant(
      tenantId,
      async (tx) => {
        await tx.insert(pmSamplePacks).values({ tenant_id: tenantId, record_ids: ids, created_by: userId });
        // One event carrying refs for EVERYTHING the pack wrote, so a live
        // sync client converges from a single delta (scoped sets ride the
        // project/initiative parent ids).
        await this.domainEvents.publish(
          {
            name: 'pm.team.updated',
            tenantId,
            actorUserId: userId,
            payload: {
              team_id: team.id,
              sync: [
                { t: 'pm_teams', id: team.id },
                ...ids.pm_cycles.map((id) => ({ t: 'pm_cycles', id })),
                ...ids.pm_projects.map((id) => ({ t: 'pm_projects', id })),
                ...ids.pm_projects.map((id) => ({ t: 'pm_project_teams', id })),
                ...ids.pm_initiatives.map((id) => ({ t: 'pm_initiatives', id })),
                ...ids.pm_initiatives.map((id) => ({ t: 'pm_initiative_projects', id })),
                ...ids.pm_project_milestones.map((id) => ({ t: 'pm_project_milestones', id })),
                ...ids.pm_project_updates.map((id) => ({ t: 'pm_project_updates', id })),
                ...ids.pm_labels.map((id) => ({ t: 'pm_labels', id })),
              ],
            },
          },
          tx,
        );
        return null;
      },
      userId,
    );
    await this.audit.log({ tenantId, actorUserId: userId, action: 'pm.sample_data.seed', resourceType: 'tenant', resourceId: tenantId });
    return { data: { loaded: true, issues: ids.pm_issues.length, projects: ids.pm_projects.length } };
  }

  async remove(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx: Db) => {
        const [pack] = await tx.select().from(pmSamplePacks).limit(1);
        if (!pack) throw new NotFoundException('No sample data is loaded');
        const ids = pack.record_ids as Record<string, string[]>;
        // FK-safe order; child rows (labels/subscribers/comments/history,
        // project links, snapshots) cascade from their parents.
        if (ids.pm_issues?.length) await tx.delete(pmIssues).where(inArray(pmIssues.id, ids.pm_issues));
        if (ids.pm_project_updates?.length) await tx.delete(pmProjectUpdates).where(inArray(pmProjectUpdates.id, ids.pm_project_updates));
        if (ids.pm_project_milestones?.length) await tx.delete(pmProjectMilestones).where(inArray(pmProjectMilestones.id, ids.pm_project_milestones));
        if (ids.pm_initiatives?.length) await tx.delete(pmInitiatives).where(inArray(pmInitiatives.id, ids.pm_initiatives));
        if (ids.pm_projects?.length) await tx.delete(pmProjects).where(inArray(pmProjects.id, ids.pm_projects));
        if (ids.pm_cycles?.length) {
          await tx.update(pmIssues).set({ cycle_id: null }).where(and(eq(pmIssues.tenant_id, tenantId), inArray(pmIssues.cycle_id, ids.pm_cycles)));
          await tx.delete(pmCycles).where(inArray(pmCycles.id, ids.pm_cycles));
        }
        if (ids.pm_labels?.length) await tx.delete(pmLabels).where(inArray(pmLabels.id, ids.pm_labels));
        await tx.delete(pmSamplePacks).where(eq(pmSamplePacks.tenant_id, tenantId));
        // Sync clients tombstone via refs (delta re-fetch finds nothing).
        await this.domainEvents.publish(
          {
            name: 'pm.issue.deleted',
            tenantId,
            actorUserId: userId,
            payload: {
              sample_removed: true,
              sync: [
                ...(ids.pm_issues ?? []).map((id) => ({ t: 'pm_issues', id })),
                ...(ids.pm_projects ?? []).map((id) => ({ t: 'pm_projects', id })),
                ...(ids.pm_initiatives ?? []).map((id) => ({ t: 'pm_initiatives', id })),
                ...(ids.pm_cycles ?? []).map((id) => ({ t: 'pm_cycles', id })),
                ...(ids.pm_labels ?? []).map((id) => ({ t: 'pm_labels', id })),
                ...(ids.pm_project_milestones ?? []).map((id) => ({ t: 'pm_project_milestones', id })),
                ...(ids.pm_project_updates ?? []).map((id) => ({ t: 'pm_project_updates', id })),
              ],
            },
          },
          tx,
        );
        await this.audit.log({ tenantId, actorUserId: userId, action: 'pm.sample_data.remove', resourceType: 'tenant', resourceId: tenantId });
        return { data: { loaded: false } };
      },
      userId,
    );
  }
}
