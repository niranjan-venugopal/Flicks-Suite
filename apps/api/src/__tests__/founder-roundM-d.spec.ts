/**
 * Founder round M (2026-09-17) — agent D: projects listing rollup, milestone
 * descriptions, and the project description's attachments.
 *
 *  Milestones — create/update accept `description_md`, cleaned with the
 *           same cleaner as issue descriptions (tags out, URL allowlist,
 *           20 000-char cap ⇒ 400); '' clears to NULL; the sync executor
 *           forwards it on milestone.create and milestone.update and the
 *           delta projection carries it.
 *  Listing — `list().data.milestones[projectId] = { done, total }` from ONE
 *           grouped query, ISSUE-count based (not estimate points — the same
 *           rule as the update snapshot's per-milestone scope/done and the
 *           web's milestoneStats): a milestone is done only when it has live
 *           issues and every one of them is completed; one whose only issue
 *           is canceled, or that has no issues, counts toward total and never
 *           toward done. Rows carry `priority`.
 *  Files  — PmFileObjectType gains 'project': GET pm/projects/:id/files lists
 *           the description's files; POST pm/projects/:id/files/bind binds the
 *           caller's own live drafts. Both answer 404 for another tenant, a
 *           non-member of a private project, a guest outside their project,
 *           an unknown id; guests are refused (403) on the write paths like
 *           every project edit.
 *
 * Service-level against the real Postgres (pm-sync harness; R2 stubbed).
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmWorkflowStates,
  pmProjects,
  pmProjectMembers,
  pmProjectMilestones,
  pmIssues,
  recordFiles,
  domainEvents,
  auditLog,
} from '@flicks/db/schema';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, NotFoundException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService, MILESTONE_DESCRIPTION_MAX_LEN } from '../modules/pm/projects.service';
import { PmFilesService } from '../modules/pm/files.service';
import { BindProjectFilesDto, PmFilesController, UploadFilesDto } from '../modules/pm/files.controller';
import { CreateMilestoneDto, UpdateMilestoneDto } from '../modules/pm/pm.controller';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';

jest.setTimeout(120_000);

const rid = () => crypto.randomBytes(4).toString('hex');
const media = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never;
const notificationsStub = { createInAppNotification: async () => undefined, sendEmail: async () => true } as never;

const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, media);
// R2 stubbed (no storage in CI) — signing is a pure function of the key.
const r2 = {
  isConfigured: () => true,
  putObject: jest.fn(async () => undefined),
  signedGetUrl: jest.fn(async (key: string, ttl?: number) => `https://signed.test/${key}?ttl=${ttl}`),
  deleteObjects: jest.fn(async () => undefined),
  deleteObject: jest.fn(async () => undefined),
};
const filesSvc = new PmFilesService(dbSvc, dbAdmin as never, visibility, r2 as never, audit);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsStub, visibility, filesSvc);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, media);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc, media);
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, { emitSeq: jest.fn() } as never);

const csv = (tag = rid()) => Buffer.from(`name,qty\n${tag},1\n`);
const draft = async (userId: string, tenant = T1) =>
  (await filesSvc.upload(tenant, userId, {
    objectType: 'draft',
    objectId: crypto.randomUUID(),
    kind: 'attachment',
    files: [{ buffer: csv(), originalname: `d-${rid()}.csv` }],
  })).data[0]!;

// ─── Fixtures ────────────────────────────────────────────────────────────────

let T1: string;
let T2: string;
let ownerId: string;
let memberId: string; // employee seat — not a lead, not a project member
let guestId: string; // project-scoped seat on projectG1 only
let t2OwnerId: string;
let teamA: { id: string; key: string };
let completedStateId: string;
let canceledStateId: string;
let startedStateId: string;
let projectG1: string; // the guest's project
let projectG2: string; // another public project, not the guest's
const userIds: string[] = [];

async function mkUser(label: string, tenantId: string, role: 'owner' | 'employee' | 'guest') {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rmd-${label}-${rid()}@t.test`, full_name: `${label} Tester`, status: 'active' })
    .returning();
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
  userIds.push(u!.id);
  return u!.id;
}

const mkProject = (name: string, extra: Record<string, unknown> = {}) =>
  projectsSvc.create(T1, ownerId, { name, team_ids: [teamA.id], ...extra }).then((r) => r.data);
const mkMilestone = (projectId: string, name: string, extra: Record<string, unknown> = {}) =>
  projectsSvc.createMilestone(T1, ownerId, { project_id: projectId, name, ...extra }).then((r) => r.data);
const mkIssue = (projectId: string, milestoneId: string | null, title: string, extra: Record<string, unknown> = {}) =>
  issuesSvc
    .create(T1, ownerId, { team_id: teamA.id, title, project_id: projectId, ...(milestoneId ? { milestone_id: milestoneId } : {}), ...extra })
    .then((r) => r.data);

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RM-D ${rid()}`, slug: `rmd-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T1 = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `RM-D Other ${rid()}`, slug: `rmd2-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  T2 = t2!.id;
  ownerId = await mkUser('owner', T1, 'owner');
  memberId = await mkUser('member', T1, 'employee');
  guestId = await mkUser('guest', T1, 'guest');
  t2OwnerId = await mkUser('zed', T2, 'owner');

  await teamsSvc.ensureWorkspace(T1, ownerId);
  const [a] = await dbAdmin.select({ id: pmTeams.id, key: pmTeams.key }).from(pmTeams).where(eq(pmTeams.tenant_id, T1));
  teamA = a!;
  const states = await dbAdmin
    .select({ id: pmWorkflowStates.id, category: pmWorkflowStates.category })
    .from(pmWorkflowStates)
    .where(and(eq(pmWorkflowStates.tenant_id, T1), eq(pmWorkflowStates.team_id, teamA.id)));
  completedStateId = states.find((s) => s.category === 'completed')!.id;
  canceledStateId = states.find((s) => s.category === 'canceled')!.id;
  startedStateId = states.find((s) => s.category === 'started')!.id;

  projectG1 = (await mkProject('Guest project')).id;
  projectG2 = (await mkProject('Other project')).id;
  await dbAdmin.insert(pmProjectMembers).values({ tenant_id: T1, project_id: projectG1, user_id: guestId });

  await teamsSvc.ensureWorkspace(T2, t2OwnerId);
});

afterAll(async () => {
  for (const t of [T1, T2]) {
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, t));
    await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  }
  if (userIds.length) await dbAdmin.delete(users).where(inArray(users.id, userIds));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ═════════════════════════════════════════════════════════════════════════════
// Milestones — description_md
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — milestone description_md round-trips through create + update, cleaned', () => {
  const fileId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('create stores the cleaned body; update cleans too; "" clears to NULL; over the cap is a 400 with nothing written', async () => {
    const project = await mkProject('Described milestones');
    const created = await mkMilestone(project.id, 'Alpha', {
      description_md: `hello <img src=x onerror=alert(1)> world\n\n![shot](flicks-file://${fileId.toUpperCase()}) [x](javascript:alert(1))`,
    });
    expect(created.description_md).toBe(`hello  world\n\n![shot](flicks-file://${fileId}) x`);
    // No description → NULL, not ''.
    const bare = await mkMilestone(project.id, 'Beta');
    expect(bare.description_md).toBeNull();

    const updated = (await projectsSvc.updateMilestone(T1, ownerId, created.id, {
      description_md: '<script>alert(1)</script>kept `<b>` ![a](http://evil.test/x.png)',
    })).data;
    expect(updated.description_md).toBe('kept `<b>` a');
    expect(updated.name).toBe('Alpha'); // untouched fields stay
    // A name-only patch leaves the description alone.
    const renamed = (await projectsSvc.updateMilestone(T1, ownerId, created.id, { name: 'Alpha 2' })).data;
    expect(renamed.description_md).toBe('kept `<b>` a');
    // '' clears.
    expect((await projectsSvc.updateMilestone(T1, ownerId, created.id, { description_md: '' })).data.description_md).toBeNull();
    // The cap.
    await expect(
      projectsSvc.updateMilestone(T1, ownerId, created.id, { description_md: 'x'.repeat(MILESTONE_DESCRIPTION_MAX_LEN + 1) }),
    ).rejects.toThrow(/too long/);
    await expect(
      mkMilestone(project.id, 'Too long', { description_md: 'x'.repeat(MILESTONE_DESCRIPTION_MAX_LEN + 1) }),
    ).rejects.toThrow(BadRequestException);
    const rows = await dbAdmin
      .select({ id: pmProjectMilestones.id })
      .from(pmProjectMilestones)
      .where(and(eq(pmProjectMilestones.tenant_id, T1), eq(pmProjectMilestones.project_id, project.id)));
    expect(rows).toHaveLength(2);
    // detail() ships it.
    const d = (await projectsSvc.detail(T1, ownerId, project.id)).data;
    expect(d.milestones.find((m) => m.id === created.id)!.description_md).toBeNull();
  });

  it('the sync executor forwards description_md on milestone.create and milestone.update; the delta projection carries it', async () => {
    const project = await mkProject('Executor milestones');
    const msId = crypto.randomUUID();
    const before = await syncSvc.latestSeq(T1);
    const res = await executor.execute(T1, ownerId, [
      {
        clientMutationId: crypto.randomUUID(),
        op: 'milestone.create' as const,
        id: msId,
        fields: { project_id: project.id, name: 'Via sync', target_date: null, position: 0, description_md: 'first <b>pass</b>' },
      },
      {
        clientMutationId: crypto.randomUUID(),
        op: 'milestone.update' as const,
        id: msId,
        fields: { description_md: 'second [ok](https://example.com) <script>x</script>' },
      },
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    const [row] = await dbAdmin.select().from(pmProjectMilestones).where(eq(pmProjectMilestones.id, msId));
    expect(row!.description_md).toBe('second [ok](https://example.com)');
    const delta = await syncSvc.delta(T1, ownerId, before);
    if (!('upserts' in delta)) throw new Error('unexpected re-bootstrap');
    const shipped = ((delta.upserts.pm_project_milestones ?? []) as Array<{ id: string; description_md: string | null }>).find((m) => m.id === msId);
    expect(shipped?.description_md).toBe('second [ok](https://example.com)');
    // A field-less update is a no-op that still returns the row.
    const noop = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'milestone.update' as const, id: msId, fields: {} },
    ]);
    expect(noop.results[0]!.status).toBe('applied');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Listing — milestones rollup + priority
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — list() carries the milestone rollup and priority', () => {
  it('milestones[projectId] = { done, total }: done only when every live issue is completed; canceled-only and empty milestones count toward total only', async () => {
    const project = await mkProject('Rollup');
    const done = await mkMilestone(project.id, 'Done');
    const canceledOnly = await mkMilestone(project.id, 'Canceled only');
    const empty = await mkMilestone(project.id, 'Empty');
    const half = await mkMilestone(project.id, 'Half');
    const mixed = await mkMilestone(project.id, 'Completed + canceled');

    const i1 = await mkIssue(project.id, done.id, 'finished');
    await issuesSvc.moveState(T1, ownerId, i1.id, completedStateId);
    const i2 = await mkIssue(project.id, canceledOnly.id, 'dropped');
    await issuesSvc.moveState(T1, ownerId, i2.id, canceledStateId);
    const i3 = await mkIssue(project.id, half.id, 'in progress');
    await issuesSvc.moveState(T1, ownerId, i3.id, startedStateId);
    const i4 = await mkIssue(project.id, half.id, 'shipped');
    await issuesSvc.moveState(T1, ownerId, i4.id, completedStateId);
    // Completed + canceled: canceled is excluded from scope, so this one IS done.
    const i5 = await mkIssue(project.id, mixed.id, 'shipped too');
    await issuesSvc.moveState(T1, ownerId, i5.id, completedStateId);
    const i6 = await mkIssue(project.id, mixed.id, 'dropped too');
    await issuesSvc.moveState(T1, ownerId, i6.id, canceledStateId);
    // A deleted issue never counts.
    const i7 = await mkIssue(project.id, empty.id, 'gone');
    await issuesSvc.softDelete(T1, ownerId, i7.id);

    const list = (await projectsSvc.list(T1, ownerId)).data;
    expect(list.milestones[project.id]).toEqual({ done: 2, total: 5 });
    // A project without milestones is present with zeros (never undefined).
    expect(list.milestones[projectG2]).toEqual({ done: 0, total: 0 });
    // Every visible project has an entry.
    for (const p of list.projects) expect(list.milestones[p.id]).toBeDefined();
    // The rollup agrees with the per-project progress on the same issues.
    expect(list.progress[project.id]).toEqual({ scope: 4, started: 1, done: 3 });
    // Names are irrelevant, ids are: the empty one stays a milestone.
    const rows = await dbAdmin
      .select({ id: pmProjectMilestones.id })
      .from(pmProjectMilestones)
      .where(eq(pmProjectMilestones.project_id, project.id));
    expect(rows.map((r) => r.id).sort()).toEqual([done.id, canceledOnly.id, empty.id, half.id, mixed.id].sort());

    // Finishing the started issue completes "Half".
    await issuesSvc.moveState(T1, ownerId, i3.id, completedStateId);
    expect((await projectsSvc.list(T1, ownerId)).data.milestones[project.id]).toEqual({ done: 3, total: 5 });
    // Deleting a milestone drops it from total.
    await projectsSvc.deleteMilestone(T1, ownerId, empty.id);
    expect((await projectsSvc.list(T1, ownerId)).data.milestones[project.id]).toEqual({ done: 3, total: 4 });
  });

  it('the rollup is ISSUE-count based, not estimate-weighted — the same rule as the update snapshot (a 0-point open issue still holds a milestone open)', async () => {
    const project = await mkProject('Weighted');
    const weighted = await mkMilestone(project.id, 'Weighted');
    // Estimate-weighted (done ≥ scope over coalesce(estimate, 1)) would call
    // this milestone complete — 3 of 3 points. Count-based: 1 of 2 issues.
    const big = await mkIssue(project.id, weighted.id, 'the 3-pointer', { estimate: 3 });
    await issuesSvc.moveState(T1, ownerId, big.id, completedStateId);
    const zero = await mkIssue(project.id, weighted.id, 'the 0-pointer', { estimate: 0 });
    await issuesSvc.moveState(T1, ownerId, zero.id, startedStateId);

    let list = (await projectsSvc.list(T1, ownerId)).data;
    expect(list.milestones[project.id]).toEqual({ done: 0, total: 1 });
    // The project-level progress bar stays estimate-weighted (long-standing computeProgress).
    expect(list.progress[project.id]).toEqual({ scope: 3, started: 0, done: 3 });
    // Agent C's update snapshot judges the milestone by the same count rule: 1 of 2, halfway.
    const half = await projectsSvc.postUpdate(T1, ownerId, project.id, { health: 'on_track', body_md: 'rule check' });
    const halfSnap = half.update.snapshot as { milestones: Array<Record<string, unknown>> };
    expect(halfSnap.milestones).toEqual([expect.objectContaining({ id: weighted.id, scope: 2, done: 1, pct: 0.5, completed_at: null })]);

    // Finishing the 0-pointer completes it on both surfaces.
    await issuesSvc.moveState(T1, ownerId, zero.id, completedStateId);
    list = (await projectsSvc.list(T1, ownerId)).data;
    expect(list.milestones[project.id]).toEqual({ done: 1, total: 1 });
    const full = await projectsSvc.postUpdate(T1, ownerId, project.id, { health: 'on_track', body_md: 'rule check 2' });
    const fullSnap = full.update.snapshot as { milestones: Array<Record<string, unknown>> };
    expect(fullSnap.milestones).toEqual([expect.objectContaining({ id: weighted.id, scope: 2, done: 2, pct: 1 })]);
    expect(fullSnap.milestones[0]!.completed_at).toEqual(expect.any(String));
  });

  it('the rollup follows the reader’s visibility (guest sees only their project; empty set is {})', async () => {
    const asGuest = (await projectsSvc.list(T1, guestId)).data;
    expect(asGuest.projects.map((p) => p.id)).toEqual([projectG1]);
    expect(Object.keys(asGuest.milestones)).toEqual([projectG1]);
    const asT2 = (await projectsSvc.list(T2, t2OwnerId)).data;
    expect(asT2.projects).toEqual([]);
    expect(asT2.milestones).toEqual({});
  });

  it('rows carry priority (0 by default; whatever is stored otherwise)', async () => {
    const project = await mkProject('Prioritised');
    let row = (await projectsSvc.list(T1, ownerId)).data.projects.find((p) => p.id === project.id)!;
    expect(row.priority).toBe(0);
    await dbAdmin.update(pmProjects).set({ priority: 2 }).where(and(eq(pmProjects.id, project.id), eq(pmProjects.tenant_id, T1)));
    row = (await projectsSvc.list(T1, ownerId)).data.projects.find((p) => p.id === project.id)!;
    expect(row.priority).toBe(2);
    expect((row as { logo_key?: unknown }).logo_key).toBeUndefined(); // still stripped
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Files — the project description's attachments
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M — project files: routes, bind + list, visibility', () => {
  it('GET pm/projects/:id/files and POST pm/projects/:id/files/bind are registered on PmFilesController', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PmFilesController.prototype.listForProject)).toBe('projects/:id/files');
    expect(Reflect.getMetadata(METHOD_METADATA, PmFilesController.prototype.listForProject)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, PmFilesController.prototype.bindProjectFiles)).toBe('projects/:id/files/bind');
    expect(Reflect.getMetadata(METHOD_METADATA, PmFilesController.prototype.bindProjectFiles)).toBe(RequestMethod.POST);
  });

  it('listForProject returns the files bound via bindProjectDrafts (and direct project uploads), signed, oldest first; another user’s draft fails the whole bind', async () => {
    const project = await mkProject('With files');
    expect((await filesSvc.listForProject(T1, ownerId, project.id)).data).toEqual([]);

    const mine = await draft(ownerId);
    const theirs = await draft(memberId);
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, project.id, [mine.id, theirs.id])).rejects.toThrow(BadRequestException);
    let [untouched] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, mine.id));
    expect(untouched!.object_type).toBe('draft'); // the tx rolled back

    const bound = await filesSvc.bindProjectDrafts(T1, ownerId, project.id, [mine.id, mine.id.toUpperCase()]);
    expect(bound.data).toEqual({ project_id: project.id, bound: [mine.id] });
    [untouched] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, mine.id));
    expect(untouched!.object_type).toBe('project');
    expect(untouched!.object_id).toBe(project.id);
    // Empty bind is a quiet no-op; a bound file cannot be re-bound elsewhere.
    expect((await filesSvc.bindProjectDrafts(T1, ownerId, project.id, [])).data.bound).toEqual([]);
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, projectG2, [mine.id])).rejects.toThrow(BadRequestException);

    // A chip attachment goes straight onto the project.
    const direct = (await filesSvc.upload(T1, ownerId, {
      objectType: 'project',
      objectId: project.id,
      kind: 'attachment',
      files: [{ buffer: csv(), originalname: 'brief.csv' }],
    })).data[0]!;
    expect(direct.object_type).toBe('project');

    const list = (await filesSvc.listForProject(T1, ownerId, project.id)).data;
    expect(list.map((f) => f.id)).toEqual([mine.id, direct.id]);
    expect(list[0]).toMatchObject({ object_type: 'project', object_id: project.id, kind: 'attachment', mime_type: 'text/csv', uploaded_by: ownerId });
    expect(list[0]!.url).toMatch(/^https:\/\/signed\.test\//);
    expect(list[0]!.url).toContain('ttl=3600');
    // A member who can see the (public) project reads its files; the issue listing never shows them.
    expect((await filesSvc.listForProject(T1, memberId, project.id)).data.map((f) => f.id)).toEqual([mine.id, direct.id]);
    expect((await filesSvc.resolveForRead(T1, memberId, direct.id)).id).toBe(direct.id);
    // Soft-deleting drops it from the listing and from resolution.
    await filesSvc.softDelete(T1, ownerId, direct.id);
    expect((await filesSvc.listForProject(T1, ownerId, project.id)).data.map((f) => f.id)).toEqual([mine.id]);
    await expect(filesSvc.resolveForRead(T1, ownerId, direct.id)).rejects.toThrow(NotFoundException);
  });

  it('another tenant, a non-member of a private project, a guest outside their project, an unknown id: 404 from bind, list, upload and read — never a probe signal', async () => {
    const priv = await mkProject('Members only');
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(eq(pmProjects.id, priv.id));
    const onPriv = await draft(ownerId);
    await filesSvc.bindProjectDrafts(T1, ownerId, priv.id, [onPriv.id]);

    // Another tenant's owner, with a draft of their own.
    const t2Draft = await draft(t2OwnerId, T2);
    await expect(filesSvc.bindProjectDrafts(T2, t2OwnerId, priv.id, [t2Draft.id])).rejects.toThrow(NotFoundException);
    await expect(filesSvc.bindProjectDrafts(T2, t2OwnerId, projectG2, [t2Draft.id])).rejects.toThrow(NotFoundException);
    await expect(filesSvc.listForProject(T2, t2OwnerId, projectG2)).rejects.toThrow(NotFoundException);
    await expect(
      filesSvc.upload(T2, t2OwnerId, { objectType: 'project', objectId: projectG2, kind: 'attachment', files: [{ buffer: csv(), originalname: 'x.csv' }] }),
    ).rejects.toThrow(NotFoundException);
    const [t2Row] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, t2Draft.id));
    expect(t2Row!.object_type).toBe('draft');
    expect(t2Row!.tenant_id).toBe(T2);

    // An employee who is neither lead nor member of the private project.
    const memberDraft = await draft(memberId);
    await expect(filesSvc.bindProjectDrafts(T1, memberId, priv.id, [memberDraft.id])).rejects.toThrow(NotFoundException);
    await expect(filesSvc.listForProject(T1, memberId, priv.id)).rejects.toThrow(NotFoundException);
    await expect(
      filesSvc.upload(T1, memberId, { objectType: 'project', objectId: priv.id, kind: 'attachment', files: [{ buffer: csv(), originalname: 'x.csv' }] }),
    ).rejects.toThrow(NotFoundException);
    await expect(filesSvc.resolveForRead(T1, memberId, onPriv.id)).rejects.toThrow(NotFoundException);
    // Made a member → the same calls succeed.
    await projectsSvc.addMember(T1, ownerId, 'owner', priv.id, memberId);
    expect((await filesSvc.listForProject(T1, memberId, priv.id)).data.map((f) => f.id)).toEqual([onPriv.id]);
    expect((await filesSvc.resolveForRead(T1, memberId, onPriv.id)).id).toBe(onPriv.id);
    expect((await filesSvc.bindProjectDrafts(T1, memberId, priv.id, [memberDraft.id])).data.bound).toEqual([memberDraft.id]);

    // Guest: their own project reads; another project is 404; writes are 403 (project edits are never for guests).
    expect((await filesSvc.listForProject(T1, guestId, projectG1)).data).toEqual([]);
    await expect(filesSvc.listForProject(T1, guestId, projectG2)).rejects.toThrow(NotFoundException);
    await expect(filesSvc.listForProject(T1, guestId, priv.id)).rejects.toThrow(NotFoundException);
    const guestDraft = await draft(guestId);
    await expect(filesSvc.bindProjectDrafts(T1, guestId, projectG2, [guestDraft.id])).rejects.toThrow(NotFoundException);
    await expect(filesSvc.bindProjectDrafts(T1, guestId, projectG1, [guestDraft.id])).rejects.toThrow(ForbiddenException);
    await expect(
      filesSvc.upload(T1, guestId, { objectType: 'project', objectId: projectG1, kind: 'attachment', files: [{ buffer: csv(), originalname: 'g.csv' }] }),
    ).rejects.toThrow(ForbiddenException);
    const [guestRow] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, guestDraft.id));
    expect(guestRow!.object_type).toBe('draft');

    // Unknown / malformed / deleted project ids.
    await expect(filesSvc.listForProject(T1, ownerId, crypto.randomUUID())).rejects.toThrow(NotFoundException);
    await expect(filesSvc.listForProject(T1, ownerId, 'not-a-uuid')).rejects.toThrow(NotFoundException);
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, crypto.randomUUID(), [onPriv.id])).rejects.toThrow(NotFoundException);
    const doomed = await mkProject('Soon deleted');
    const onDoomed = await draft(ownerId);
    await filesSvc.bindProjectDrafts(T1, ownerId, doomed.id, [onDoomed.id]);
    await projectsSvc.softDelete(T1, ownerId, doomed.id, 'owner');
    await expect(filesSvc.listForProject(T1, ownerId, doomed.id)).rejects.toThrow(NotFoundException);
    await expect(filesSvc.resolveForRead(T1, ownerId, onDoomed.id)).rejects.toThrow(NotFoundException);
    // The bind DTO's ceiling is enforced by the service too.
    await expect(
      filesSvc.bindProjectDrafts(T1, ownerId, projectG2, Array.from({ length: 51 }, () => crypto.randomUUID())),
    ).rejects.toThrow(/At most 50/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Security review (Round M, agent D) — the holes closed, pinned
// ═════════════════════════════════════════════════════════════════════════════

describe('Round M review — explicit predicates, idempotent bind, authority on both doors, typed fields', () => {
  const byId = (id: string) => and(eq(pmIssues.id, id), eq(pmIssues.tenant_id, T1));

  it('rollup: an issue whose project_id points elsewhere, or whose state belongs to another tenant, never counts', async () => {
    const project = await mkProject('Forged rows');
    const elsewhere = await mkProject('Elsewhere');
    const ms = await mkMilestone(project.id, 'Only');
    const i1 = await mkIssue(project.id, ms.id, 'done');
    await issuesSvc.moveState(T1, ownerId, i1.id, completedStateId);
    const roll = async () => (await projectsSvc.list(T1, ownerId)).data.milestones[project.id];
    expect(await roll()).toEqual({ done: 1, total: 1 });

    // (a) FK checks bypass RLS: a row that keeps milestone_id but was moved to
    // another project must not complete a milestone of a project it is not in.
    await dbAdmin.update(pmIssues).set({ project_id: elsewhere.id }).where(byId(i1.id));
    expect(await roll()).toEqual({ done: 0, total: 1 });
    expect((await projectsSvc.list(T1, ownerId)).data.milestones[elsewhere.id]).toEqual({ done: 0, total: 0 });
    await dbAdmin.update(pmIssues).set({ project_id: project.id }).where(byId(i1.id));
    expect(await roll()).toEqual({ done: 1, total: 1 });

    // (b) a "completed" state of ANOTHER tenant — the FK accepts it; the join's
    // explicit tenant predicate reads it as no category, never as done.
    const [t2Done] = await dbAdmin
      .select({ id: pmWorkflowStates.id })
      .from(pmWorkflowStates)
      .where(and(eq(pmWorkflowStates.tenant_id, T2), eq(pmWorkflowStates.category, 'completed')))
      .limit(1);
    await dbAdmin.update(pmIssues).set({ state_id: t2Done!.id }).where(byId(i1.id));
    expect(await roll()).toEqual({ done: 0, total: 1 });
    await dbAdmin.update(pmIssues).set({ state_id: completedStateId }).where(byId(i1.id));
    expect(await roll()).toEqual({ done: 1, total: 1 });
  });

  it('bind is idempotent for the caller’s own files already on the same project — never for another user’s file, another project, or a removed file', async () => {
    const project = await mkProject('Idempotent bind');
    const a = await draft(ownerId);
    expect((await filesSvc.bindProjectDrafts(T1, ownerId, project.id, [a.id])).data.bound).toEqual([a.id]);
    // The same call again (a retry after a lost response) → the same answer, not "re-attach".
    expect((await filesSvc.bindProjectDrafts(T1, ownerId, project.id, [a.id])).data.bound).toEqual([a.id]);
    // Mixed: an already-bound id + a fresh draft → both, in request order.
    const b = await draft(ownerId);
    expect((await filesSvc.bindProjectDrafts(T1, ownerId, project.id, [b.id, a.id])).data.bound).toEqual([b.id, a.id]);
    for (const r of await dbAdmin.select().from(recordFiles).where(inArray(recordFiles.id, [a.id, b.id]))) {
      expect(r).toMatchObject({ object_type: 'project', object_id: project.id, tenant_id: T1, uploaded_by: ownerId });
    }
    // Another user's file already on THIS project → still a 400 for me: the echo only ever names my own files.
    const theirs = await draft(memberId);
    expect((await filesSvc.bindProjectDrafts(T1, memberId, project.id, [theirs.id])).data.bound).toEqual([theirs.id]);
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, project.id, [theirs.id])).rejects.toThrow(BadRequestException);
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, project.id, [a.id, theirs.id])).rejects.toThrow(BadRequestException);
    // My file, but bound to ANOTHER project → 400 (bind never moves a file between objects).
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, projectG2, [a.id])).rejects.toThrow(BadRequestException);
    // Removed → 400.
    await filesSvc.softDelete(T1, ownerId, b.id);
    await expect(filesSvc.bindProjectDrafts(T1, ownerId, project.id, [b.id])).rejects.toThrow(BadRequestException);
    // Nothing moved on the refused calls.
    const [aRow] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, a.id));
    expect(aRow).toMatchObject({ object_type: 'project', object_id: project.id, uploaded_by: ownerId });
    const [tRow] = await dbAdmin.select().from(recordFiles).where(eq(recordFiles.id, theirs.id));
    expect(tRow).toMatchObject({ object_type: 'project', object_id: project.id, uploaded_by: memberId });
    // The listing shows the two live files, and the binds are audited against the project.
    expect((await filesSvc.listForProject(T1, ownerId, project.id)).data.map((f) => f.id).sort()).toEqual([a.id, theirs.id].sort());
    const audits = await dbAdmin
      .select({ actor: auditLog.actor_user_id, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, T1), eq(auditLog.action, 'pm.file.bound'), eq(auditLog.resource_id, project.id)));
    const idsOf = (m: unknown) => ((m as { ids?: string[] } | null)?.ids ?? []);
    expect(audits.some((x) => x.actor === ownerId && idsOf(x.metadata).includes(a.id))).toBe(true);
    expect(audits.some((x) => x.actor === memberId && idsOf(x.metadata).includes(theirs.id))).toBe(true);
  });

  it('milestone writes carry the PROJECT’s authority on both doors: private-project non-member 403, another tenant 404/403, guest 403 — nothing written', async () => {
    const priv = await mkProject('Private milestones');
    await dbAdmin.update(pmProjects).set({ is_private: true }).where(and(eq(pmProjects.id, priv.id), eq(pmProjects.tenant_id, T1)));
    const ms = await mkMilestone(priv.id, 'Hidden');

    await expect(projectsSvc.createMilestone(T1, memberId, { project_id: priv.id, name: 'Nope' })).rejects.toThrow(ForbiddenException);
    await expect(projectsSvc.updateMilestone(T1, memberId, ms.id, { name: 'Renamed' })).rejects.toThrow(ForbiddenException);
    await expect(projectsSvc.updateMilestone(T1, memberId, ms.id, { description_md: 'peek' })).rejects.toThrow(ForbiddenException);
    await expect(projectsSvc.createMilestone(T1, guestId, { project_id: projectG1, name: 'Guest' })).rejects.toThrow(ForbiddenException);
    await expect(projectsSvc.updateMilestone(T2, t2OwnerId, ms.id, { name: 'Zed' })).rejects.toThrow(NotFoundException);
    await expect(projectsSvc.createMilestone(T2, t2OwnerId, { project_id: priv.id, name: 'Zed' })).rejects.toThrow(ForbiddenException);
    await expect(projectsSvc.updateMilestone(T1, ownerId, 'not-a-uuid', { name: 'x' })).rejects.toThrow(NotFoundException);

    // The sync door reaches the same service — same answers, same ledger codes.
    const res = await executor.execute(T1, memberId, [
      { clientMutationId: crypto.randomUUID(), op: 'milestone.update' as const, id: ms.id, fields: { name: 'Via sync' } },
      { clientMutationId: crypto.randomUUID(), op: 'milestone.create' as const, id: crypto.randomUUID(), fields: { project_id: priv.id, name: 'Via sync' } },
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    for (const r of res.results) expect(r.errorCode).toMatch(/^E403:/);

    const rows = await dbAdmin
      .select()
      .from(pmProjectMilestones)
      .where(and(eq(pmProjectMilestones.tenant_id, T1), eq(pmProjectMilestones.project_id, priv.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ms.id, name: 'Hidden', description_md: null });
    expect(await dbAdmin.select().from(pmProjectMilestones).where(eq(pmProjectMilestones.tenant_id, T2))).toHaveLength(0);
    // A member of the project may, on either door.
    await projectsSvc.addMember(T1, ownerId, 'owner', priv.id, memberId);
    expect((await projectsSvc.updateMilestone(T1, memberId, ms.id, { description_md: 'now allowed' })).data.description_md).toBe('now allowed');
  });

  it('typed fields on both doors: a non-string description, a malformed date, a non-integer or out-of-range position are 400s in our words — never Postgres’s', async () => {
    const project = await mkProject('Typed fields');
    const ms = await mkMilestone(project.id, 'Typed', { target_date: '2026-10-01', position: 1 });
    const bad: Array<Record<string, unknown>> = [
      { description_md: 123 },
      { description_md: { md: 'x' } },
      { target_date: 'tomorrow' },
      { target_date: '2026-02-30' },
      { target_date: '2026-13-01' },
      { target_date: 20261001 },
      { target_date: '2026-10-01T00:00:00Z' },
      { position: 'abc' },
      { position: 1.5 },
      { position: 99_999 },
      { name: 5 },
    ];
    const upd = await executor.execute(
      T1,
      ownerId,
      bad.map((fields) => ({ clientMutationId: crypto.randomUUID(), op: 'milestone.update' as const, id: ms.id, fields })),
    );
    expect(upd.results).toHaveLength(bad.length);
    for (const r of upd.results) {
      expect(r.status).toBe('rejected');
      expect(r.errorCode).toMatch(/^E400:/);
      expect(r.errorCode).not.toMatch(/syntax|smallint|out of range for type|date\/time|invalid input/i);
    }
    const cre = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'milestone.create' as const, id: crypto.randomUUID(), fields: { project_id: project.id, name: 'Bad date', target_date: '2026-02-30' } },
      { clientMutationId: crypto.randomUUID(), op: 'milestone.create' as const, id: crypto.randomUUID(), fields: { project_id: project.id, name: 'Bad pos', position: 'first' } },
      { clientMutationId: crypto.randomUUID(), op: 'milestone.create' as const, id: crypto.randomUUID(), fields: { project_id: project.id, name: ['x'] } },
      { clientMutationId: crypto.randomUUID(), op: 'milestone.create' as const, id: crypto.randomUUID(), fields: { project_id: project.id, name: 'Bad body', description_md: ['x'] } },
    ]);
    for (const r of cre.results) {
      expect(r.status).toBe('rejected');
      expect(r.errorCode).toMatch(/^E400:/);
    }
    // Nothing written by any of them.
    const [row] = await dbAdmin.select().from(pmProjectMilestones).where(eq(pmProjectMilestones.id, ms.id));
    expect(row).toMatchObject({ name: 'Typed', target_date: '2026-10-01', position: 1, description_md: null });
    expect(
      await dbAdmin.select().from(pmProjectMilestones).where(and(eq(pmProjectMilestones.tenant_id, T1), eq(pmProjectMilestones.project_id, project.id))),
    ).toHaveLength(1);
    // The REST-shaped calls answer the same way.
    await expect(projectsSvc.updateMilestone(T1, ownerId, ms.id, { target_date: '2026-02-30' })).rejects.toThrow(/calendar date/);
    await expect(projectsSvc.createMilestone(T1, ownerId, { project_id: project.id, name: 'x', position: 40_000 })).rejects.toThrow(/whole number/);
    // Good values still flow: a leap day, position 0, null clears the date.
    const ok = await executor.execute(T1, ownerId, [
      { clientMutationId: crypto.randomUUID(), op: 'milestone.update' as const, id: ms.id, fields: { target_date: '2028-02-29', position: 0 } },
      { clientMutationId: crypto.randomUUID(), op: 'milestone.update' as const, id: ms.id, fields: { target_date: null } },
    ]);
    expect(ok.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    const [after] = await dbAdmin.select().from(pmProjectMilestones).where(eq(pmProjectMilestones.id, ms.id));
    expect(after).toMatchObject({ target_date: null, position: 0 });
  });

  it('DTO hygiene (the global ValidationPipe): bind ids are v4 uuids (≤ 50, no extra fields), an upload needs a uuid object_id, both milestone DTOs cap description_md at 20 000', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } });
    const body = (metatype: unknown) => ({ type: 'body' as const, metatype: metatype as never });
    const u = () => crypto.randomUUID();
    const rejects = (value: unknown, dto: unknown) => expect(pipe.transform(value, body(dto))).rejects.toThrow(BadRequestException);

    // POST pm/projects/:id/files/bind
    expect(await pipe.transform({ draft_ids: [u()] }, body(BindProjectFilesDto))).toBeInstanceOf(BindProjectFilesDto);
    expect(await pipe.transform({ draft_ids: [] }, body(BindProjectFilesDto))).toBeDefined(); // documented no-op
    await rejects({ draft_ids: ['not-a-uuid'] }, BindProjectFilesDto);
    await rejects({ draft_ids: 'not-an-array' }, BindProjectFilesDto);
    await rejects({ draft_ids: Array.from({ length: 51 }, u) }, BindProjectFilesDto);
    await rejects({ draft_ids: [u()], project_id: u() }, BindProjectFilesDto);
    await rejects({}, BindProjectFilesDto);
    // POST pm/uploads with object_type=project
    expect(await pipe.transform({ object_type: 'project', object_id: u() }, body(UploadFilesDto))).toMatchObject({ object_type: 'project' });
    await rejects({ object_type: 'project' }, UploadFilesDto);
    await rejects({ object_type: 'project', object_id: 'nope' }, UploadFilesDto);
    await rejects({ object_type: 'milestone', object_id: u() }, UploadFilesDto);
    // POST pm/milestones · PATCH pm/milestones/:id
    expect(await pipe.transform({ project_id: u(), name: 'x', description_md: 'y'.repeat(20_000) }, body(CreateMilestoneDto))).toBeDefined();
    await rejects({ project_id: u(), name: 'x', description_md: 'y'.repeat(20_001) }, CreateMilestoneDto);
    await rejects({ name: 'x' }, CreateMilestoneDto); // project_id required
    await rejects({ project_id: u(), name: 'x', target_date: 20261001 }, CreateMilestoneDto);
    await rejects({ description_md: 'y'.repeat(20_001) }, UpdateMilestoneDto);
    expect(await pipe.transform({ description_md: null, target_date: null }, body(UpdateMilestoneDto))).toBeDefined();
    await rejects({ target_date: '2026-10-01T00:00:00.000Z' }, UpdateMilestoneDto);
    await rejects({ target_date: 20261001 }, UpdateMilestoneDto);
    await rejects({ name: 'x', tenant_id: u() }, UpdateMilestoneDto);
  });
});
