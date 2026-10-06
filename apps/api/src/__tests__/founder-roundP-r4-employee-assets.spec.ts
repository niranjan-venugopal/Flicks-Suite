/**
 * Founder round P — R4 (company asset register), implementer A2: the
 * employees-module integration + the 'asset-assigned' email template.
 *
 *   Removal guard   removeEmployee refuses (409 ASSETS_ASSIGNED, message names
 *                   the tags) while the person still holds equipment — nothing
 *                   is deleted and the seat is untouched. Return the asset
 *                   first (People → Assets).
 *   Footprint       Every assignment ever made — open or returned — counts in
 *                   historyFootprint, so anyone with equipment history is
 *                   ARCHIVED (deleted_at), never hard-deleted; the register
 *                   keeps its trail.
 *   Preview         GET employees/:id/removal-preview carries `assets` (all
 *                   assignments) and `openAssets` [{ asset_tag, name }] so the
 *                   dialog can warn before the click.
 *   Untouched       A person with no equipment behaves exactly as round 21
 *                   left it: no history → real DELETE; the tenant predicate
 *                   keeps another workspace's rows out of the count.
 *   Template        'asset-assigned' — subject "You've been issued <name>
 *                   (<tag>)", body names the company / asset / issuer /
 *                   condition / notes, CTA "View my assets" → APP_URL +
 *                   '/assets/me' (absolute https used verbatim), every value
 *                   HTML-escaped, CR/LF stripped from the subject.
 *
 * Service-level against the real Postgres (assets + asset_assignments seeded
 * with dbAdmin), mirroring founder-round21.spec; the assets module's own
 * controller/service are exercised by their own spec — only public.ts and the
 * schema are depended on here.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  employees,
  assets,
  assetAssignments,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { EmployeesService } from '../modules/employees/employees.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { AuthService } from '../modules/auth/auth.service';
import type { MediaService } from '../modules/media/media.service';

jest.setTimeout(60_000);

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── Stubs ──────────────────────────────────────────────────────────────────
const auditLog = jest.fn(async (_dto: unknown) => undefined);
const audit = { log: auditLog } as unknown as AuditService;
const notifications = {
  createInAppNotification: async () => undefined,
  sendEmail: async () => true,
} as unknown as NotificationsService;
const emitter = new EventEmitter2();
const dbSvc = new DatabaseService();
const mediaStub = {
  servedUrl: async (k: string | null, l: string | null) => (k ? `signed:${k}` : l),
} as unknown as MediaService;

const employeesService = new EmployeesService(
  dbSvc,
  dbAdmin as never,
  audit,
  notifications,
  emitter,
  new ConfigService({ NODE_ENV: 'test' }),
  {} as unknown as AuthService,
  mediaStub,
);

// ─── Fixtures ───────────────────────────────────────────────────────────────
let tenantId: string;
let ownerUserId: string;
const trackedTenants: string[] = [];
const trackedUsers: string[] = [];

async function mkTenant(label: string) {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RP4 ${label} ${rid()}`, slug: `rp4-${label}-${rid()}-${Date.now()}`, status: 'active' })
    .returning();
  trackedTenants.push(t!.id);
  return t!.id;
}

async function seedUser(label: string) {
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rp4-${label}-${rid()}@t.test`, full_name: `RP4 ${label}`, status: 'active' })
    .returning();
  trackedUsers.push(u!.id);
  return u!.id;
}

/** An active employee with their own user and an active `employee` seat. */
async function seedEmployee(
  label: string,
  opts: { role?: 'owner' | 'admin' | 'employee'; tid?: string } = {},
) {
  const tid = opts.tid ?? tenantId;
  const userId = await seedUser(label);
  const [emp] = await dbAdmin
    .insert(employees)
    .values({
      tenant_id: tid,
      user_id: userId,
      employee_code: `E-${rid()}`,
      first_name: label,
      last_name: 'Seed',
      work_email: `rp4-${label}-${rid()}@t.test`,
      date_of_joining: '2025-01-01',
      status: 'active',
    })
    .returning();
  const [m] = await dbAdmin
    .insert(memberships)
    .values({
      tenant_id: tid,
      user_id: userId,
      role: opts.role ?? 'employee',
      status: 'active',
      employee_id: emp!.id,
      accepted_at: new Date(),
    })
    .returning();
  return { id: emp!.id, userId, membershipId: m!.id, name: `${label} Seed` };
}

async function seedAsset(
  tag: string,
  name: string,
  opts: { status?: string; deleted?: boolean; tid?: string } = {},
) {
  const [a] = await dbAdmin
    .insert(assets)
    .values({
      tenant_id: opts.tid ?? tenantId,
      asset_tag: tag,
      name,
      category: 'laptop',
      status: opts.status ?? 'in_stock',
      created_by: ownerUserId,
      ...(opts.deleted ? { deleted_at: new Date() } : {}),
    })
    .returning();
  return a!.id;
}

async function assign(
  assetId: string,
  employeeId: string,
  opts: { returned?: boolean; tid?: string } = {},
) {
  const [row] = await dbAdmin
    .insert(assetAssignments)
    .values({
      tenant_id: opts.tid ?? tenantId,
      asset_id: assetId,
      employee_id: employeeId,
      assigned_by: ownerUserId,
      issue_condition: 'good',
      ...(opts.returned
        ? { returned_at: new Date(), returned_by: ownerUserId, return_condition: 'good' }
        : {}),
    })
    .returning();
  return row!.id;
}

const empRow = async (id: string) => {
  const [row] = await dbAdmin.select().from(employees).where(eq(employees.id, id));
  return row ?? null;
};
const seatRow = async (membershipId: string) => {
  const [m] = await dbAdmin.select().from(memberships).where(eq(memberships.id, membershipId));
  return m ?? null;
};
const assignmentRows = (employeeId: string) =>
  dbAdmin.select().from(assetAssignments).where(eq(assetAssignments.employee_id, employeeId));
const auditCalls = () =>
  auditLog.mock.calls.map((c) => c[0] as { action: string; metadata?: Record<string, unknown> });

beforeAll(async () => {
  tenantId = await mkTenant('a');
  const owner = await seedEmployee('owner', { role: 'owner' });
  ownerUserId = owner.userId;
});

afterAll(async () => {
  // Deleting the tenant cascades employees, memberships, assets, assignments.
  for (const t of trackedTenants) await dbAdmin.delete(tenants).where(eq(tenants.id, t));
  for (const id of trackedUsers) await dbAdmin.delete(users).where(eq(users.id, id));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.().catch(() => {});
});

beforeEach(() => {
  auditLog.mockClear();
});

// ─── Removal guard ──────────────────────────────────────────────────────────

describe('R4 — removal is refused while the person still holds equipment', () => {
  it('409 ASSETS_ASSIGNED naming the tag; nothing deleted, seat untouched, assignment still open', async () => {
    const emp = await seedEmployee('holder');
    const tag = `AST-${rid()}`;
    const assetId = await seedAsset(tag, 'MacBook Pro 14', { status: 'assigned' });
    await assign(assetId, emp.id);

    const err = await employeesService
      .removeEmployee(emp.id, tenantId, ownerUserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ASSETS_ASSIGNED' });
    const message = (err as ConflictException).message;
    expect(message).toContain(`${emp.name} still holds 1 asset (${tag})`);
    expect(message).toMatch(/record their return in People → Assets first/);

    // Nothing moved: the row is live, the seat is active and still linked,
    // the assignment is still open, and no removal audit was written.
    expect(await empRow(emp.id)).toMatchObject({ deleted_at: null, status: 'active' });
    expect(await seatRow(emp.membershipId)).toMatchObject({ status: 'active', employee_id: emp.id });
    const rows = await assignmentRows(emp.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.returned_at).toBeNull();
    // Each action asserted on its own — a negated arrayContaining would pass
    // as long as EITHER one was missing.
    const actions = auditCalls().map((c) => c.action);
    expect(actions).not.toContain('employee.deleted');
    expect(actions).not.toContain('employee.archived');
  });

  it('several open assets → plural wording and every tag listed', async () => {
    const emp = await seedEmployee('two');
    const tagA = `AST-${rid()}`;
    const tagB = `AST-${rid()}`;
    await assign(await seedAsset(tagA, 'Phone', { status: 'assigned' }), emp.id);
    await assign(await seedAsset(tagB, 'SIM card', { status: 'assigned' }), emp.id);

    const err = await employeesService
      .removeEmployee(emp.id, tenantId, ownerUserId)
      .catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ASSETS_ASSIGNED' });
    const message = (err as ConflictException).message;
    expect(message).toContain('still holds 2 assets (');
    expect(message).toContain(tagA);
    expect(message).toContain(tagB);
  });

  it('the removal preview reports assets + openAssets so the dialog can warn before the click', async () => {
    const emp = await seedEmployee('preview');
    const tag = `AST-${rid()}`;
    await assign(await seedAsset(tag, 'ThinkPad X1', { status: 'assigned' }), emp.id);

    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data).toMatchObject({
      name: emp.name,
      // Equipment history alone makes them an archive, not a delete.
      mode: 'archive',
      attendance: 0,
      punches: 0,
      leave: 0,
      timesheets: 0,
      documents: 0,
      historyRows: 0,
      assets: 1,
      total: 1,
      openAssets: [{ asset_tag: tag, name: 'ThinkPad X1' }],
    });
  });
});

// ─── Returned equipment is history ──────────────────────────────────────────

describe('R4 — returned equipment is history: archive, never hard-delete', () => {
  it('once the return is recorded, removal ARCHIVES and the assignment row survives', async () => {
    const emp = await seedEmployee('returned');
    const tag = `AST-${rid()}`;
    const assetId = await seedAsset(tag, 'Dell Monitor');
    const assignmentId = await assign(assetId, emp.id, { returned: true });

    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data).toMatchObject({ mode: 'archive', assets: 1, total: 1, openAssets: [] });

    const res = await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    expect(res.data).toEqual({ id: emp.id, mode: 'archive', name: emp.name, kept: 1 });

    // Row kept and stamped; the seat is revoked + unlinked as before.
    const row = await empRow(emp.id);
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    expect(await seatRow(emp.membershipId)).toMatchObject({ status: 'deactivated', employee_id: null });
    // The whole point: the register keeps its trail.
    const rows = await assignmentRows(emp.id);
    expect(rows.map((r) => r.id)).toEqual([assignmentId]);
    expect(rows[0]!.returned_at).not.toBeNull();
    const [asset] = await dbAdmin.select().from(assets).where(eq(assets.id, assetId));
    expect(asset).toBeDefined();

    const archived = auditCalls().find((c) => c.action === 'employee.archived');
    expect(archived?.metadata).toMatchObject({ name: emp.name, assets: 1, total: 1 });
  });

  it('an open assignment on a soft-deleted asset no longer blocks, but still counts as history', async () => {
    const emp = await seedEmployee('ghost-asset');
    const assetId = await seedAsset(`AST-${rid()}`, 'Retired laptop', { deleted: true });
    await assign(assetId, emp.id);

    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data).toMatchObject({ mode: 'archive', assets: 1, openAssets: [] });

    const res = await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    expect(res.data.mode).toBe('archive');
    expect((await empRow(emp.id))!.deleted_at).not.toBeNull();
    expect(await assignmentRows(emp.id)).toHaveLength(1);
  });
});

// ─── No equipment: round 21 untouched ───────────────────────────────────────

describe('R4 — a person with no equipment behaves exactly as before', () => {
  it('no history at all → preview says delete (assets 0, openAssets []) and removal really deletes', async () => {
    const emp = await seedEmployee('mistake');

    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data).toEqual({
      mode: 'delete',
      name: emp.name,
      attendance: 0,
      punches: 0,
      leave: 0,
      timesheets: 0,
      documents: 0,
      historyRows: 0,
      assets: 0,
      total: 0,
      openAssets: [],
    });

    const res = await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    expect(res.data).toEqual({ id: emp.id, mode: 'delete', name: emp.name, kept: 0 });
    expect(await empRow(emp.id)).toBeNull();
    expect(await seatRow(emp.membershipId)).toMatchObject({ status: 'deactivated', employee_id: null });
    const deleted = auditCalls().find((c) => c.action === 'employee.deleted');
    expect(deleted?.metadata).toMatchObject({ assets: 0, total: 0 });
  });

  it("another workspace's assignment row pointing at this employee never counts (explicit tenant predicate)", async () => {
    // A bare FK would accept it (rule 2): an assignment row in tenant B that
    // names an employee of tenant A. Neither the guard nor the footprint may
    // see it from tenant A.
    const tidB = await mkTenant('b');
    const emp = await seedEmployee('cross');
    const foreignAsset = await seedAsset(`AST-${rid()}`, 'Foreign laptop', { status: 'assigned', tid: tidB });
    await assign(foreignAsset, emp.id, { tid: tidB });

    const preview = await employeesService.previewRemoval(emp.id, tenantId);
    expect(preview.data).toMatchObject({ mode: 'delete', assets: 0, total: 0, openAssets: [] });

    const res = await employeesService.removeEmployee(emp.id, tenantId, ownerUserId);
    expect(res.data.mode).toBe('delete');
    expect(await empRow(emp.id)).toBeNull();
  });
});

// ─── 'asset-assigned' email template ────────────────────────────────────────

const APP_URL = 'https://app.test/'; // trailing slash on purpose — must not double up
const realNotifications = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService({ NODE_ENV: 'test', RESEND_API_KEY: 're_test', APP_URL }),
  new EventEmitter2(),
);
type Rendered = { subject: string; html: string };
const render = (props: Record<string, unknown>): Rendered =>
  (
    realNotifications as unknown as {
      renderTemplate: (t: string, p: Record<string, unknown>) => Rendered;
    }
  ).renderTemplate('asset-assigned', props);

const PROPS = {
  assetName: 'MacBook Pro 14',
  assetTag: 'AST-0007',
  companyName: 'Acme Pvt Ltd',
  link: '/assets/me',
  issuedBy: 'Priya HR',
  issueCondition: 'good',
  notes: 'Charger & sleeve included',
};

describe('R4 — asset-assigned template', () => {
  it('subject is "You\'ve been issued <name> (<tag>)" (plain text)', () => {
    expect(render(PROPS).subject).toBe("You've been issued MacBook Pro 14 (AST-0007)");
  });

  it('body leads with the issuer (company in brackets), names asset, condition and notes, with a "View my assets" CTA to APP_URL + link', () => {
    const { html } = render(PROPS);
    expect(html).toContain(
      '<p>Priya HR (Acme Pvt Ltd) issued you <strong>MacBook Pro 14</strong> (AST-0007) in <strong>good</strong> condition.</p>',
    );
    expect(html).toContain('<strong>Notes:</strong> Charger &amp; sleeve included');
    expect(html).toContain('>View my assets</a>');
    expect(html).toContain('href="https://app.test/assets/me"');
    expect(html).not.toContain('app.test//assets');
    // Same button styling as the other app CTAs.
    expect(html).toContain('background: #3E7BFA; color: white; padding: 12px 24px;');
    // The fallback line carries the real link as text — owners/HR admins have
    // no "My assets" sidebar item, so "open it from the sidebar" would be a
    // dead end for them.
    expect(html).toContain(
      'If the button doesn\'t work, sign in to Flicks Suite and open <a href="https://app.test/assets/me" style="color: #3E7BFA;">https://app.test/assets/me</a>.',
    );
    expect(html).not.toContain('from the sidebar');
  });

  it('optional parts drop out cleanly: no company → "Your company"; no issuer / condition / notes → no dangling text; link defaults to People → Assets (my view)', () => {
    const { subject, html } = render({ assetName: 'ID card', assetTag: 'AST-0010' });
    expect(subject).toBe("You've been issued ID card (AST-0010)");
    expect(html).toContain('<p>Your company issued you <strong>ID card</strong> (AST-0010).</p>');
    expect(html).not.toContain(' in <strong>');
    expect(html).not.toContain('</strong> condition');
    expect(html).not.toContain('Notes:');
    expect(html).not.toContain('<strong></strong>');
    expect(html).not.toContain('()');
    expect(html).toContain('href="https://app.test/employees/assets?view=me"');
  });

  it('company without issuer → bold company; issuer without company → bare issuer', () => {
    expect(render({ ...PROPS, issuedBy: null }).html).toContain(
      '<p><strong>Acme Pvt Ltd</strong> issued you <strong>MacBook Pro 14</strong> (AST-0007) in <strong>good</strong> condition.</p>',
    );
    const { html } = render({ ...PROPS, companyName: null });
    expect(html).toContain(
      '<p>Priya HR issued you <strong>MacBook Pro 14</strong> (AST-0007) in <strong>good</strong> condition.</p>',
    );
    expect(html).not.toContain('Priya HR (');
  });

  it('an absolute https link is used verbatim; a bare relative path gets a slash; quotes in a link are escaped', () => {
    expect(render({ ...PROPS, link: 'https://custom.example/my-assets' }).html).toContain(
      'href="https://custom.example/my-assets"',
    );
    expect(render({ ...PROPS, link: 'assets/me?x=1' }).html).toContain('href="https://app.test/assets/me?x=1"');
    const { html } = render({ ...PROPS, link: '/assets/me" onmouseover="alert(1)' });
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('href="https://app.test/assets/me&quot; onmouseover=&quot;alert(1)"');
    // The fallback prints the href as text too — escaped there as well.
    expect(html).toContain('>https://app.test/assets/me&quot; onmouseover=&quot;alert(1)</a>');
  });

  it('HTML-escapes every interpolated value (a name with <script> is neutralised)', () => {
    const { html } = render({
      ...PROPS,
      assetName: '<script>alert(1)</script> & "Laptop"',
      assetTag: 'AST-<img src=x>',
      companyName: '<b>Evil</b> & Co',
      issuedBy: '<i>Mallory</i>',
      issueCondition: '<u>good</u>',
      notes: 'Return by <Friday> & sign',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).not.toContain('<i>Mallory</i>');
    expect(html).not.toContain('<u>good</u>');
    expect(html).not.toContain('<Friday>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Laptop&quot;');
    expect(html).toContain('(AST-&lt;img src=x&gt;)');
    expect(html).toContain('<p>&lt;i&gt;Mallory&lt;/i&gt; (&lt;b&gt;Evil&lt;/b&gt; &amp; Co) issued you');
    expect(html).toContain('in <strong>&lt;u&gt;good&lt;/u&gt;</strong> condition');
    expect(html).toContain('Return by &lt;Friday&gt; &amp; sign');
  });

  it('strips CR/LF/tabs from the subject (no header injection)', () => {
    const { subject } = render({ ...PROPS, assetName: 'Line one\r\nBcc: x@y.z\tLine two' });
    expect(subject).not.toMatch(/[\r\n\t]/);
    expect(subject).toBe("You've been issued Line one Bcc: x@y.z Line two (AST-0007)");
  });

  it('the template union accepts the new name (compile-time) — the assets service calls it by name', () => {
    const ok: Parameters<typeof realNotifications.sendEmail>[0][] = ['asset-assigned'];
    expect(ok).toHaveLength(1);
  });
});
