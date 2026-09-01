/**
 * Founder round E — PM speed + members + Private projects + project logo.
 *
 * The founder's asks, verbatim-ish: "the projects, the issues and everything
 * takes a lot of time to load"; "when a user creates an issue inside a
 * project, it's not getting assigned to the project"; "add specific members
 * from the employee or manager to give access to the project"; "project logo
 * can be added". The founder chose Members + a per-project Private toggle.
 *
 * What this suite pins:
 *  1. issue.create THROUGH THE SYNC EXECUTOR persists project_id — the exact
 *     wire path the composer uses in sync mode (previously untested; every
 *     older project_id assertion went through issuesSvc.create directly).
 *  2. Project members: add/list/remove round-trip; the roster carries the
 *     workspace role + a SIGNED avatar and marks the lead; guests never
 *     appear in it and can never be added through it; the authority bar is
 *     the guests bar (lead + manager and above).
 *  3. Private projects: flipping Private narrows visibility to members, the
 *     lead and owner/admin-class roles — enforced in REST list/detail,
 *     issues list/get, search, the sync bootstrap AND the delta (a flip
 *     tombstones the project + its issues on non-members' clients, and
 *     membership brings them back). Managers are NOT exempt: the founder's
 *     ask is that managers are ADDED to gain access.
 *  4. Project logo: upload stores the key, every read path serves a signed
 *     logo_url and never the raw storage key; remove reverts to the emoji.
 *
 * Service-level against the real Postgres, mirroring founder-round20.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
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
import { PmSearchService } from '../modules/pm/search.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const visibility = new PmVisibilityService(dbSvc);

// One media stub for every consumer: pure, deterministic, no R2.
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
  processImage: jest.fn(async (_buf: Buffer, prefix: string) => ({
    key256: `${prefix}/${rid()}_256.webp`,
    key64: `${prefix}/${rid()}_64.webp`,
  })),
  deleteImage: jest.fn(async () => undefined),
};

const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub as never);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub as never);
const searchSvc = new PmSearchService(dbSvc, visibility);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc, mediaStub as never);
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, { emitSeq: jest.fn() } as never);

let tenantId: string;
let ownerId: string;
let managerId: string;
let employeeId: string; // non-member unless a test adds them
let employee2Id: string; // the member the roster tests add
let guestId: string;
let teamId: string;
const trackedUsers: string[] = [];

/** Parse the bootstrap's NDJSON lines into model → rows. */
function parseBootstrap(lines: string[]): Record<string, Array<Record<string, unknown>>> {
  const models: Record<string, Array<Record<string, unknown>>> = {};
  for (const line of lines) {
    const parsed = JSON.parse(line) as { model?: string; rows?: Array<Record<string, unknown>> };
    if (parsed.model) models[parsed.model] = [...(models[parsed.model] ?? []), ...(parsed.rows ?? [])];
  }
  return models;
}

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RE Studio ${rid()}`, slug: `re-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;

  const mk = async (role: UserRole, label: string, avatarKey?: string) => {
    const [u] = await dbAdmin
      .insert(users)
      .values({
        email: `re-${label}-${rid()}@t.test`,
        full_name: `RE ${label}`,
        status: 'active',
        ...(avatarKey ? { avatar_key: avatarKey } : {}),
      })
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
  employee2Id = await mk('employee', 'member', `users/x/avatar/${rid()}_256.webp`);
  guestId = await mk('guest', 'guest');

  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;
});

afterAll(async () => {
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('E1 — the sync executor persists the at-create project link', () => {
  it('issue.create with project_id lands in the project (the composer wire path)', async () => {
    const project = (await projectsSvc.create(tenantId, ownerId, { name: `Mapping ${rid()}`, team_ids: [teamId] })).data;
    const issueId = crypto.randomUUID();
    const res = await executor.execute(tenantId, ownerId, [
      {
        clientMutationId: crypto.randomUUID(),
        op: 'issue.create' as const,
        id: issueId,
        fields: { team_id: teamId, title: 'Born inside the project', project_id: project.id },
      },
    ]);
    expect(res.results[0]!.status).toBe('applied');
    const [row] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issueId));
    expect(row!.project_id).toBe(project.id);
    const detail = await projectsSvc.detail(tenantId, ownerId, project.id);
    expect(detail.data.issues.map((i) => i.id)).toContain(issueId);
  });
});

describe('E2 — project members: roster, roles, authority', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await projectsSvc.create(tenantId, ownerId, { name: `Roster ${rid()}`, team_ids: [teamId] })).data.id;
  });

  it('add → list shows workspace role, signed avatar and the lead marker', async () => {
    await projectsSvc.addMember(tenantId, ownerId, 'owner', projectId, employee2Id);
    const list = await projectsSvc.listMembers(tenantId, ownerId, projectId);
    const m = list.data.find((r) => r.user_id === employee2Id);
    expect(m).toBeDefined();
    expect(m!.role).toBe('employee');
    expect(m!.avatar_url).toMatch(/^signed:users\//);
    expect(m!.is_lead).toBe(false);
    expect(list.data.some((r) => 'avatar_key' in (r as unknown as Record<string, unknown>))).toBe(false);
  });

  it('adding is idempotent; a manager may add; a non-lead employee may not', async () => {
    await projectsSvc.addMember(tenantId, managerId, 'manager', projectId, employee2Id); // no throw, no dupe
    const list = await projectsSvc.listMembers(tenantId, ownerId, projectId);
    expect(list.data.filter((r) => r.user_id === employee2Id)).toHaveLength(1);
    await expect(
      projectsSvc.addMember(tenantId, employeeId, 'employee', projectId, employee2Id),
    ).rejects.toThrow(/project lead, or a manager/);
  });

  it('an employee who LEADS the project may manage its members', async () => {
    const led = (
      await projectsSvc.create(tenantId, ownerId, { name: `Led ${rid()}`, team_ids: [teamId], lead_user_id: employeeId })
    ).data;
    await projectsSvc.addMember(tenantId, employeeId, 'employee', led.id, employee2Id);
    const list = await projectsSvc.listMembers(tenantId, employeeId, led.id);
    expect(list.data.some((r) => r.user_id === employee2Id)).toBe(true);
  });

  it('guests can neither be added through this door nor pollute the roster', async () => {
    await expect(
      projectsSvc.addMember(tenantId, ownerId, 'owner', projectId, guestId),
    ).rejects.toThrow(/Guests are invited from the Guests card/);
    // A guest row planted directly (the guest-invite flow writes these) stays
    // on the Guests card — the members roster filters it out.
    await dbAdmin
      .insert(pmProjectMembers)
      .values({ tenant_id: tenantId, project_id: projectId, user_id: guestId })
      .onConflictDoNothing();
    const list = await projectsSvc.listMembers(tenantId, ownerId, projectId);
    expect(list.data.some((r) => r.user_id === guestId)).toBe(false);
  });

  it('remove takes the member off the roster and nothing else', async () => {
    await projectsSvc.removeMember(tenantId, ownerId, 'owner', projectId, employee2Id);
    const list = await projectsSvc.listMembers(tenantId, ownerId, projectId);
    expect(list.data.some((r) => r.user_id === employee2Id)).toBe(false);
    const [membership] = await dbAdmin
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenant_id, tenantId), eq(memberships.user_id, employee2Id)));
    expect(membership!.status).toBe('active'); // workspace membership untouched
  });
});

describe('E3 — Private projects: members + lead + owner/admin only, everywhere', () => {
  let projectId: string;
  let issueId: string;
  let looseIssueId: string;
  const secretTitle = `Skunkworks ${rid()}`;

  beforeAll(async () => {
    const p = (await projectsSvc.create(tenantId, ownerId, { name: secretTitle, team_ids: [teamId] })).data;
    projectId = p.id;
    issueId = (
      await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: `${secretTitle} issue`, project_id: projectId })
    ).data.id;
    looseIssueId = (
      await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: `Loose ${rid()}` })
    ).data.id;
  });

  let preFlipSeq = 0;

  it('a non-lead employee may not flip the switch; the owner may', async () => {
    await expect(
      projectsSvc.setVisibilityFlag(tenantId, employeeId, 'employee', projectId, true),
    ).rejects.toThrow(/project lead, or a manager/);
    preFlipSeq = await syncSvc.latestSeq(tenantId); // a live client's cursor before the flip
    const res = await projectsSvc.setVisibilityFlag(tenantId, ownerId, 'owner', projectId, true);
    expect(res.data.is_private).toBe(true);
  });

  it('REST: the project and its issues vanish for a non-member employee — and a MANAGER', async () => {
    for (const [uid] of [[employeeId], [managerId]] as const) {
      const list = await projectsSvc.list(tenantId, uid);
      expect(list.data.projects.some((p) => p.id === projectId)).toBe(false);
      await expect(projectsSvc.detail(tenantId, uid, projectId)).rejects.toThrow(/not visible/);
      const issues = await issuesSvc.list(tenantId, uid, { team_id: teamId });
      const ids = issues.data.map((i) => (i as { id: string }).id);
      expect(ids).not.toContain(issueId);
      expect(ids).toContain(looseIssueId); // the team itself is still visible
      await expect(issuesSvc.get(tenantId, uid, issueId)).rejects.toThrow(/not found/i);
    }
    // The owner keeps seeing everything.
    const ownerList = await projectsSvc.list(tenantId, ownerId);
    expect(ownerList.data.projects.some((p) => p.id === projectId)).toBe(true);
  });

  it('search stops matching the private project’s issues for non-members', async () => {
    const forOwner = await searchSvc.search(tenantId, ownerId, 'Skunkworks');
    expect(forOwner.data.issues.some((i) => (i as { id: string }).id === issueId)).toBe(true);
    const forEmployee = await searchSvc.search(tenantId, employeeId, 'Skunkworks');
    expect(forEmployee.data.issues.some((i) => (i as { id: string }).id === issueId)).toBe(false);
  });

  it('bootstrap ships zero private rows to a non-member', async () => {
    const models = parseBootstrap(await syncSvc.bootstrap(tenantId, employeeId));
    expect((models.pm_projects ?? []).some((r) => r.id === projectId)).toBe(false);
    expect((models.pm_issues ?? []).some((r) => r.id === issueId)).toBe(false);
    expect((models.pm_issues ?? []).some((r) => r.id === looseIssueId)).toBe(true);
  });

  it('the delta turns the flip into tombstones on a non-member’s client', async () => {
    // From a cursor taken BEFORE the flip, its refs are in-window: the
    // re-fetch misses for this caller, and a miss IS the tombstone
    // (round-A rule — visibility loss and deletion share one mechanism).
    const delta = (await syncSvc.delta(tenantId, employeeId, preFlipSeq)) as {
      tombstones: Partial<Record<string, string[]>>;
    };
    expect(delta.tombstones.pm_projects ?? []).toContain(projectId);
    expect(delta.tombstones.pm_issues ?? []).toContain(issueId);
  });

  it('a non-member cannot create into or re-home issues to the private project', async () => {
    await expect(
      issuesSvc.create(tenantId, employeeId, { team_id: teamId, title: 'Sneak in', project_id: projectId }),
    ).rejects.toThrow(/project_id does not belong/);
    await expect(
      issuesSvc.setProject(tenantId, employeeId, looseIssueId, { project_id: projectId }),
    ).rejects.toThrow(/project_id does not belong/);
  });

  it('membership opens it up — list, detail, issues, create — and removal closes it again', async () => {
    await projectsSvc.addMember(tenantId, ownerId, 'owner', projectId, employeeId);
    const list = await projectsSvc.list(tenantId, employeeId);
    expect(list.data.projects.some((p) => p.id === projectId)).toBe(true);
    const detail = await projectsSvc.detail(tenantId, employeeId, projectId);
    expect(detail.data.issues.some((i) => i.id === issueId)).toBe(true);
    const created = await issuesSvc.create(tenantId, employeeId, {
      team_id: teamId,
      title: `Member's issue ${rid()}`,
      project_id: projectId,
    });
    expect(created.data.project_id).toBe(projectId);
    const models = parseBootstrap(await syncSvc.bootstrap(tenantId, employeeId));
    expect((models.pm_projects ?? []).some((r) => r.id === projectId)).toBe(true);

    const preRemoveSeq = await syncSvc.latestSeq(tenantId);
    await projectsSvc.removeMember(tenantId, ownerId, 'owner', projectId, employeeId);
    const after = await projectsSvc.list(tenantId, employeeId);
    expect(after.data.projects.some((p) => p.id === projectId)).toBe(false);
    const delta = (await syncSvc.delta(tenantId, employeeId, preRemoveSeq)) as {
      tombstones: Partial<Record<string, string[]>>;
    };
    expect(delta.tombstones.pm_projects ?? []).toContain(projectId);
  });

  it('an employee who LEADS a private project keeps seeing it', async () => {
    const led = (
      await projectsSvc.create(tenantId, ownerId, { name: `Private led ${rid()}`, team_ids: [teamId], lead_user_id: employeeId })
    ).data;
    await projectsSvc.setVisibilityFlag(tenantId, ownerId, 'owner', led.id, true);
    const list = await projectsSvc.list(tenantId, employeeId);
    expect(list.data.projects.some((p) => p.id === led.id)).toBe(true);
  });

  it('flipping back public restores everyone', async () => {
    await projectsSvc.setVisibilityFlag(tenantId, ownerId, 'owner', projectId, false);
    const list = await projectsSvc.list(tenantId, employeeId);
    expect(list.data.projects.some((p) => p.id === projectId)).toBe(true);
    const issues = await issuesSvc.list(tenantId, employeeId, { team_id: teamId });
    expect(issues.data.map((i) => (i as { id: string }).id)).toContain(issueId);
  });
});

describe('E4 — project logo: stored as a key, served only as a signed URL', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await projectsSvc.create(tenantId, ownerId, { name: `Logo ${rid()}`, team_ids: [teamId] })).data.id;
  });

  it('upload stores the key and every read serves signed logo_url — never the raw key', async () => {
    const res = await projectsSvc.uploadLogo(tenantId, ownerId, projectId, Buffer.from('fake-image'));
    expect((res.data as { logo_url: string | null }).logo_url).toMatch(/^signed:tenants\//);
    expect('logo_key' in (res.data as Record<string, unknown>)).toBe(false);

    const [row] = await dbAdmin.select().from(pmProjects).where(eq(pmProjects.id, projectId));
    expect(row!.logo_key).toMatch(/^tenants\/.*\/pm-projects\//);

    const list = await projectsSvc.list(tenantId, ownerId);
    const listed = list.data.projects.find((p) => p.id === projectId) as Record<string, unknown>;
    expect(listed.logo_url).toMatch(/^signed:/);
    expect('logo_key' in listed).toBe(false);

    const models = parseBootstrap(await syncSvc.bootstrap(tenantId, ownerId));
    const boot = (models.pm_projects ?? []).find((r) => r.id === projectId)!;
    expect(boot.logo_url).toMatch(/^signed:/);
    expect(boot.is_private).toBe(false);
    expect('logo_key' in boot).toBe(false);
  });

  it('replacing deletes the previous variants; removing reverts to the emoji', async () => {
    mediaStub.deleteImage.mockClear();
    await projectsSvc.uploadLogo(tenantId, ownerId, projectId, Buffer.from('fake-image-2'));
    expect(mediaStub.deleteImage).toHaveBeenCalledTimes(1);

    const removed = await projectsSvc.removeLogo(tenantId, ownerId, projectId);
    expect((removed.data as { logo_url: string | null }).logo_url).toBeNull();
    const [row] = await dbAdmin.select().from(pmProjects).where(eq(pmProjects.id, projectId));
    expect(row!.logo_key).toBeNull();
  });

  it('guests cannot touch the logo', async () => {
    await expect(
      projectsSvc.uploadLogo(tenantId, guestId, projectId, Buffer.from('x')),
    ).rejects.toThrow(/not available to guests|not visible/);
  });
});
