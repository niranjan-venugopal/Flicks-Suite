/**
 * Founder round 20 — "There should be an option to delete a project."
 *
 * The delete existed server-side and was wired to nothing in the UI. Exposing
 * it as-is would have shipped a button that leaves a mess, so this round fixes
 * what the audit found underneath it. The founder's calls, verbatim:
 *   "Delete them with it." (the issues)
 *   "the guest also loses the project data"
 *   "Issues dont survive without a project."
 *
 * So: deleting a project cascades to its issues; restore gives back exactly
 * that set and nothing more; a guest's scope drops the project the moment it
 * is deleted; and a purge takes the issues rather than letting the FK detach
 * them into project-less orphans.
 *
 * Plus the authority gap the audit surfaced: delete was guarded only by a
 * VISIBILITY check, so any non-guest member could destroy any project they
 * could see, while deleting a mere team already required owner/admin. The bar
 * now lives in the service, because the FSE sync executor is a second door
 * that carries no @Roles at all.
 *
 * Service-level against the real Postgres, mirroring pm-import.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmIssues,
  pmProjects,
  pmProjectMembers,
  domainEvents,
} from '@flicks/db/schema';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const config = new ConfigService();
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, config, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility);

let tenantId: string;
let ownerId: string;
let managerId: string;
let employeeId: string;
let guestId: string;
let teamId: string;
const trackedUsers: string[] = [];

/** A project with `count` issues in it, led by `leadUserId`. */
async function seedProject(name: string, count: number, leadUserId = ownerId) {
  const project = (
    await projectsSvc.create(tenantId, ownerId, {
      name: `${name} ${rid()}`,
      lead_user_id: leadUserId,
      team_ids: [teamId],
    })
  ).data;
  const issues = [];
  for (let i = 0; i < count; i++) {
    issues.push(
      (
        await issuesSvc.create(tenantId, ownerId, {
          team_id: teamId,
          title: `${name} issue ${i + 1}`,
          project_id: project.id,
        })
      ).data,
    );
  }
  return { project, issues };
}

const liveIssues = async (projectId: string) =>
  dbAdmin
    .select({ id: pmIssues.id })
    .from(pmIssues)
    .where(and(eq(pmIssues.project_id, projectId), isNull(pmIssues.deleted_at)));

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R20 Studio ${rid()}`, slug: `r20-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;

  const mk = async (role: UserRole, label: string) => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `r20-${label}-${rid()}@t.test`, full_name: `R20 ${label}`, status: 'active' })
      .returning();
    await dbAdmin
      .insert(memberships)
      .values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
    trackedUsers.push(u!.id);
    return u!.id;
  };
  ownerId = await mk('owner', 'owner');
  managerId = await mk('manager', 'manager');
  employeeId = await mk('employee', 'employee');
  guestId = await mk('guest', 'guest');

  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;
});

afterAll(async () => {
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
});

describe('Founder round 20 — deleting a project takes its issues with it', () => {
  it('soft-deleting a project deletes every live issue inside it', async () => {
    const { project, issues } = await seedProject('Cascade', 3);
    expect(await liveIssues(project.id)).toHaveLength(3);

    const res = await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    expect(res.data.cascaded_issues).toBe(3);
    expect(await liveIssues(project.id)).toHaveLength(0);

    // The rows survive — this is a soft delete, restorable for 30 days.
    const rows = await dbAdmin
      .select({ id: pmIssues.id, marker: pmIssues.deleted_with_project_id })
      .from(pmIssues)
      .where(eq(pmIssues.project_id, project.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.marker === project.id)).toBe(true);
    expect(issues.every((i) => rows.some((r) => r.id === i.id))).toBe(true);
  });

  it('a deleted project drops out of the project list, and its issues out of the issue list', async () => {
    const { project } = await seedProject('Vanish', 2);
    const before = await issuesSvc.list(tenantId, ownerId, {} as never);
    expect(before.data.some((i) => i.project_id === project.id)).toBe(true);

    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');

    const projects = await projectsSvc.list(tenantId, ownerId);
    expect(projects.data.projects.some((p) => p.id === project.id)).toBe(false);
    const after = await issuesSvc.list(tenantId, ownerId, {} as never);
    expect(after.data.some((i) => i.project_id === project.id)).toBe(false);
  });

  it('restore gives back the project and exactly the issues its delete took', async () => {
    const { project, issues } = await seedProject('Undo', 3);
    // One issue is deleted BY HAND first — it must stay deleted afterwards.
    await issuesSvc.softDelete(tenantId, ownerId, issues[0]!.id);

    const del = await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    expect(del.data.cascaded_issues).toBe(2); // not 3 — the hand-deleted one was already gone

    await projectsSvc.restore(tenantId, ownerId, project.id, 'owner');
    const live = await liveIssues(project.id);
    expect(live).toHaveLength(2);
    expect(live.some((r) => r.id === issues[0]!.id)).toBe(false);

    // The marker is cleared, so a second delete/restore cycle starts clean.
    const markers = await dbAdmin
      .select({ marker: pmIssues.deleted_with_project_id })
      .from(pmIssues)
      .where(and(eq(pmIssues.project_id, project.id), isNull(pmIssues.deleted_at)));
    expect(markers.every((m) => m.marker === null)).toBe(true);
  });

  it('the project is listed in recently-deleted and comes back from there', async () => {
    const { project } = await seedProject('Bin', 1);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    const listed = await teamsSvc.recentlyDeleted(tenantId, ownerId);
    expect(listed.data.projects.some((p) => p.id === project.id)).toBe(true);

    await projectsSvc.restore(tenantId, ownerId, project.id, 'owner');
    const after = await teamsSvc.recentlyDeleted(tenantId, ownerId);
    expect(after.data.projects.some((p) => p.id === project.id)).toBe(false);
  });

  it('cascaded issues are NOT separately listed in recently-deleted', async () => {
    // Caught by the live run: the project's issues appeared as their own
    // restorable rows, burying the project's row and offering a Restore that
    // would have resurrected an issue into a deleted project.
    const { project, issues } = await seedProject('NoClutter', 3);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    const listed = await teamsSvc.recentlyDeleted(tenantId, ownerId);
    for (const i of issues) {
      expect(listed.data.issues.some((row) => row.id === i.id)).toBe(false);
    }
    expect(listed.data.projects.some((p) => p.id === project.id)).toBe(true);
  });

  it('a cascaded issue cannot be restored on its own', async () => {
    const { project, issues } = await seedProject('NoOrphan', 2);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    await expect(issuesSvc.restore(tenantId, ownerId, issues[0]!.id)).rejects.toThrow(
      /deleted along with its project/i,
    );
    // A hand-deleted issue in a LIVE project is still restorable on its own.
    const solo = await seedProject('SoloOk', 1);
    await issuesSvc.softDelete(tenantId, ownerId, solo.issues[0]!.id);
    await expect(issuesSvc.restore(tenantId, ownerId, solo.issues[0]!.id)).resolves.toBeDefined();
  });

  it('purging a project destroys its issues rather than orphaning them', async () => {
    // pm_issues.project_id is ON DELETE SET NULL, so without the explicit
    // delete the issues would survive the purge as project-less rows —
    // "issues don't survive without a project".
    const { project, issues } = await seedProject('Purge', 2);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    const res = await teamsSvc.purgeDeleted(tenantId, ownerId, 'project', project.id);
    expect((res.data as { purged_issues?: number }).purged_issues).toBe(2);

    const gone = await dbAdmin.select().from(pmProjects).where(eq(pmProjects.id, project.id));
    expect(gone).toHaveLength(0);
    for (const i of issues) {
      const row = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, i.id));
      expect(row).toHaveLength(0);
    }
  });
});

describe('Founder round 20 — a guest loses a deleted project', () => {
  it('the project leaves the guest scope on delete and returns on restore', async () => {
    const { project } = await seedProject('GuestSeen', 2);
    await dbAdmin
      .insert(pmProjectMembers)
      .values({ tenant_id: tenantId, project_id: project.id, user_id: guestId });

    const before = await dbSvc.withTenant(
      tenantId,
      (tx) => visibility.guestScopeTx(tx, tenantId, guestId),
      guestId,
    );
    expect(before?.guest).toBe(true);
    expect(before?.projectIds).toContain(project.id);

    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    const during = await dbSvc.withTenant(
      tenantId,
      (tx) => visibility.guestScopeTx(tx, tenantId, guestId),
      guestId,
    );
    expect(during?.projectIds).not.toContain(project.id);
    // and with the project out of scope, its issues are out of scope too
    expect(during?.teamIds ?? []).not.toContain(teamId);

    await projectsSvc.restore(tenantId, ownerId, project.id, 'owner');
    const after = await dbSvc.withTenant(
      tenantId,
      (tx) => visibility.guestScopeTx(tx, tenantId, guestId),
      guestId,
    );
    expect(after?.projectIds).toContain(project.id);
  });
});

describe('Founder round 20 — who may delete a project', () => {
  it('an employee who merely SEES a project cannot delete it', async () => {
    const { project } = await seedProject('NotYours', 1);
    await expect(
      projectsSvc.softDelete(tenantId, employeeId, project.id, 'employee'),
    ).rejects.toThrow(/project lead, or a manager and above/i);
    // ...and nothing was taken on the way out
    expect(await liveIssues(project.id)).toHaveLength(1);
  });

  it('an employee who LEADS the project can delete it', async () => {
    const { project } = await seedProject('MyProject', 1, employeeId);
    const res = await projectsSvc.softDelete(tenantId, employeeId, project.id, 'employee');
    expect(res.data.deleted).toBe(true);
    expect(res.data.cascaded_issues).toBe(1);
  });

  it('a manager can delete a project they do not lead', async () => {
    const { project } = await seedProject('MgrCan', 1);
    const res = await projectsSvc.softDelete(tenantId, managerId, project.id, 'manager');
    expect(res.data.deleted).toBe(true);
  });

  it('a guest cannot delete a project, even one they are a member of', async () => {
    const { project } = await seedProject('GuestNo', 1);
    await dbAdmin
      .insert(pmProjectMembers)
      .values({ tenant_id: tenantId, project_id: project.id, user_id: guestId });
    await expect(
      projectsSvc.softDelete(tenantId, guestId, project.id, 'guest'),
    ).rejects.toThrow();
  });

  it('restore is held to the same bar as delete', async () => {
    const { project } = await seedProject('RestoreBar', 1);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    await expect(
      projectsSvc.restore(tenantId, employeeId, project.id, 'employee'),
    ).rejects.toThrow(/project lead, or a manager and above/i);
  });
});

describe('Founder round 20 — the sync refs live clients depend on', () => {
  it('the delete event names every issue it took, so the delta can tombstone them', async () => {
    const { project, issues } = await seedProject('Refs', 2);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');

    const events = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'pm.project.updated')));
    const mine = events.find(
      (e) => (e.payload as { project_id?: string; deleted?: boolean }).project_id === project.id
        && (e.payload as { deleted?: boolean }).deleted === true,
    );
    expect(mine).toBeDefined();
    const refs = (mine!.payload as { sync: Array<{ t: string; id: string }> }).sync;
    expect(refs).toContainEqual({ t: 'pm_projects', id: project.id });
    for (const i of issues) expect(refs).toContainEqual({ t: 'pm_issues', id: i.id });
  });

  it('the restore event names the project scoped rows a tombstone had purged', async () => {
    const { project } = await seedProject('RestoreRefs', 1);
    await projectsSvc.softDelete(tenantId, ownerId, project.id, 'owner');
    await projectsSvc.restore(tenantId, ownerId, project.id, 'owner');

    const events = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'pm.project.updated')));
    const mine = events.find(
      (e) => (e.payload as { project_id?: string; restored?: boolean }).project_id === project.id
        && (e.payload as { restored?: boolean }).restored === true,
    );
    expect(mine).toBeDefined();
    const refs = (mine!.payload as { sync: Array<{ t: string; id: string }> }).sync;
    // Without these the project came back with no milestones and no team chips
    // until a full reload: the client's pm_projects tombstone had purged them.
    expect(refs).toContainEqual({ t: 'pm_project_teams', id: project.id });
    expect(refs).toContainEqual({ t: 'pm_project_members', id: project.id });
  });
});
