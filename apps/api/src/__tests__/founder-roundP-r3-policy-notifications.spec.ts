/**
 * Founder round P — R3 (company policies), implementer A2: notifications +
 * data export + the module allowlists.
 *
 *   P4  'policy-published' / 'policy-reminder' email templates — subject
 *       "Please read and agree: <title>" / "Reminder: please agree to
 *       <title>", a "Read & agree" CTA pointing at the policies page, every
 *       interpolated value HTML-escaped, CR/LF stripped from the subject.
 *   P5  The individual export gains policy_acknowledgements.csv (policy
 *       title, version, acknowledged_at) and the org export gains
 *       policies.csv + policy_acknowledgements.csv — both read through the
 *       PoliciesPublicService facade, injected @Optional() so the export
 *       still builds when the module is absent (or throws).
 *   P2  'policies' is a managed module for Settings → Access and a
 *       FAM-toggleable module (enabled by default).
 *
 * Template half: the real NotificationsService, renderTemplate only (no
 * provider call). Export half: real Postgres per the house pattern — a fresh
 * tenant + user, R2 mocked to capture the ZIP, notifications/audit stubbed.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { validate } from 'class-validator';
import { db, dbAdmin } from '@flicks/db';
import { tenants, users, memberships } from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import JSZip from 'jszip';
import { DatabaseService } from '../core/database/database.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { DataExportService } from '../modules/consent/data-export.service';
import { MANAGED_MODULES, GRANT_MODULES, RoleDefaultInputDto } from '../modules/members/members.dto';
import { FamService } from '../modules/fam/fam.service';

jest.setTimeout(60_000);

const rid = () => crypto.randomBytes(4).toString('hex');

// ─── P4: templates (real service, private renderTemplate) ────────────────────

const APP_URL = 'https://app.test/'; // trailing slash on purpose — must not double up
const realNotifications = new NotificationsService(
  db as never,
  dbAdmin as never,
  new ConfigService({ NODE_ENV: 'test', RESEND_API_KEY: 're_test', APP_URL }),
  new EventEmitter2(),
);
type Rendered = { subject: string; html: string };
const render = (template: string, props: Record<string, unknown>): Rendered =>
  (
    realNotifications as unknown as {
      renderTemplate: (t: string, p: Record<string, unknown>) => Rendered;
    }
  ).renderTemplate(template, props);

const PROPS = {
  policyTitle: 'Leave & Attendance Policy 2026',
  companyName: 'Acme Pvt Ltd',
  link: '/policies',
};

describe('P4 — policy-published template', () => {
  it('subject is "Please read and agree: <title>" (plain text, ampersand untouched)', () => {
    expect(render('policy-published', PROPS).subject).toBe(
      'Please read and agree: Leave & Attendance Policy 2026',
    );
  });

  it('body names the company + policy and carries a "Read & agree" CTA to APP_URL + link', () => {
    const { html } = render('policy-published', PROPS);
    expect(html).toContain(
      '<strong>Acme Pvt Ltd</strong> published <strong>Leave &amp; Attendance Policy 2026</strong>',
    );
    expect(html).toContain('>Read &amp; agree</a>');
    expect(html).toContain('href="https://app.test/policies"');
    expect(html).not.toContain('app.test//policies');
    // Same button styling as the other app CTAs.
    expect(html).toContain('background: #3E7BFA; color: white; padding: 12px 24px;');
    // It is the publish flavour, not the nudge.
    expect(html).not.toMatch(/reminder/i);
  });

  it('falls back to "Your company" without a companyName and to /policies without a link', () => {
    const { html } = render('policy-published', { policyTitle: 'Code of Conduct' });
    expect(html).toContain('Your company published <strong>Code of Conduct</strong>');
    expect(html).toContain('href="https://app.test/policies"');
    expect(html).not.toContain('<strong></strong>');
  });
});

describe('P4 — policy-reminder template', () => {
  it('subject is "Reminder: please agree to <title>"', () => {
    expect(render('policy-reminder', PROPS).subject).toBe(
      'Reminder: please agree to Leave & Attendance Policy 2026',
    );
  });

  it('body reads as a reminder and carries the same "Read & agree" CTA', () => {
    const { html } = render('policy-reminder', PROPS);
    expect(html).toMatch(/This is a reminder that <strong>Leave &amp; Attendance Policy 2026<\/strong> from <strong>Acme Pvt Ltd<\/strong>/);
    expect(html).toContain('>Read &amp; agree</a>');
    expect(html).toContain('href="https://app.test/policies"');
    expect(html).not.toContain(' published ');
  });
});

describe('P4 — escaping + link handling (both templates)', () => {
  const EVIL = {
    policyTitle: '<script>alert(1)</script> & "Quotes" Policy',
    companyName: '<b>Evil</b> & Co',
    link: '/policies',
  };

  it.each(['policy-published', 'policy-reminder'])('%s HTML-escapes title and company', (t) => {
    const { html } = render(t, EVIL);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Quotes&quot; Policy');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it.each(['policy-published', 'policy-reminder'])('%s strips CR/LF/tabs from the subject (no header injection)', (t) => {
    const { subject } = render(t, { ...PROPS, policyTitle: 'Line one\r\nBcc: x@y.z\tLine two' });
    expect(subject).not.toMatch(/[\r\n\t]/);
    expect(subject).toContain('Line one Bcc: x@y.z Line two');
  });

  it('an absolute https link is used verbatim; a bare relative path gets a slash; quotes in a link are escaped', () => {
    expect(render('policy-published', { ...PROPS, link: 'https://custom.example/p/1' }).html).toContain(
      'href="https://custom.example/p/1"',
    );
    expect(render('policy-published', { ...PROPS, link: 'policies?x=1' }).html).toContain(
      'href="https://app.test/policies?x=1"',
    );
    const { html } = render('policy-published', { ...PROPS, link: '/policies" onmouseover="alert(1)' });
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('href="https://app.test/policies&quot; onmouseover=&quot;alert(1)"');
  });

  it('the template union accepts the two new names (compile-time) and sendEmail is preference-free for them', () => {
    // A transactional-style send: no userId/event → nothing can suppress it.
    // We only assert the call shape type-checks; delivery is a provider call
    // that the house tests never make.
    const svc = realNotifications;
    const ok: Parameters<typeof svc.sendEmail>[0][] = ['policy-published', 'policy-reminder'];
    expect(ok).toHaveLength(2);
  });
});

// ─── P2: allowlists ──────────────────────────────────────────────────────────

describe('P2 — policies is a managed module (Settings → Access) and FAM-toggleable', () => {
  it("members MANAGED_MODULES gains 'policies'; GRANT_MODULES (auditor scopes) does not", () => {
    expect(MANAGED_MODULES).toContain('policies');
    expect(GRANT_MODULES as readonly string[]).not.toContain('policies');
  });

  it('RoleDefaultInputDto validates module=policies', async () => {
    const dto = Object.assign(new RoleDefaultInputDto(), {
      role: 'manager',
      module: 'policies',
      access_level: 'edit',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("FamService enumerates 'policies' and ships it enabled by default", () => {
    const statics = FamService as unknown as {
      MANAGED_MODULES: string[];
      DEFAULT_ENABLED: Set<string>;
    };
    expect(statics.MANAGED_MODULES).toContain('policies');
    expect(statics.DEFAULT_ENABLED.has('policies')).toBe(true);
    // The existing kill-switch modules are untouched.
    expect(statics.MANAGED_MODULES).toEqual(expect.arrayContaining(['invoicing', 'crm', 'payroll', 'expenses']));
  });
});

// ─── P5: data export (real Postgres) ─────────────────────────────────────────

let tenantId: string;
let userId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({
      name: `RpPol${rid()}`,
      slug: `rppol-${rid()}-${Date.now()}`,
      status: 'trialing',
      state_code: 'KA',
    })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rppol-${rid()}@test.test`, full_name: 'RP Policy User', status: 'active' })
    .returning();
  userId = u!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: userId,
    role: 'owner',
    status: 'active',
  });
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, userId));
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

type Exporter = {
  buildMyExport: (u: string, t: string) => Promise<void>;
  buildOrgExport: (u: string, t: string) => Promise<void>;
};

/** A DataExportService with R2 mocked to capture the ZIP; facade optional. */
function makeExporter(policiesFacade?: unknown) {
  let captured: Buffer | null = null;
  const sent: Array<{ template: string; to: string }> = [];
  const r2Mock = {
    isConfigured: () => true,
    putObject: async (_k: string, buf: Buffer) => {
      captured = buf;
    },
    signedGetUrl: async () => 'https://signed.example/x.zip',
  } as never;
  const exporter = new DataExportService(
    dbAdmin as never,
    new DatabaseService(),
    r2Mock,
    { sendEmail: async (template: string, to: string) => { sent.push({ template, to }); return true; } } as never,
    { log: async () => {} } as never,
    { track: () => {} } as never,
    policiesFacade as never,
  ) as unknown as Exporter;
  return { exporter, zip: async () => JSZip.loadAsync(captured!), captured: () => captured, sent };
}

const ACKS = [
  { policy_title: 'Code of Conduct', version: 2, acknowledged_at: new Date('2026-10-01T10:00:00Z') },
  { policy_title: 'Leave, "Quoted" Policy', version: 1, acknowledged_at: new Date('2026-09-15T08:30:00Z') },
];

describe('P5 — individual export: policy_acknowledgements.csv', () => {
  it('includes the rows the facade returns (policy_title, version, acknowledged_at) in CSV + JSON', async () => {
    const exportForUser = jest.fn(async () => ACKS);
    const { exporter, zip, sent } = makeExporter({ exportForUser, exportForTenant: jest.fn() });
    await exporter.buildMyExport(userId, tenantId);

    expect(exportForUser).toHaveBeenCalledWith(tenantId, userId);
    const z = await zip();
    const csv = await z.file('policy_acknowledgements.csv')!.async('string');
    const lines = csv.replace(/^﻿/, '').split('\n');
    expect(lines[0]).toBe('policy_title,version,acknowledged_at');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Code of Conduct,2,2026-10-01T10:00:00.000Z');
    // CSV quoting of a title holding a comma + quotes.
    expect(lines[2]).toBe('"Leave, ""Quoted"" Policy",1,2026-09-15T08:30:00.000Z');

    const bundle = JSON.parse(await z.file('my-data.json')!.async('string'));
    expect(bundle.policy_acknowledgements).toHaveLength(2);
    expect(bundle.policy_acknowledgements[0].policy_title).toBe('Code of Conduct');
    // The rest of the bundle is intact.
    expect(bundle.profile.id).toBe(userId);
    expect(bundle.memberships).toHaveLength(1);
    expect(z.file('README.txt')).not.toBeNull();
    expect(await z.file('README.txt')!.async('string')).toContain('policy_acknowledgements.csv');
    expect(sent).toEqual([{ template: 'data-export-ready', to: expect.stringContaining('rppol-') }]);
  });

  it('still builds when the facade is absent (@Optional) — empty CSV + [] in JSON', async () => {
    const { exporter, zip, captured } = makeExporter(undefined);
    await exporter.buildMyExport(userId, tenantId);
    expect(captured()).not.toBeNull();
    const z = await zip();
    const csv = await z.file('policy_acknowledgements.csv')!.async('string');
    expect(csv.replace(/^﻿/, '')).toBe('');
    const bundle = JSON.parse(await z.file('my-data.json')!.async('string'));
    expect(bundle.policy_acknowledgements).toEqual([]);
  });

  it('still builds when the facade throws — the failure is logged, not fatal', async () => {
    const { exporter, zip } = makeExporter({
      exportForUser: async () => {
        throw new Error('policies table missing');
      },
    });
    await expect(exporter.buildMyExport(userId, tenantId)).resolves.toBeUndefined();
    const bundle = JSON.parse(await (await zip()).file('my-data.json')!.async('string'));
    expect(bundle.policy_acknowledgements).toEqual([]);
  });
});

describe('P5 — org export: policies.csv + policy_acknowledgements.csv', () => {
  const ORG = {
    policies: [
      { id: 'p1', title: 'Code of Conduct', kind: 'rich_text', version: 2, status: 'published', published_at: new Date('2026-09-01T00:00:00Z') },
      { id: 'p2', title: 'IT Security', kind: 'pdf', version: 1, status: 'draft', published_at: null },
    ],
    acknowledgements: [
      { policy_title: 'Code of Conduct', policy_version: 2, user_email: 'a@test.test', acknowledged_at: new Date('2026-09-02T00:00:00Z') },
    ],
  };

  it('writes csv/ + json/ files for both, next to the existing modules, and emails owners/admins', async () => {
    const exportForTenant = jest.fn(async () => ORG);
    const { exporter, zip, sent } = makeExporter({ exportForUser: jest.fn(), exportForTenant });
    await exporter.buildOrgExport(userId, tenantId);

    expect(exportForTenant).toHaveBeenCalledWith(tenantId);
    const z = await zip();
    for (const f of [
      'csv/policies.csv',
      'csv/policy_acknowledgements.csv',
      'json/policies.json',
      'json/policy_acknowledgements.json',
      // untouched neighbours
      'csv/employees.csv',
      'json/employees.json',
      'csv/pm_issues.csv',
      'README.txt',
    ]) {
      expect(z.file(f)).not.toBeNull();
    }
    const policiesCsv = (await z.file('csv/policies.csv')!.async('string')).replace(/^﻿/, '').split('\n');
    expect(policiesCsv[0]).toBe('id,title,kind,version,status,published_at');
    expect(policiesCsv[1]).toBe('p1,Code of Conduct,rich_text,2,published,2026-09-01T00:00:00.000Z');
    expect(policiesCsv[2]).toBe('p2,IT Security,pdf,1,draft,');
    const acksCsv = (await z.file('csv/policy_acknowledgements.csv')!.async('string')).replace(/^﻿/, '').split('\n');
    expect(acksCsv[0]).toBe('policy_title,policy_version,user_email,acknowledged_at');
    expect(acksCsv).toHaveLength(2);
    expect(JSON.parse(await z.file('json/policies.json')!.async('string'))).toHaveLength(2);
    // D17: owners + admins get the link — our seeded owner.
    expect(sent).toEqual([{ template: 'data-export-ready', to: expect.stringContaining('rppol-') }]);
  });

  it('still builds without the facade — both policy files present but empty', async () => {
    const { exporter, zip } = makeExporter(undefined);
    await exporter.buildOrgExport(userId, tenantId);
    const z = await zip();
    expect((await z.file('csv/policies.csv')!.async('string')).replace(/^﻿/, '')).toBe('');
    expect((await z.file('csv/policy_acknowledgements.csv')!.async('string')).replace(/^﻿/, '')).toBe('');
    expect(JSON.parse(await z.file('json/policies.json')!.async('string'))).toEqual([]);
  });

  it('tolerates a facade that returns a partial / malformed shape', async () => {
    const { exporter, zip } = makeExporter({ exportForTenant: async () => ({ policies: null }) });
    await exporter.buildOrgExport(userId, tenantId);
    const z = await zip();
    expect(JSON.parse(await z.file('json/policies.json')!.async('string'))).toEqual([]);
    expect(JSON.parse(await z.file('json/policy_acknowledgements.json')!.async('string'))).toEqual([]);
  });
});
