/**
 * Founder round C — the final pre-freeze fixes.
 *
 * C1 avatars reach PM: usersLite signs avatar_key IN THE SERVICE (the sync
 *    bootstrap ships those rows verbatim — signing only at the REST door left
 *    every sync-mode face a placeholder); the guests listing signs too.
 * C2 a project's name + icon are editable after creation (blank name rejected).
 * C3 the Items catalogue reaches invoices: ItemsService.list q-search feeds
 *    the editor's picker; a picked item's id round-trips onto the saved line
 *    and bumps usage_count/last_used_at (dead columns until now).
 * C4 ONE combined import file: a Type column decides contact vs lead per row,
 *    company_* columns build the contact's directory company, lead rows never
 *    create directory companies, undo retracts all three tables — including
 *    the legacy bug where a people-import's auto-created companies survived
 *    undo. The combined template auto-maps 100%.
 * C5 issues.update echoes the fresh row (the .returning() contract the
 *    flush-driven refetch relies on — no more guess-timer reverts).
 * C6 CTA latency guarantees: createInAppNotification never throws even when
 *    its DB layer does (house rule 6 enforced at source, so hot paths may
 *    detach it); leave approval writes its on-leave attendance days in one
 *    bulk insert (exactly N rows); the module-access guard context is cached
 *    ~60s and busted in-process on grant changes.
 * C7 issues are deletable from the UI: softDelete tombstones + publishes the
 *    sync ref, restore round-trips, and visibility still gates the door.
 *
 * Service-level against the real Postgres.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, gte, lte } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  membershipGrants,
  employees,
  leaveTypes,
  leaveRequests,
  attendanceRecords,
  leads,
  directoryPeople,
  directoryCompanies,
  invoiceLineItems,
  items as itemsTable,
  pmTeams,
  pmIssues,
  pmProjectMembers,
  domainEvents,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { ModuleAccessService } from '../core/auth/module-access.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmProjectsService } from '../modules/pm/projects.service';
import { PmGuestsService } from '../modules/pm/guests.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { ImportService } from '../modules/crm/import.service';
import { LeaveService } from '../modules/leave/leave.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { ItemsService } from '../modules/invoicing/items.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const visibility = new PmVisibilityService(dbSvc);
const mediaStub = { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never;
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility, mediaStub);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const projectsSvc = new PmProjectsService(dbSvc, audit, domainEventsSvc, visibility);
// list() never touches the members facade — only invite/revoke do.
const guestsSvc = new PmGuestsService(dbSvc, audit, domainEventsSvc, {} as never, mediaStub);
const imports = new ImportService(dbSvc, audit, { publish: jest.fn(async () => 'evt') } as never);
const moduleAccess = new ModuleAccessService(dbSvc, dbAdmin as never);

const configStub = { get: (_: string, fb?: unknown) => fb } as never;
const emailStub = { sendEmail: async () => true, createInAppNotification: async () => undefined } as never;
const customersSvc = new CustomersService(dbSvc, audit);
const itemsSvc = new ItemsService(dbSvc, audit);
const numbering = new NumberingService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, emailStub, orgFinancial, { publish: async () => null } as never);

let tenantId: string;
let ownerId: string;
let teamId: string;
const extraUsers: string[] = [];

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RC Studio ${rid()}`, slug: `rc-${rid()}-${Date.now()}`, status: 'active', currency: 'INR', state_code: 'KA' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rc-owner-${rid()}@t.test`, full_name: 'RC Owner', status: 'active' })
    .returning();
  ownerId = u!.id;
  await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: ownerId, role: 'owner', status: 'active' });
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

async function mintUser(role: 'owner' | 'admin' | 'manager' | 'employee' | 'guest', extra: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rc-${role}-${rid()}@t.test`, full_name: `RC ${role}`, status: 'active', ...extra })
    .returning();
  extraUsers.push(u!.id);
  const [m] = await dbAdmin
    .insert(memberships)
    .values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active' })
    .returning();
  return { userId: u!.id, membershipId: m!.id };
}

describe('C1 — avatars propagate into PM', () => {
  it('usersLite signs avatar_key in the service and drops the raw key', async () => {
    const key = `avatars/${rid()}_256.webp`;
    await dbAdmin.update(users).set({ avatar_key: key }).where(eq(users.id, ownerId));
    const rows = await teamsSvc.usersLite(tenantId, ownerId);
    const me = rows.find((r) => r.id === ownerId)!;
    expect(me.avatar_url).toBe(`signed:${key}`);
    expect('avatar_key' in me).toBe(false);
  });

  it('a member without any avatar stays null-safe', async () => {
    const plain = await mintUser('employee');
    const rows = await teamsSvc.usersLite(tenantId, ownerId);
    expect(rows.find((r) => r.id === plain.userId)!.avatar_url).toBeNull();
  });

  it('the guests listing serves a signed avatarUrl, never the raw key', async () => {
    const project = await projectsSvc.create(tenantId, ownerId, { name: `Guest proj ${rid()}`, lead_user_id: ownerId });
    const key = `avatars/${rid()}_256.webp`;
    const guest = await mintUser('guest', { avatar_key: key });
    await dbAdmin.insert(pmProjectMembers).values({ tenant_id: tenantId, project_id: project.data.id, user_id: guest.userId });
    const listing = await guestsSvc.list(tenantId, ownerId, 'owner', project.data.id);
    const row = listing.data.find((g) => g.userId === guest.userId)!;
    expect(row.avatarUrl).toBe(`signed:${key}`);
    expect('avatarKey' in row).toBe(false);
  });
});

describe('C2 — project name + icon editable after creation', () => {
  let projectId: string;

  beforeAll(async () => {
    const p = await projectsSvc.create(tenantId, ownerId, { name: `Razeen ${rid()}`, icon: '🤝' });
    projectId = p.data.id;
  });

  it('update persists {name, icon}', async () => {
    const res = await projectsSvc.update(tenantId, ownerId, projectId, { name: 'Razeen v2', icon: '🚀' });
    expect(res.data.name).toBe('Razeen v2');
    expect(res.data.icon).toBe('🚀');
  });

  it('a blank name is rejected, not silently written', async () => {
    await expect(projectsSvc.update(tenantId, ownerId, projectId, { name: '   ' })).rejects.toThrow(/name is required/i);
  });
});

describe('C3 — catalogue items reach invoice lines', () => {
  let itemId: string;
  let customerId: string;
  const itemName = `Retainer ${rid()}`;

  beforeAll(async () => {
    const item = await itemsSvc.create(
      { name: itemName, default_rate: '15000.00', unit: 'month', hsn_sac_code: '998314', default_gst_rate: '18' },
      ownerId,
      tenantId,
    );
    itemId = item.data.id;
    const customer = await customersSvc.create({ display_name: `Client ${rid()}`, state_code: 'KA' }, ownerId, tenantId);
    customerId = customer.data.id;
  });

  it('list(q) finds the item and ships the picker autofill fields', async () => {
    const res = await itemsSvc.list(tenantId, { q: itemName.slice(0, 8) });
    const row = res.data.find((i) => i.id === itemId)!;
    expect(row).toBeDefined();
    // The editor autofills from these — they must be on the wire.
    expect(row).toHaveProperty('cess_rate');
    expect(row).toHaveProperty('intl_tax_rate');
    expect(row.default_rate).toBe('15000.00');
  });

  it('a picked item_id round-trips onto the saved line and bumps usage stats', async () => {
    const inv = await invoicesSvc.create(
      {
        customer_id: customerId,
        invoice_date: '2026-08-01',
        due_date: '2026-08-31',
        line_items: [{ item_id: itemId, item_name: itemName, quantity: '1', rate: '15000.00', gst_rate: '18' }],
      },
      ownerId,
      tenantId,
    );
    const lines = await dbAdmin.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoice_id, inv.data.id));
    expect(lines[0]!.item_id).toBe(itemId);

    const [item] = await dbAdmin.select().from(itemsTable).where(eq(itemsTable.id, itemId));
    expect(item!.usage_count).toBe(1);
    expect(item!.last_used_at).not.toBeNull();
  });
});

describe('C4 — one combined import file (Type column + fallback)', () => {
  const tag = rid();
  const contactEmail = `priya@zc-${tag}.in`;
  const leadEmail = `asha@rp-${tag}.in`;
  const fallbackEmail = `vik@fb-${tag}.in`;
  const companyName = `Zeta Corp ${tag}`;
  const leadCompany = `Ripen ${tag}`;
  const HEADERS = 'Type,First Name,Last Name,Email,Phone,Job Title,Lead Source,Description,Company,Company Domain,Company Website,Company Industry,Company Phone,Company City,Company Country';
  const csv = [
    HEADERS,
    `Contact,Priya,Menon,${contactEmail},+91 98110 22334,Ops,,Met at SaaSBoomi,${companyName},zc-${tag}.in,https://zc-${tag}.in,Software,+91 44 2811 0000,Chennai,IN`,
    `Lead,Asha,Rao,${leadEmail},+91 98400 12345,,Website,Wants a demo,${leadCompany},,,,,,`,
    `,Vikram,Iyer,${fallbackEmail},,,,,,,,,,,`,
    `Robot,Bad,Type,bad@x-${tag}.in,,,,,,,,,,,`,
    `Contact,Priya,Dup,${contactEmail},,,,,,,,,,,`,
  ].join('\r\n');
  // The template's own headers — mapping is taken from parse() suggestions.
  let mapping: Record<string, string>;
  let batchId: string;

  it("the combined template auto-maps 100% (round B invariant, extended to 'all')", async () => {
    const tpl = imports.template('all');
    const parsed = imports.parse('all', tpl.data.csv, tpl.data.file_name);
    expect(parsed.data.headers.every((h) => h.suggested !== null)).toBe(true);
    // Company Phone must land on the company, not the person.
    expect(parsed.data.headers.find((h) => h.column === 'Company Phone')!.suggested).toBe('company_phone');
    expect(parsed.data.headers.find((h) => h.column === 'Type')!.suggested).toBe('type');
    mapping = Object.fromEntries(parsed.data.headers.map((h) => [h.column, h.suggested!]));
  });

  it('a mixed run: contact + full company, lead as text, fallback applies, bad Type errors, in-file dupe skipped', async () => {
    const res = await imports.run(tenantId, ownerId, 'all', csv, mapping, 'skip', 'combined.csv', 'contact');
    batchId = res.data.id;
    expect(res.data.rows_created).toBe(3); // Priya + Asha + Vikram(fallback contact)
    expect(res.data.rows_updated).toBe(0);
    expect(res.data.rows_skipped).toBe(2); // in-file dupe + Robot error
    expect((res.data.errors as Array<{ error: string }>)[0]!.error).toMatch(/unrecognized Type/i);

    const [person] = await dbAdmin.select().from(directoryPeople)
      .where(and(eq(directoryPeople.tenant_id, tenantId), eq(directoryPeople.email, contactEmail)));
    expect(person).toBeDefined();
    expect(person!.company_id).not.toBeNull();

    const [company] = await dbAdmin.select().from(directoryCompanies)
      .where(eq(directoryCompanies.id, person!.company_id!));
    expect(company!.name).toBe(companyName);
    expect(company!.domain).toBe(`zc-${tag}.in`);
    expect(company!.industry).toBe('Software');
    expect(company!.phone).toBe('+91 44 2811 0000');
    expect(company!.city).toBe('Chennai');
    expect(company!.country_code).toBe('IN');

    const [lead] = await dbAdmin.select().from(leads)
      .where(and(eq(leads.tenant_id, tenantId), eq(leads.email, leadEmail)));
    expect(lead).toBeDefined();
    expect(lead!.company_name).toBe(leadCompany);
    // Lead rows never create directory companies.
    const ripen = await dbAdmin.select().from(directoryCompanies)
      .where(and(eq(directoryCompanies.tenant_id, tenantId), eq(directoryCompanies.name, leadCompany)));
    expect(ripen).toHaveLength(0);

    // The blank-Type row became a contact (the wizard's fallback).
    const [vik] = await dbAdmin.select().from(directoryPeople)
      .where(and(eq(directoryPeople.tenant_id, tenantId), eq(directoryPeople.email, fallbackEmail)));
    expect(vik).toBeDefined();
  });

  it("fallback 'lead' routes Type-less rows to the leads queue", async () => {
    const solo = `solo@fb2-${tag}.in`;
    const miniCsv = `First Name,Email\r\nSolo,${solo}`;
    const parsed = imports.parse('all', miniCsv);
    const miniMap = Object.fromEntries(parsed.data.headers.map((h) => [h.column, h.suggested!]));
    await imports.run(tenantId, ownerId, 'all', miniCsv, miniMap, 'skip', 'mini.csv', 'lead');
    const found = await dbAdmin.select().from(leads).where(and(eq(leads.tenant_id, tenantId), eq(leads.email, solo)));
    expect(found).toHaveLength(1);
    const person = await dbAdmin.select().from(directoryPeople)
      .where(and(eq(directoryPeople.tenant_id, tenantId), eq(directoryPeople.email, solo)));
    expect(person).toHaveLength(0);
  });

  it("re-running the same file with 'skip' creates nothing", async () => {
    const res = await imports.run(tenantId, ownerId, 'all', csv, mapping, 'skip', 'combined.csv', 'contact');
    expect(res.data.rows_created).toBe(0);
    expect(res.data.rows_updated).toBe(0);
  });

  it("undo of an 'all' batch retracts people, companies AND leads", async () => {
    await imports.undo(tenantId, ownerId, batchId);
    const [person] = await dbAdmin.select().from(directoryPeople)
      .where(and(eq(directoryPeople.tenant_id, tenantId), eq(directoryPeople.email, contactEmail)));
    expect(person!.deleted_at).not.toBeNull();
    const zeta = await dbAdmin.select().from(directoryCompanies)
      .where(and(eq(directoryCompanies.tenant_id, tenantId), eq(directoryCompanies.name, companyName)));
    expect(zeta[0]!.deleted_at).not.toBeNull();
    const [lead] = await dbAdmin.select().from(leads)
      .where(and(eq(leads.tenant_id, tenantId), eq(leads.email, leadEmail)));
    expect(lead!.status).toBe('discarded');
  });

  it('LEGACY FIX — undoing a plain people import now retracts its auto-created companies', async () => {
    const email = `legacy@lg-${tag}.in`;
    const legacyCompany = `Legacy Co ${tag}`;
    const peopleCsv = `First Name,Email,Company\r\nLegacy,${email},${legacyCompany}`;
    const parsed = imports.parse('people', peopleCsv);
    const map = Object.fromEntries(parsed.data.headers.map((h) => [h.column, h.suggested!]));
    const res = await imports.run(tenantId, ownerId, 'people', peopleCsv, map, 'skip', 'legacy.csv');
    await imports.undo(tenantId, ownerId, res.data.id);
    const rows = await dbAdmin.select().from(directoryCompanies)
      .where(and(eq(directoryCompanies.tenant_id, tenantId), eq(directoryCompanies.name, legacyCompany)));
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe('C5 — issues.update echoes the fresh row', () => {
  it('the .returning() contract the flush-driven refetch relies on', async () => {
    const created = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Desc echo' });
    const res = await issuesSvc.update(tenantId, ownerId, created.data.id, { description: 'Typed, saved, and NOT reverted' });
    expect((res.data as { description?: string | null }).description).toBe('Typed, saved, and NOT reverted');
  });
});

describe('C6 — CTA latency guarantees', () => {
  it('createInAppNotification NEVER throws, even when its DB layer does', async () => {
    const bomb = () => { throw new Error('boom'); };
    const fragile = new NotificationsService(
      db as never,
      { insert: bomb, update: bomb, select: bomb } as never,
      new ConfigService(),
      emitter,
    );
    await expect(
      fragile.createInAppNotification(ownerId, 'test.unmapped', 'must not throw', null, tenantId),
    ).resolves.toBeUndefined();
  });

  it('leave approval writes its on-leave days in ONE bulk insert — exactly N rows', async () => {
    const seedEmployee = async (role: 'owner' | 'employee') => {
      const email = `rc-leave-${role}-${rid()}@t.test`;
      const [u] = await dbAdmin.insert(users).values({ email, full_name: `RC Leave ${role}`, status: 'active' }).returning();
      extraUsers.push(u!.id);
      const [e] = await dbAdmin
        .insert(employees)
        .values({ tenant_id: tenantId, employee_code: `EMP-${rid().toUpperCase()}`, first_name: 'RC', last_name: 'Leave', work_email: email, date_of_joining: '2026-01-01', user_id: u!.id })
        .returning();
      await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: u!.id, role, status: 'active', employee_id: e!.id });
      return { userId: u!.id, employeeId: e!.id };
    };
    // The reviewer needs an employee record of their own (reviewLeave resolves it).
    const reviewer = await seedEmployee('owner');
    const { employeeId } = await seedEmployee('employee');
    const e = { id: employeeId };
    const [lt] = await dbAdmin
      .insert(leaveTypes)
      .values({ tenant_id: tenantId, name: 'Casual Leave', code: `CL${rid().slice(0, 3)}`, default_quota_days: 12, is_active: true })
      .returning();
    // Mon 2026-10-05 → Fri 2026-10-09: five business days, no weekend inside.
    const [req] = await dbAdmin
      .insert(leaveRequests)
      .values({ tenant_id: tenantId, employee_id: e!.id, leave_type_id: lt!.id, start_date: '2026-10-05', end_date: '2026-10-09', total_days: 5, reason: 'RC fixture', status: 'pending' })
      .returning();

    const leaveSvc = new LeaveService(dbSvc, audit, { sendEmail: async () => true, createInAppNotification: async () => undefined } as never);
    await leaveSvc.reviewLeave(req!.id, reviewer.userId, tenantId, { action: 'approve' });

    const rows = await dbAdmin
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.tenant_id, tenantId),
          eq(attendanceRecords.employee_id, e!.id),
          gte(attendanceRecords.attendance_date, '2026-10-05'),
          lte(attendanceRecords.attendance_date, '2026-10-09'),
        ),
      );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.attendance_status === 'on_leave')).toBe(true);
  });

  it('module-access context is cached inside the TTL and busted on demand', async () => {
    const member = await mintUser('manager');
    const first = await moduleAccess.resolve(tenantId, member.membershipId, 'manager', 'crm');
    expect(first.level).toBe('edit'); // built-in default for managers

    // Revoke by writing the grant row DIRECTLY — the cache must mask it…
    await dbAdmin.insert(membershipGrants).values({ tenant_id: tenantId, membership_id: member.membershipId, module: 'crm', access_level: 'none', capabilities: {} });
    const cached = await moduleAccess.resolve(tenantId, member.membershipId, 'manager', 'crm');
    expect(cached.level).toBe('edit');

    // …until the in-process bust (what MembersService calls on every write).
    moduleAccess.invalidateMembership(tenantId, member.membershipId);
    const fresh = await moduleAccess.resolve(tenantId, member.membershipId, 'manager', 'crm');
    expect(fresh.level).toBe('none');
  });
});

describe('C7 — delete an issue (the round-20 machinery finally has a door)', () => {
  let issueId: string;

  it('softDelete tombstones the row and publishes the sync ref', async () => {
    const created = await issuesSvc.create(tenantId, ownerId, { team_id: teamId, title: 'Delete me' });
    issueId = created.data.id;
    await issuesSvc.softDelete(tenantId, ownerId, issueId);
    const [row] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issueId));
    expect(row!.deleted_at).not.toBeNull();

    const events = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'pm.issue.deleted')));
    const mine = events.find((e) => (e.payload as { issue_id?: string }).issue_id === issueId);
    expect(mine).toBeDefined();
    expect((mine!.payload as { sync: Array<{ t: string; id: string }> }).sync).toContainEqual({ t: 'pm_issues', id: issueId });
  });

  it('restore round-trips', async () => {
    await issuesSvc.restore(tenantId, ownerId, issueId);
    const [row] = await dbAdmin.select().from(pmIssues).where(eq(pmIssues.id, issueId));
    expect(row!.deleted_at).toBeNull();
  });

  it('an out-of-visibility guest cannot delete it', async () => {
    const guest = await mintUser('guest');
    await expect(issuesSvc.softDelete(tenantId, guest.userId, issueId)).rejects.toThrow();
  });
});
