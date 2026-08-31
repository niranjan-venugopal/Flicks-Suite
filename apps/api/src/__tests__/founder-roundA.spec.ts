/**
 * Founder round A — "Whenever we are creating something i guess we are
 * deleting something else in the project." The founder watched real data
 * disappear, so this spec pins every server-side mechanism the audit found:
 *
 *  1. "Remove sample data" silently stripped the user's OWN issues — the
 *     project FK is SET NULL and pm_issue_labels cascades off pm_labels, so
 *     the damage happened inside Postgres with no count and no sync refs.
 *     Now: preflight counts before the click, explicit audited detach, refs
 *     for every touched row, and the team's pre-seed settings restored.
 *  2. A mutation ledgered as REJECTED replayed as 'duplicate' — which the
 *     client treats as success, so the optimistic rollback never ran and a
 *     phantom row lived on screen until it "vanished" on reload.
 *  3. The delta advanced the cursor to the tenant head even when the 5000-row
 *     window truncated the events — everything past the window was never
 *     delivered and never retried, leaving live stores silently stale. A
 *     stale store is the precondition for every destructive full-set-replace.
 *  4. setInitiativeProjects rebuilt the lane from the CLIENT's view — a
 *     soft-deleted project (invisible to the client) lost its lane row in
 *     Postgres, so restore brought it back without its roadmap placement.
 *
 * Service-level against the real Postgres, mirroring founder-round20.spec.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  pmTeams,
  pmIssues,
  pmIssueLabels,
  pmProjects,
  pmInitiativeProjects,
  pmCycles,
  pmSamplePacks,
  domainEvents,
  departments,
  designations,
  locations,
  employees,
  shiftTemplates,
  employeeShifts,
} from '@flicks/db/schema';
import type { UserRole } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmSampleDataService } from '../modules/pm/sample-data.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { PmSyncService } from '../modules/pm/sync/sync.service';
import { PmMutationExecutor } from '../modules/pm/sync/mutation-executor.service';
import { SettingsService } from '../modules/settings/settings.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { PmGuestsService } from '../modules/pm/guests.service';
import type { MediaService } from '../modules/media/media.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility);
const syncSvc = new PmSyncService(dbSvc, dbAdmin as never, visibility, teamsSvc);
const sampleSvc = new PmSampleDataService(dbSvc, audit, domainEventsSvc, issuesSvc);
const gatewayStub = { emitSeq: jest.fn() };
const executor = new PmMutationExecutor(dbSvc, issuesSvc, projectsSvc, syncSvc, gatewayStub as never);
const settingsSvc = new SettingsService(
  db as never,
  dbAdmin as never,
  audit,
  { servedUrl: async () => null } as unknown as MediaService,
  domainEventsSvc,
);

let tenantId: string;
let ownerId: string;
let teamId: string;
const extraUsers: string[] = [];

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RA Studio ${rid()}`, slug: `ra-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `ra-owner-${rid()}@t.test`, full_name: 'RA Owner', status: 'active' })
    .returning();
  ownerId = u!.id;
  await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: ownerId, role: 'owner' as UserRole, status: 'active' });
  await teamsSvc.ensureWorkspace(tenantId, ownerId);
  const [team] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.tenant_id, tenantId));
  teamId = team!.id;
});

afterAll(async () => {
  await dbAdmin.delete(domainEvents).where(eq(domainEvents.tenant_id, tenantId));
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, ownerId));
  for (const id of extraUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('Round A §1 — removing sample data must not touch the user’s own work', () => {
  let before: { cycles_enabled: boolean; triage_enabled: boolean; cooldown_days: number };
  let sampleProjectId: string;
  let sampleMilestoneId: string | null;
  let activeCycleId: string;
  let sampleLabelId: string;
  let ownIssueId: string;

  it('seed snapshots the team settings it flips', async () => {
    const [pre] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.id, teamId));
    before = {
      cycles_enabled: pre!.cycles_enabled,
      triage_enabled: pre!.triage_enabled,
      cooldown_days: pre!.cooldown_days,
    };

    await sampleSvc.seed(tenantId, ownerId);

    const [during] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.id, teamId));
    expect(during!.cycles_enabled).toBe(true);
    expect(during!.triage_enabled).toBe(true);

    const [pack] = await dbAdmin.select().from(pmSamplePacks).where(eq(pmSamplePacks.tenant_id, tenantId));
    const ids = pack!.record_ids as Record<string, unknown>;
    expect(ids._team_before).toMatchObject({ team_id: teamId, ...before });
  });

  it('status reports zero collateral while nothing of the user’s touches the pack', async () => {
    const s = await sampleSvc.status(tenantId);
    expect(s.data.loaded).toBe(true);
    expect(s.data).toMatchObject({
      own_issues_in_sample_projects: 0,
      own_issues_in_sample_cycles: 0,
      own_issues_with_sample_labels: 0,
    });
  });

  it('status counts the user’s own issues sitting inside the pack', async () => {
    const [pack] = await dbAdmin.select().from(pmSamplePacks).where(eq(pmSamplePacks.tenant_id, tenantId));
    const ids = pack!.record_ids as Record<string, string[]>;
    sampleProjectId = ids.pm_projects![0]!;
    sampleMilestoneId = ids.pm_project_milestones?.[0] ?? null;
    sampleLabelId = ids.pm_labels![0]!;
    const [active] = await dbAdmin
      .select()
      .from(pmCycles)
      .where(and(eq(pmCycles.tenant_id, tenantId), eq(pmCycles.status, 'active')));
    activeCycleId = active!.id;

    // A REAL issue, created by the user, linked into the sample pack the way
    // the founder's users did: sample project + active sample cycle + label.
    const own = await issuesSvc.create(tenantId, ownerId, {
      team_id: teamId,
      title: 'Real work inside the demo project',
      project_id: sampleProjectId,
      milestone_id: sampleMilestoneId,
    });
    ownIssueId = own.data.id;
    await issuesSvc.setCycle(tenantId, ownerId, ownIssueId, { cycle_id: activeCycleId });
    await issuesSvc.setLabels(tenantId, ownerId, ownIssueId, [sampleLabelId]);

    const s = await sampleSvc.status(tenantId);
    expect(s.data).toMatchObject({
      own_issues_in_sample_projects: 1,
      own_issues_in_sample_cycles: 1,
      own_issues_with_sample_labels: 1,
    });
  });

  it('remove deletes the pack, detaches (never deletes) the own issue, and restores team settings', async () => {
    const res = await sampleSvc.remove(tenantId, ownerId);
    expect(res.data).toMatchObject({
      loaded: false,
      own_issues_detached: 1,
      own_issues_uncycled: 1,
      own_issues_unlabelled: 1,
    });

    // The user's issue SURVIVES — detached, not destroyed.
    const [own] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, ownIssueId));
    expect(own).toBeDefined();
    expect(own!.deleted_at).toBeNull();
    expect(own!.project_id).toBeNull();
    expect(own!.milestone_id).toBeNull();
    expect(own!.cycle_id).toBeNull();
    const labelRows = await dbAdmin.select().from(pmIssueLabels).where(eq(pmIssueLabels.issue_id, ownIssueId));
    expect(labelRows).toHaveLength(0);

    // The pack itself is gone.
    const [proj] = await dbAdmin.select().from(pmProjects).where(eq(pmProjects.id, sampleProjectId));
    expect(proj).toBeUndefined();
    expect(await dbAdmin.select().from(pmSamplePacks).where(eq(pmSamplePacks.tenant_id, tenantId))).toHaveLength(0);

    // Loading a demo must not permanently reconfigure the workspace.
    const [after] = await dbAdmin.select().from(pmTeams).where(eq(pmTeams.id, teamId));
    expect(after!.cycles_enabled).toBe(before.cycles_enabled);
    expect(after!.triage_enabled).toBe(before.triage_enabled);
    expect(after!.cooldown_days).toBe(before.cooldown_days);
  });

  it('the removal event names the own issue and its label scope, so live clients converge', async () => {
    const events = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'pm.issue.deleted')));
    const mine = events.find((e) => (e.payload as { sample_removed?: boolean }).sample_removed === true);
    expect(mine).toBeDefined();
    const refs = (mine!.payload as { sync: Array<{ t: string; id: string }> }).sync;
    // Without these two refs a live client kept rendering the stale links —
    // or wrote them back through a later full-set replace.
    expect(refs).toContainEqual({ t: 'pm_issues', id: ownIssueId });
    expect(refs).toContainEqual({ t: 'pm_issue_labels', id: ownIssueId });
  });
});

describe('Round A §2 — a rejected mutation must replay as rejected', () => {
  it('first run rejects, replay repeats the rejection instead of claiming duplicate-success', async () => {
    const cid = crypto.randomUUID();
    const item = {
      clientMutationId: cid,
      op: 'issue.create' as const,
      id: crypto.randomUUID(),
      fields: { team_id: teamId, title: '   ' }, // blank title → BadRequest
    };
    const first = await executor.execute(tenantId, ownerId, [item]);
    expect(first.results[0]!.status).toBe('rejected');

    // The offline queue retries with the SAME clientMutationId. 'duplicate'
    // reads as success client-side and skips the rollback — the phantom row
    // the founder watched vanish on reload.
    const replay = await executor.execute(tenantId, ownerId, [item]);
    expect(replay.results[0]!.status).toBe('rejected');
  });

  it('an applied mutation still replays as duplicate', async () => {
    const cid = crypto.randomUUID();
    const item = {
      clientMutationId: cid,
      op: 'issue.create' as const,
      id: crypto.randomUUID(),
      fields: { team_id: teamId, title: 'Applied once' },
    };
    const first = await executor.execute(tenantId, ownerId, [item]);
    expect(first.results[0]!.status).toBe('applied');
    const replay = await executor.execute(tenantId, ownerId, [item]);
    expect(replay.results[0]!.status).toBe('duplicate');
  });
});

describe('Round A §4 — an initiative lane keeps a soft-deleted project’s placement', () => {
  it('a full-set replace from a client that cannot see the deleted project preserves its row', async () => {
    const init = await projectsSvc.createInitiative(tenantId, ownerId, 'owner', { name: `Lane ${rid()}` });
    const a = (await projectsSvc.create(tenantId, ownerId, { name: `Keep ${rid()}`, team_ids: [teamId] })).data;
    const b = (await projectsSvc.create(tenantId, ownerId, { name: `Gone ${rid()}`, team_ids: [teamId] })).data;
    await projectsSvc.setInitiativeProjects(tenantId, ownerId, 'owner', init.data.id, [a.id, b.id]);

    await projectsSvc.softDelete(tenantId, ownerId, b.id, 'owner');

    // The client's local view no longer holds b (tombstoned) — it sends [a].
    await projectsSvc.setInitiativeProjects(tenantId, ownerId, 'owner', init.data.id, [a.id]);

    const lane = await dbAdmin
      .select()
      .from(pmInitiativeProjects)
      .where(eq(pmInitiativeProjects.initiative_id, init.data.id))
      .orderBy(asc(pmInitiativeProjects.position));
    // b's lane row SURVIVED the replace: restore brings the project back
    // exactly where the roadmap had it.
    expect(lane.map((r) => r.project_id)).toEqual(expect.arrayContaining([a.id, b.id]));

    await projectsSvc.restore(tenantId, ownerId, b.id, 'owner');
    const listed = await projectsSvc.listInitiatives(tenantId, ownerId);
    expect(listed.data.projects[init.data.id]).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('dropping a LIVE project from the set still removes its lane row', async () => {
    const init = await projectsSvc.createInitiative(tenantId, ownerId, 'owner', { name: `Lane2 ${rid()}` });
    const a = (await projectsSvc.create(tenantId, ownerId, { name: `Stay ${rid()}`, team_ids: [teamId] })).data;
    const c = (await projectsSvc.create(tenantId, ownerId, { name: `Drop ${rid()}`, team_ids: [teamId] })).data;
    await projectsSvc.setInitiativeProjects(tenantId, ownerId, 'owner', init.data.id, [a.id, c.id]);
    await projectsSvc.setInitiativeProjects(tenantId, ownerId, 'owner', init.data.id, [a.id]);
    const lane = await dbAdmin
      .select()
      .from(pmInitiativeProjects)
      .where(eq(pmInitiativeProjects.initiative_id, init.data.id));
    expect(lane.map((r) => r.project_id)).toEqual([a.id]);
  });

  it('a truly foreign project id still fails the whole write', async () => {
    const init = await projectsSvc.createInitiative(tenantId, ownerId, 'owner', { name: `Lane3 ${rid()}` });
    await expect(
      projectsSvc.setInitiativeProjects(tenantId, ownerId, 'owner', init.data.id, [crypto.randomUUID()]),
    ).rejects.toThrow(/outside this workspace/i);
  });
});

describe('Round A — Settings headcounts count everyone on the books', () => {
  // The old counters were correlated sub-queries on a joinless select, which
  // Drizzle renders with UNQUALIFIED columns: `department_id = id` compared
  // two employees columns and every row counted 0, forever. These tests seed
  // real people in every state and pin the true numbers.
  let deptId: string;
  let locId: string;
  let desigId: string;
  let shiftId: string;

  const seedEmployee = async (
    label: string,
    status: 'active' | 'inactive' | 'notice_period' | 'separated',
    opts: { deleted?: boolean } = {},
  ) => {
    const [e] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId,
        employee_code: `RA-${rid()}`,
        first_name: label,
        last_name: 'Count',
        work_email: `ra-${label}-${rid()}@t.test`,
        date_of_joining: '2026-01-01',
        status,
        department_id: deptId,
        location_id: locId,
        designation_id: desigId,
        ...(opts.deleted ? { deleted_at: new Date() } : {}),
      })
      .returning();
    return e!.id;
  };

  beforeAll(async () => {
    const [dept] = await dbAdmin
      .insert(departments)
      .values({ tenant_id: tenantId, name: `Engineering ${rid()}` })
      .returning();
    deptId = dept!.id;
    const [loc] = await dbAdmin
      .insert(locations)
      .values({ tenant_id: tenantId, name: `Chennai HQ ${rid()}`, timezone: 'Asia/Kolkata' })
      .returning();
    locId = loc!.id;
    const [desig] = await dbAdmin
      .insert(designations)
      .values({ tenant_id: tenantId, title: `Engineer ${rid()}`, department_id: deptId })
      .returning();
    desigId = desig!.id;
    const [shift] = await dbAdmin
      .insert(shiftTemplates)
      .values({
        tenant_id: tenantId,
        name: `Night ${rid()}`,
        start_time: '22:00',
        end_time: '06:00',
        is_overnight: true,
        working_days: [1, 2, 3, 4, 5],
      })
      .returning();
    shiftId = shift!.id;

    // On the books: an active engineer, an invited-not-yet-onboarded one
    // (status 'inactive' until approval) and one serving notice. Off the
    // books: separated, and an active row that was removed (round 21).
    const active = await seedEmployee('active', 'active');
    await seedEmployee('invited', 'inactive');
    await seedEmployee('notice', 'notice_period');
    const separated = await seedEmployee('separated', 'separated');
    await seedEmployee('removed', 'active', { deleted: true });

    // Shift mappings: the active engineer (counts), the separated one (must
    // not), and an expired mapping for the invited one (must not).
    const invited = (
      await dbAdmin.select({ id: employees.id }).from(employees)
        .where(and(eq(employees.tenant_id, tenantId), eq(employees.first_name, 'invited')))
    )[0]!.id;
    await dbAdmin.insert(employeeShifts).values([
      { tenant_id: tenantId, employee_id: active, shift_template_id: shiftId, effective_from: '2026-01-01' },
      { tenant_id: tenantId, employee_id: separated, shift_template_id: shiftId, effective_from: '2026-01-01' },
      { tenant_id: tenantId, employee_id: invited, shift_template_id: shiftId, effective_from: '2026-01-01', effective_to: '2026-02-01' },
    ]);
  });

  it('departments: active + invited + notice count; separated and removed do not', async () => {
    const res = await settingsSvc.listDepartments(tenantId);
    const dept = res.data.find((d) => d.id === deptId);
    expect(dept?.headcount).toBe(3);
  });

  it('locations: same counting rule', async () => {
    const res = await settingsSvc.listLocations(tenantId);
    const loc = res.data.find((l) => l.id === locId);
    expect(loc?.headcount).toBe(3);
  });

  it('designations: same counting rule (and the department name still resolves)', async () => {
    const res = await settingsSvc.listDesignations(tenantId);
    const desig = res.data.find((d) => d.id === desigId);
    expect(desig?.headcount).toBe(3);
    expect(desig?.departmentName).toBeTruthy();
  });

  it('shifts: assigned counts only on-the-books employees with an effective mapping', async () => {
    const res = await settingsSvc.listShifts(tenantId);
    const shift = res.data.find((s) => s.id === shiftId);
    expect(shift?.assigned).toBe(1);
  });
});

describe('Round A — reporting manager and shift are editable after onboarding', () => {
  // The shift dropdown on the Add-employee form dropped its value before the
  // request, and NOTHING anywhere wrote employee_shifts — every employee
  // silently ran the tenant default shift, so lateness and worked hours were
  // wrong for anyone else. The manager could only ever be set at invite time.
  const employeesSvc = new EmployeesService(
    dbSvc,
    dbAdmin as never,
    audit,
    { sendEmail: async () => true, createInAppNotification: async () => undefined } as never,
    emitter,
    new ConfigService({ NODE_ENV: 'test' }),
    { issueInviteMagicLink: async () => 'https://x.test/magic' } as never,
    { servedUrl: async () => null } as never,
  );

  let shiftAId: string;
  let shiftBId: string;
  let empId: string;
  let managerEmpId: string;

  const mappings = (employeeId: string) =>
    dbAdmin
      .select()
      .from(employeeShifts)
      .where(eq(employeeShifts.employee_id, employeeId))
      .orderBy(asc(employeeShifts.effective_from));

  beforeAll(async () => {
    const mkShift = async (name: string, start: string, end: string) => {
      const [s] = await dbAdmin
        .insert(shiftTemplates)
        .values({ tenant_id: tenantId, name: `${name} ${rid()}`, start_time: start, end_time: end, working_days: [1, 2, 3, 4, 5] })
        .returning();
      return s!.id;
    };
    shiftAId = await mkShift('Morning', '06:00', '14:00');
    shiftBId = await mkShift('Evening', '14:00', '22:00');
    const [mgr] = await dbAdmin
      .insert(employees)
      .values({
        tenant_id: tenantId, employee_code: `RA-MGR-${rid()}`, first_name: 'Meera', last_name: 'Manager',
        work_email: `ra-mgr-${rid()}@t.test`, date_of_joining: '2026-01-01', status: 'active',
      })
      .returning();
    managerEmpId = mgr!.id;
  });

  it('inviting with a shift writes the mapping from the joining date', async () => {
    const res = await employeesSvc.inviteEmployee(
      {
        fullName: 'Shifted Hire',
        email: `ra-hire-${rid()}@t.test`,
        employeeCode: `RA-H-${rid()}`,
        joiningDate: '2026-08-01',
        shiftTemplateId: shiftAId,
        managerId: managerEmpId,
      } as never,
      ownerId,
      tenantId,
    );
    empId = res.id;
    const rows = await mappings(empId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shift_template_id).toBe(shiftAId);
    expect(rows[0]!.effective_from).toBe('2026-08-01');
  });

  it('the employee detail names the shift the attendance engine will use', async () => {
    const detail = await employeesSvc.getEmployee(empId, tenantId);
    expect(detail.currentShift?.shiftTemplateId).toBe(shiftAId);
    expect(detail.reportingManagerId).toBe(managerEmpId);
  });

  it('reassigning closes the running mapping and starts the new one today', async () => {
    await employeesSvc.updateEmployee(empId, { shiftTemplateId: shiftBId } as never, ownerId, tenantId);
    const rows = await mappings(empId);
    expect(rows).toHaveLength(2);
    const today = new Date().toISOString().split('T')[0]!;
    // History preserved: the old mapping ends the day before the new begins.
    expect(rows[0]!.shift_template_id).toBe(shiftAId);
    expect(rows[0]!.effective_to).not.toBeNull();
    expect(rows[1]!.shift_template_id).toBe(shiftBId);
    expect(rows[1]!.effective_from).toBe(today);
    expect(rows[1]!.effective_to).toBeNull();
  });

  it('null reverts to the workspace default (no open mapping left)', async () => {
    await employeesSvc.updateEmployee(empId, { shiftTemplateId: null } as never, ownerId, tenantId);
    const rows = await mappings(empId);
    const today = new Date().toISOString().split('T')[0]!;
    expect(rows.every((r) => r.effective_to !== null && r.effective_to < today)).toBe(true);
    const detail = await employeesSvc.getEmployee(empId, tenantId);
    expect(detail.currentShift).toBeNull();
  });

  it('the reporting manager is editable — and clearable — after onboarding', async () => {
    await employeesSvc.updateEmployee(empId, { reportingManagerId: null } as never, ownerId, tenantId);
    expect((await employeesSvc.getEmployee(empId, tenantId)).reportingManagerId).toBeNull();
    await employeesSvc.updateEmployee(empId, { reportingManagerId: managerEmpId } as never, ownerId, tenantId);
    expect((await employeesSvc.getEmployee(empId, tenantId)).reportingManagerId).toBe(managerEmpId);
  });

  it('an employee cannot report to themselves, and a foreign shift id is rejected', async () => {
    await expect(
      employeesSvc.updateEmployee(empId, { reportingManagerId: empId } as never, ownerId, tenantId),
    ).rejects.toThrow(/cannot report to themselves/i);
    await expect(
      employeesSvc.updateEmployee(empId, { shiftTemplateId: crypto.randomUUID() } as never, ownerId, tenantId),
    ).rejects.toThrow(/does not belong to this workspace/i);
  });
});

describe('Round A — guest invites: the project lead, plus manager and above', () => {
  // "Full access" (module grant pm:edit) could never satisfy @Roles('admin'),
  // so exactly the people running a project couldn't invite its guests. The
  // gate now lives in the service — a per-project lead exception is nothing a
  // route decorator can express.
  // The members facade is stubbed, but with REAL user rows — the
  // pm_project_members FK is on users.id, so a minted uuid would violate it.
  const guestsSvc = new PmGuestsService(
    dbSvc,
    audit,
    domainEventsSvc,
    {
      inviteExternalGuest: async () => {
        const [u] = await dbAdmin
          .insert(users)
          .values({ email: `ra-guest-${rid()}@t.test`, full_name: 'Stub Guest', status: 'active' })
          .returning();
        extraUsers.push(u!.id);
        await dbAdmin
          .insert(memberships)
          .values({ tenant_id: tenantId, user_id: u!.id, role: 'guest', status: 'invited' });
        return { userId: u!.id, status: 'invited', magicLinkSent: true };
      },
      revokeGuestMembership: async () => undefined,
    } as never,
    { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never,
  );

  let managerUserId: string;
  let employeeUserId: string;

  const mkMember = async (role: 'manager' | 'employee') => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `ra-${role}-${rid()}@t.test`, full_name: `RA ${role}`, status: 'active' })
      .returning();
    await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' });
    extraUsers.push(u!.id);
    return u!.id;
  };

  beforeAll(async () => {
    managerUserId = await mkMember('manager');
    employeeUserId = await mkMember('employee');
  });

  const mkProject = async (leadUserId?: string) =>
    (
      await projectsSvc.create(tenantId, ownerId, {
        name: `Guests ${rid()}`,
        team_ids: [teamId],
        ...(leadUserId ? { lead_user_id: leadUserId } : {}),
      })
    ).data;

  it('a manager can invite, list and revoke without leading the project', async () => {
    const p = await mkProject();
    const res = await guestsSvc.invite(tenantId, managerUserId, 'manager', p.id, { email: `g-${rid()}@t.test` });
    expect(res.data.status).toBe('invited');
    const listed = await guestsSvc.list(tenantId, managerUserId, 'manager', p.id);
    expect(Array.isArray(listed.data)).toBe(true);
    await expect(
      guestsSvc.revoke(tenantId, managerUserId, 'manager', p.id, res.data.userId),
    ).resolves.toBeDefined();
  });

  it('an employee who LEADS the project can invite guests to it', async () => {
    const p = await mkProject(employeeUserId);
    const res = await guestsSvc.invite(tenantId, employeeUserId, 'employee', p.id, { email: `g-${rid()}@t.test` });
    expect(res.data.status).toBe('invited');
  });

  it('an employee who does NOT lead the project cannot', async () => {
    const p = await mkProject();
    await expect(
      guestsSvc.invite(tenantId, employeeUserId, 'employee', p.id, { email: `g-${rid()}@t.test` }),
    ).rejects.toThrow(/project lead, or a manager and above/i);
    await expect(
      guestsSvc.list(tenantId, employeeUserId, 'employee', p.id),
    ).rejects.toThrow(/project lead, or a manager and above/i);
  });

  it('a guest never manages seats, even if named as the lead', async () => {
    const p = await mkProject(employeeUserId);
    await expect(
      guestsSvc.invite(tenantId, employeeUserId, 'guest', p.id, { email: `g-${rid()}@t.test` }),
    ).rejects.toThrow(/project lead, or a manager and above/i);
  });
});

describe('Round A §3 — the delta cursor only advances over events it delivered', () => {
  it('a truncated 5000-event window caps latest_seq at the last processed event', async () => {
    // Flood the outbox past the window from a THROWAWAY tenant's worth of
    // no-op pm.* events (sync: [] — nothing to re-fetch, fast to insert).
    const rows: Array<{ tenant_id: string; event_name: string; payload: { sync: [] } }> = [];
    for (let i = 0; i < 5010; i++) {
      rows.push({ tenant_id: tenantId, event_name: 'pm.noop.flood', payload: { sync: [] } });
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await dbAdmin.insert(domainEvents).values(rows.slice(i, i + 1000));
    }

    const trueLatest = await syncSvc.latestSeq(tenantId);
    // A cursor of 0 sits below the tenant's horizon (the global sequence
    // starts wherever it starts) and would 410 — poll from the horizon, the
    // oldest cursor a client of this tenant can legally hold.
    const first = await syncSvc.delta(tenantId, ownerId, await syncSvc.minSeqHorizon(tenantId));
    expect('reBootstrap' in first).toBe(false);
    if ('reBootstrap' in first) return;
    // The window truncated — the cursor must stop at event #5000, NOT jump to
    // the head. Jumping meant every event past the window was never delivered
    // and never retried: the silently-stale store behind the data loss.
    expect(first.latest_seq).toBeLessThan(trueLatest);

    // The next poll picks up exactly where this one stopped and reaches the head.
    const second = await syncSvc.delta(tenantId, ownerId, first.latest_seq);
    if ('reBootstrap' in second) throw new Error('unexpected reBootstrap');
    expect(second.latest_seq).toBe(trueLatest);
  });
});
