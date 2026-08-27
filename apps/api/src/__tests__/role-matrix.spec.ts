/**
 * End-to-end ROLE MATRIX verification (Sprint 10 sign-off).
 *
 * Exercises the real server-side authorization path — InvoicingGrantGuard +
 * MembersService grants + InvoicesService.create — for every role/grant
 * scenario the user asked about, especially: an onboarding auditor must NOT be
 * able to create invoices unless explicitly granted invoicing:edit.
 *
 * This is the source of truth; the web UI's useInvoicingAccess() mirrors it.
 */
import 'dotenv/config';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  membershipGrants,
} from '@flicks/db/schema';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../core/database/database.service';
import { InvoicingGrantGuard } from '../core/auth/guards/invoicing-grant.guard';
import { MembersService } from '../modules/members/members.service';
import { InvoicesService } from '../modules/invoicing/invoices.service';
import { NumberingService } from '../modules/invoicing/numbering.service';
import { CustomersService } from '../modules/invoicing/customers.service';
import { OrgFinancialService } from '../modules/org-financial/org-financial.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { GrantRequirement } from '../core/auth/decorators/require-grant.decorator';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '@flicks/shared/types';
import { ModuleAccessService } from '../core/auth/module-access.service';

const rid = () => Math.random().toString(36).slice(2, 8);
const audit = { log: async () => {} } as unknown as AuditService;
const notificationsStub = { sendEmail: async () => {} } as never;
const authStub = { issueInviteMagicLink: async () => 'http://x/verify?token=t' } as never;
const configStub = { get: (_k: string, f?: unknown) => f } as never;

const dbSvc = new DatabaseService();
const moduleAccess = new ModuleAccessService(dbSvc);
const members = new MembersService(dbSvc, dbAdmin as never, audit, notificationsStub, authStub, moduleAccess, { servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l) } as never);
const numbering = new NumberingService(dbSvc, audit);
const customers = new CustomersService(dbSvc, audit);
const orgFinancial = new OrgFinancialService(dbSvc, audit);
const domainEventsStub = { publish: async () => null } as never;
const invoicesSvc = new InvoicesService(dbSvc, audit, numbering, configStub, notificationsStub as never, orgFinancial, domainEventsStub);

/** Run the real guard for a requirement against a synthetic JWT. */
const guard = new InvoicingGrantGuard(
  { getAllAndOverride: () => guardReq } as never,
  dbSvc,
  audit,
  moduleAccess,
);
let guardReq: GrantRequirement;
const allows = async (req: GrantRequirement, user: Partial<JwtPayload>) => {
  guardReq = req;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
  try {
    return await guard.canActivate(ctx);
  } catch {
    return false;
  }
};

describe('Role matrix — who can do what in Invoicing (Sprint 10 sign-off)', () => {
  let tenantId: string;
  let ownerId: string;
  let ownerMembershipId: string;
  let auditorId: string;
  let auditorMembershipId: string;
  let managerId: string;
  let managerMembershipId: string;
  let customerId: string;

  const jwt = (sub: string, membershipId: string, role: string): Partial<JwtPayload> => ({
    sub, tenantId, membershipId, role: role as JwtPayload['role'], isPlatformAdmin: false,
  });
  const CREATE: GrantRequirement = { module: 'invoicing', level: 'edit' };
  const VIEW: GrantRequirement = { module: 'invoicing', level: 'view' };
  const SEND: GrantRequirement = { module: 'invoicing', level: 'edit', capability: 'send' };
  const RECORD: GrantRequirement = { module: 'invoicing', level: 'edit', capability: 'record_payment' };

  beforeAll(async () => {
    const [t] = await dbAdmin.insert(tenants).values({ name: `Matrix${rid()}`, slug: `mx-${rid()}-${Date.now()}`, status: 'active' }).returning();
    tenantId = t!.id;
    const [o] = await dbAdmin.insert(users).values({ email: `own-${rid()}@t.test`, full_name: 'Owner', status: 'active' }).returning();
    ownerId = o!.id;
    const [om] = await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: ownerId, role: 'owner', status: 'active' }).returning();
    ownerMembershipId = om!.id;
    const [mgr] = await dbAdmin.insert(users).values({ email: `mgr-${rid()}@t.test`, full_name: 'Manager', status: 'active' }).returning();
    managerId = mgr!.id;
    const [mm] = await dbAdmin.insert(memberships).values({ tenant_id: tenantId, user_id: managerId, role: 'manager', status: 'active' }).returning();
    managerMembershipId = mm!.id;
    const c = await customers.create({ display_name: 'Acme' }, ownerId, tenantId);
    customerId = c.data.id;
  });

  afterAll(async () => {
    await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
    for (const u of [ownerId, auditorId, managerId].filter(Boolean)) await dbAdmin.delete(users).where(eq(users.id, u));
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  it('OWNER (full access) can create invoices — and a real invoice is created', async () => {
    expect(await allows(CREATE, jwt(ownerId, ownerMembershipId, 'owner'))).toBe(true);
    const inv = await invoicesSvc.create(
      { customer_id: customerId, invoice_date: '2026-06-10', due_date: '2026-07-10', line_items: [{ item_name: 'Work', quantity: '1', rate: '1000', gst_rate: '18' }] },
      ownerId, tenantId,
    );
    expect(inv.data.invoice_number).toMatch(/^INV/);
    expect(inv.data.total_amount).toBe('1180.00');
  });

  it('AUDITOR onboarding (default review grants) can VIEW but CANNOT create — the reported bug', async () => {
    const res = await members.inviteAuditor({ email: `aud-${rid()}@firm.test` }, ownerId, tenantId);
    auditorId = res.data.membership.user_id;
    auditorMembershipId = res.data.membership.id;
    // Accept (a real session implies an active membership).
    await dbAdmin.update(memberships).set({ status: 'active', accepted_at: new Date() }).where(eq(memberships.id, auditorMembershipId));

    const aud = jwt(auditorId, auditorMembershipId, 'auditor');
    expect(await allows(VIEW, aud)).toBe(true);    // can view
    expect(await allows(CREATE, aud)).toBe(false); // CANNOT create  ← the fix
    expect(await allows(SEND, aud)).toBe(false);
    expect(await allows(RECORD, aud)).toBe(false);
  });

  it('AUDITOR granted invoicing:edit + send + record_payment can now create/send/record', async () => {
    await members.updateGrants(
      auditorMembershipId,
      { grants: [{ module: 'invoicing', access_level: 'edit', capabilities: { send: true, record_payment: true } }] },
      ownerId, tenantId,
    );
    const aud = jwt(auditorId, auditorMembershipId, 'auditor');
    expect(await allows(CREATE, aud)).toBe(true);
    expect(await allows(SEND, aud)).toBe(true);
    expect(await allows(RECORD, aud)).toBe(true);
    // A capability NOT granted is still denied.
    expect(await allows({ module: 'invoicing', level: 'edit', capability: 'manage_customers' }, aud)).toBe(false);
  });

  it('MANAGER with no grant cannot view or create; once Owner grants edit, they can', async () => {
    const mgr = jwt(managerId, managerMembershipId, 'manager');
    expect(await allows(VIEW, mgr)).toBe(false);
    expect(await allows(CREATE, mgr)).toBe(false);

    await members.updateGrants(
      managerMembershipId,
      { grants: [{ module: 'invoicing', access_level: 'edit', capabilities: {} }] },
      ownerId, tenantId,
    );
    expect(await allows(VIEW, mgr)).toBe(true);
    expect(await allows(CREATE, mgr)).toBe(true);
  });

  it('REVOKED auditor loses create access immediately even with grants still present', async () => {
    await dbAdmin.update(memberships).set({ status: 'deactivated' }).where(eq(memberships.id, auditorMembershipId));
    const grantsStillThere = await dbAdmin.select().from(membershipGrants).where(eq(membershipGrants.membership_id, auditorMembershipId));
    expect(grantsStillThere.length).toBeGreaterThan(0); // grants not deleted…
    expect(await allows(CREATE, jwt(auditorId, auditorMembershipId, 'auditor'))).toBe(false); // …but access is gone
  });
});
