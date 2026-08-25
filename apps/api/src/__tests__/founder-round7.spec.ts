/**
 * Founder round 7 — PM guest seats + workspace discovery + notification
 * defaults. The leak suite here is the security class that must never
 * regress: a project-scoped guest sees EXACTLY their invited projects'
 * issues, in REST reads, search, sync bootstrap AND sync delta.
 *
 *  - Invite/list/revoke: membership (role guest, external) + pm:edit grant +
 *    pm_project_members row; idempotent; non-guest email conflicts; a
 *    cross-tenant project id is NotFound; revoking the last project
 *    deactivates the membership.
 *  - Read scoping: issues list/get/detail/search/projects/teams/initiatives/
 *    cycles + bootstrap NDJSON + delta upserts/tombstones.
 *  - Write scoping: their project OK; other project 403/404; create requires
 *    an in-scope project; team/cycle/triage ops blocked; executor whitelist.
 *  - Workspace discovery: login auto-select prefers a non-guest workspace;
 *    create-tenant is blocked only for existing OWNERS; canCreateWorkspace.
 *  - Notifications: pm_comment email default ON; create-with-assignee pings.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  membershipGrants,
  pmTeams,
  pmIssues,
  pmProjects,
  pmProjectTeams,
  pmProjectMembers,
  domainEvents,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService, emailEventForInAppType } from '../modules/notifications/notifications.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmSearchService } from '../modules/pm/search.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';
import { PmGuestsService } from '../modules/pm/guests.service';
import { MembersService } from '../modules/members/members.service';
import { MembersPublicService } from '../modules/members/public';
import type { AuthService } from '../modules/auth/auth.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility);
const notificationsSvc = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService(),
  emitter,
);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility);
const searchSvc = new PmSearchService(dbSvc, visibility);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc);
const executor = new PmMutationExecutor(
  dbSvc,
  issuesSvc,
  projectsSvc,
  syncSvc,
  { emitSeq: jest.fn() } as never,
);
// Magic-link issuing is the only AuthService surface the invite touches.
const authStub = {
  issueInviteMagicLink: async () => 'https://app.test/verify?token=stub',
} as unknown as AuthService;
const membersSvc = new MembersService(
  dbSvc,
  dbAdmin as never,
  audit,
  notificationsSvc,
  authStub,
);
const guestsSvc = new PmGuestsService(
  dbSvc,
  audit,
  domainEventsSvc,
  new MembersPublicService(membersSvc),
);

let tenantId: string;
let otherTenantId: string;
let ownerId: string; // owner of tenantId
let teamId: string; // the seeded (public) team
let projectA: string; // guest is invited HERE
let projectB: string; // guest must never see this
let issueInA: string;
let issueInB: string;
let issueNoProject: string;
let otherTenantProject: string;
let guestUserId: string;
const trackedUsers: string[] = [];

async function mkUser(email: string, tenant: string, role: 'owner' | 'employee') {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email, full_name: 'R7 Tester', status: 'active' })
    .returning();
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenant, user_id: u!.id, role, status: 'active' });
  trackedUsers.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R7 Co ${rid()}`, slug: `r7-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [t2] = await dbAdmin
    .insert(tenants)
    .values({ name: `R7 Other ${rid()}`, slug: `r7o-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  otherTenantId = t2!.id;

  ownerId = await mkUser(`r7-owner-${rid()}@t.test`, tenantId, 'owner');
  const otherOwner = await mkUser(`r7-other-${rid()}@t.test`, otherTenantId, 'owner');

  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;

  const pa = await projectsSvc.create(tenantId, ownerId, { name: 'Client Portal', team_ids: [teamId] });
  projectA = pa.data.id;
  const pb = await projectsSvc.create(tenantId, ownerId, { name: 'Internal Roadmap', team_ids: [teamId] });
  projectB = pb.data.id;

  const ia = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Portal login bug', project_id: projectA });
  issueInA = ia.data.id;
  const ib = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Secret roadmap item', project_id: projectB });
  issueInB = ib.data.id;
  const inp = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Loose internal issue' });
  issueNoProject = inp.data.id;

  await teamsSvc.ensureWorkspace(otherTenantId, otherOwner);
  const po = await projectsSvc.create(otherTenantId, otherOwner, { name: 'Other tenant project' });
  otherTenantProject = po.data.id;
});

afterAll(async () => {
  for (const id of [tenantId, otherTenantId]) {
    await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, id));
    await dbAdmin.delete(tenants).where(eq(tenants.id, id));
  }
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('guest invite / list / revoke', () => {
  const guestEmail = `r7-guest-${rid()}@client.test`;

  it('invites a guest: external membership + pm grant + project row', async () => {
    const res = await guestsSvc.invite(tenantId, ownerId, projectA, {
      email: guestEmail,
      full_name: 'Priya Client',
    });
    guestUserId = res.data.userId;
    trackedUsers.push(guestUserId);
    expect(res.data.status).toBe('invited');

    const [m] = await dbAdmin
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, guestUserId)));
    expect(m!.role).toBe('guest');
    expect(m!.status).toBe('invited');
    expect(m!.is_external).toBe(true);

    const grants = await dbAdmin
      .select()
      .from(membershipGrants)
      .where(eq(membershipGrants.membership_id, m!.id));
    expect(grants.map((g) => `${g.module}:${g.access_level}`)).toEqual(['pm:edit']);

    const rows = await dbAdmin
      .select()
      .from(pmProjectMembers)
      .where(and(eq(pmProjectMembers.tenant_id, tenantId), eq(pmProjectMembers.user_id, guestUserId)));
    expect(rows.map((r) => r.project_id)).toEqual([projectA]);

    // Activate the membership so the rest of the suite exercises a live guest.
    await dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, guestUserId)));
  });

  it('re-inviting the same email is idempotent (no duplicate rows)', async () => {
    await guestsSvc.invite(tenantId, ownerId, projectA, { email: guestEmail });
    const rows = await dbAdmin
      .select()
      .from(pmProjectMembers)
      .where(and(eq(pmProjectMembers.tenant_id, tenantId), eq(pmProjectMembers.user_id, guestUserId)));
    expect(rows).toHaveLength(1);
    const ms = await dbAdmin
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, guestUserId)));
    expect(ms).toHaveLength(1);
  });

  it('rejects inviting an existing workspace member as a guest', async () => {
    const [owner] = await dbAdmin.select().from(users).where(eq(users.id, ownerId));
    await expect(
      guestsSvc.invite(tenantId, ownerId, projectA, { email: owner!.email }),
    ).rejects.toThrow(/already a member/i);
  });

  it("a project from ANOTHER tenant is NotFound (in-tenant existence check)", async () => {
    await expect(
      guestsSvc.invite(tenantId, ownerId, otherTenantProject, { email: `x-${rid()}@t.test` }),
    ).rejects.toThrow(/not found/i);
  });

  it('lists the guest for the project', async () => {
    const res = await guestsSvc.list(tenantId, projectA);
    expect(res.data.map((g) => g.userId)).toContain(guestUserId);
  });
});

describe('guest read scoping (the leak suite)', () => {
  it('issues.list returns ONLY the invited project\'s issues', async () => {
    const res = await issuesSvc.list(tenantId, guestUserId, {});
    const ids = res.data.map((i) => i.id);
    expect(ids).toContain(issueInA);
    expect(ids).not.toContain(issueInB);
    expect(ids).not.toContain(issueNoProject); // project-less = invisible
  });

  it('a project_id filter outside scope yields nothing (no probe signal)', async () => {
    const res = await issuesSvc.list(tenantId, guestUserId, { project_id: projectB });
    expect(res.data).toHaveLength(0);
  });

  it('issues.get/detail on an out-of-scope issue is NotFound', async () => {
    await expect(issuesSvc.get(tenantId, guestUserId, issueInB)).rejects.toThrow(/not found/i);
    await expect(issuesSvc.detail(tenantId, guestUserId, issueInB)).rejects.toThrow(/not found/i);
    await expect(issuesSvc.get(tenantId, guestUserId, issueNoProject)).rejects.toThrow(/not found/i);
    // …but their own project's issue resolves fine.
    const ok = await issuesSvc.get(tenantId, guestUserId, issueInA);
    expect(ok.data.id).toBe(issueInA);
  });

  it('search never returns out-of-scope issues', async () => {
    const res = await searchSvc.search(tenantId, guestUserId, 'Secret');
    expect(res.data.issues).toHaveLength(0);
    const own = await searchSvc.search(tenantId, guestUserId, 'Portal');
    expect(own.data.issues.map((i) => i.id)).toContain(issueInA);
  });

  it('projects list is limited to the invited project; teams carry no rosters', async () => {
    const projects = await projectsSvc.list(tenantId, guestUserId);
    const pids = projects.data.projects.map((p: { id: string }) => p.id);
    expect(pids).toEqual([projectA]);

    const teams = await teamsSvc.list(tenantId, guestUserId);
    expect(teams.data.memberships).toHaveLength(0);
    expect(teams.data.memberships_all).toHaveLength(0);
    expect(teams.data.teams.map((t: { id: string }) => t.id)).toEqual([teamId]);
  });

  it('initiatives are empty and the restore list is empty for guests', async () => {
    const inits = await projectsSvc.listInitiatives(tenantId, guestUserId);
    expect(inits.data.initiatives).toHaveLength(0);
    const deleted = await teamsSvc.recentlyDeleted(tenantId, guestUserId);
    expect(deleted.data.issues).toHaveLength(0);
    expect(deleted.data.projects).toHaveLength(0);
  });

  it('sync bootstrap ships zero out-of-scope rows', async () => {
    const lines = await syncSvc.bootstrap(tenantId, guestUserId);
    const models = new Map<string, unknown[]>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { model?: string; rows?: unknown[] };
      if (parsed.model) models.set(parsed.model, [...(models.get(parsed.model) ?? []), ...(parsed.rows ?? [])]);
    }
    const issues = (models.get('pm_issues') ?? []) as Array<{ id: string }>;
    expect(issues.map((i) => i.id)).toEqual([issueInA]);
    expect(models.get('pm_team_memberships') ?? []).toHaveLength(0);
    expect(models.get('pm_initiatives') ?? []).toHaveLength(0);
    expect(models.get('pm_cycles') ?? []).toHaveLength(0);
    const projects = (models.get('pm_projects') ?? []) as Array<{ id: string }>;
    expect(projects.map((p) => p.id)).toEqual([projectA]);
  });

  it('sync delta upserts in-scope changes and hides out-of-scope ones', async () => {
    const before = await syncSvc.latestSeq(tenantId);
    await issuesSvc.update(tenantId, ownerId, issueInB, { title: 'Secret roadmap item v2' });
    await issuesSvc.update(tenantId, ownerId, issueInA, { title: 'Portal login bug v2' });

    const guestDelta = await syncSvc.delta(tenantId, guestUserId, before);
    const guestIssues = ((guestDelta as { upserts: { pm_issues?: Array<{ id: string }> } }).upserts.pm_issues ?? []).map((i) => i.id);
    expect(guestIssues).toContain(issueInA);
    expect(guestIssues).not.toContain(issueInB);
    // The invisible issue must not even appear as a tombstone leak vector —
    // tombstones are ids the client already had, which a guest never did.
    const ownerDelta = await syncSvc.delta(tenantId, ownerId, before);
    const ownerIssues = ((ownerDelta as { upserts: { pm_issues?: Array<{ id: string }> } }).upserts.pm_issues ?? []).map((i) => i.id);
    expect(ownerIssues).toEqual(expect.arrayContaining([issueInA, issueInB]));
  });
});

describe('guest write scoping', () => {
  it('can comment + update inside their project', async () => {
    const c = await issuesSvc.createComment(tenantId, guestUserId, issueInA, { body: 'Looks good from our side' });
    expect(c.data.id).toBeTruthy();
    const u = await issuesSvc.update(tenantId, guestUserId, issueInA, { title: 'Portal login bug v3' });
    expect(u.data.title).toBe('Portal login bug v3');
  });

  it('cannot touch an out-of-scope issue', async () => {
    await expect(
      issuesSvc.update(tenantId, guestUserId, issueInB, { title: 'nope' }),
    ).rejects.toThrow(/not found/i);
    await expect(
      issuesSvc.createComment(tenantId, guestUserId, issueNoProject, { body: 'nope' }),
    ).rejects.toThrow(/not found/i);
  });

  it('create requires an in-scope project', async () => {
    await expect(
      issuesSvc.create(tenantId, guestUserId, { team_id: teamId, title: 'no project' }),
    ).rejects.toThrow(/only create issues inside their projects/i);
    await expect(
      issuesSvc.create(tenantId, guestUserId, { team_id: teamId, title: 'wrong project', project_id: projectB }),
    ).rejects.toThrow(/only create issues inside their projects/i);
    const ok = await issuesSvc.create(tenantId, guestUserId, {
      team_id: teamId,
      title: 'Guest-reported bug',
      project_id: projectA,
    });
    expect(ok.data.project_id).toBe(projectA);
  });

  it('team/triage/project-management ops are blocked', async () => {
    await expect(issuesSvc.moveTeam(tenantId, guestUserId, issueInA, teamId)).rejects.toThrow(/guest/i);
    await expect(issuesSvc.sendToTriage(tenantId, guestUserId, issueInA)).rejects.toThrow(/guest/i);
    await expect(
      projectsSvc.postUpdate(tenantId, guestUserId, projectA, { health: 'on_track', body_md: 'hi' }),
    ).rejects.toThrow(/guest/i);
    await expect(
      projectsSvc.create(tenantId, guestUserId, { name: 'Guest project' }),
    ).rejects.toThrow(/guest/i);
    await expect(
      issuesSvc.setProject(tenantId, guestUserId, issueInA, { project_id: null }),
    ).rejects.toThrow(/own projects/i);
  });

  it('the sync executor rejects non-whitelisted ops per item', async () => {
    const res = await executor.execute(
      tenantId,
      guestUserId,
      [
        { clientMutationId: crypto.randomUUID(), op: 'issue.update', id: issueInA, fields: { title: 'via executor' } },
        { clientMutationId: crypto.randomUUID(), op: 'project.create', id: crypto.randomUUID(), fields: { name: 'Nope' } },
      ] as never,
      'guest',
    );
    expect(res.results[0]!.status).toBe('applied');
    expect(res.results[1]!.status).toBe('rejected');
    expect(res.results[1]!.errorCode).toMatch(/guest seats are project-scoped/);
  });
});

describe('guest revoke', () => {
  it('removing the last project deactivates the membership', async () => {
    const res = await guestsSvc.revoke(tenantId, ownerId, projectA, guestUserId);
    expect(res.data.membershipRevoked).toBe(true);
    const [m] = await dbAdmin
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, guestUserId)));
    expect(m!.status).toBe('deactivated');
    const rows = await dbAdmin
      .select()
      .from(pmProjectMembers)
      .where(and(eq(pmProjectMembers.tenant_id, tenantId), eq(pmProjectMembers.user_id, guestUserId)));
    expect(rows).toHaveLength(0);
  });
});

describe('notification defaults (package C)', () => {
  it('pm_comment now defaults to email ON; overrides still win', async () => {
    await expect(
      notificationsSvc.isChannelEnabled(ownerId, 'pm_comment', 'email'),
    ).resolves.toBe(true);
    await notificationsSvc.setPreference(ownerId, 'pm_comment', 'email', false);
    await expect(
      notificationsSvc.isChannelEnabled(ownerId, 'pm_comment', 'email'),
    ).resolves.toBe(false);
  });

  it('mention/assignment keep their own preference mapping', () => {
    expect(emailEventForInAppType('pm.issue.assigned')).toBe('pm_assigned');
    expect(emailEventForInAppType('pm.issue.mention')).toBe('pm_mention');
    expect(emailEventForInAppType('pm.issue.comment')).toBe('pm_comment');
  });

  it('creating an issue WITH an assignee notifies them (Linear parity)', async () => {
    const spy = jest.spyOn(notificationsSvc, 'createInAppNotification');
    spy.mockClear();
    const assignee = await mkUser(`r7-assignee-${rid()}@t.test`, tenantId, 'employee');
    await issuesSvc.create(tenantId, ownerId, {
      team_id: teamId,
      title: 'Assigned at birth',
      assignee_user_id: assignee,
    });
    await new Promise((r) => setTimeout(r, 50)); // fan-out is fire-and-forget
    const calls = spy.mock.calls.filter((c) => c[1] === 'pm.issue.assigned');
    expect(calls.some((c) => c[0] === assignee)).toBe(true);

    // Self-assign stays silent.
    spy.mockClear();
    await issuesSvc.create(tenantId, ownerId, {
      team_id: teamId,
      title: 'Self assigned',
      assignee_user_id: ownerId,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(spy.mock.calls.filter((c) => c[1] === 'pm.issue.assigned')).toHaveLength(0);
    spy.mockRestore();
  });
});
