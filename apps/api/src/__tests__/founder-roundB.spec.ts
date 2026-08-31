/**
 * Founder round B — the two feature builds that followed the bug clearance.
 *
 * B1 "exactly like linear": the composer sends everything at create — the
 *    one missing backend piece was labels, so issues.create now accepts
 *    label_ids (validated like setLabels) and names the label scope in its
 *    event refs.
 *
 * B2 CRM import to Zoho/HubSpot parity:
 *    - LEADS ARE FINALLY DEDUPED — the plan branch simply returned 'create'
 *      unconditionally, so the Step-3 strategy screen was a no-op for the
 *      most-imported entity and re-uploading a file doubled every lead.
 *    - Within-file duplicates are skipped (first row wins), like both
 *      competitors.
 *    - Downloadable per-entity templates whose headers auto-map 100%.
 *
 * Service-level against the real Postgres.
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
  leads,
  pmTeams,
  pmLabels,
  pmIssueLabels,
  domainEvents,
} from '@flicks/db/schema';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { DomainEventsService } from '../core/events/domain-events.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { PmTeamsService } from '../modules/pm/teams.service';
import { PmIssuesService } from '../modules/pm/issues.service';
import { PmVisibilityService } from '../modules/pm/sync/visibility.service';
import { ImportService, type ImportObject } from '../modules/crm/import.service';

const rid = () => crypto.randomBytes(4).toString('hex');
const dbSvc = new DatabaseService();
const audit = new AuditService(db as never, dbAdmin as never, dbSvc);
const emitter = new EventEmitter2();
const domainEventsSvc = new DomainEventsService(dbAdmin as never, emitter);
const notificationsSvc = new NotificationsService(db as never, dbAdmin as never, new ConfigService(), emitter);
const visibility = new PmVisibilityService(dbSvc);
const teamsSvc = new PmTeamsService(dbSvc, audit, domainEventsSvc, visibility);
const issuesSvc = new PmIssuesService(dbSvc, audit, domainEventsSvc, notificationsSvc, visibility);
const imports = new ImportService(dbSvc, audit, { publish: jest.fn(async () => 'evt') } as never);

let tenantId: string;
let ownerId: string;
let teamId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `RB Studio ${rid()}`, slug: `rb-${rid()}-${Date.now()}`, status: 'active', currency: 'INR' })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `rb-owner-${rid()}@t.test`, full_name: 'RB Owner', status: 'active' })
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
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('B1 — labels land at create time', () => {
  let labelA: string;
  let labelB: string;

  beforeAll(async () => {
    const mk = async (name: string, team_id: string | null) => {
      const [l] = await dbAdmin
        .insert(pmLabels)
        .values({ tenant_id: tenantId, name: `${name} ${rid()}`, color: '#3E7BFA', team_id })
        .returning();
      return l!.id;
    };
    labelA = await mk('Bug', null); // workspace label
    labelB = await mk('Perf', teamId); // this team's label
  });

  it('issues.create writes the pm_issue_labels rows and names the scope in its refs', async () => {
    const res = await issuesSvc.create(tenantId, ownerId, {
      team_id: teamId,
      title: 'Composer-born with labels',
      label_ids: [labelA, labelB],
    });
    const rows = await dbAdmin
      .select()
      .from(pmIssueLabels)
      .where(eq(pmIssueLabels.issue_id, res.data.id));
    expect(rows.map((r) => r.label_id).sort()).toEqual([labelA, labelB].sort());

    const events = await dbAdmin
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.tenant_id, tenantId), eq(domainEvents.event_name, 'pm.issue.created')));
    const mine = events.find((e) => (e.payload as { issue_id?: string }).issue_id === res.data.id);
    const refs = (mine!.payload as { sync: Array<{ t: string; id: string }> }).sync;
    expect(refs).toContainEqual({ t: 'pm_issue_labels', id: res.data.id });
  });

  it('a foreign label id fails the whole create', async () => {
    await expect(
      issuesSvc.create(tenantId, ownerId, {
        team_id: teamId,
        title: 'Bad label',
        label_ids: [crypto.randomUUID()],
      }),
    ).rejects.toThrow(/label does not belong/i);
  });

  it('due date at create persists (composer field)', async () => {
    const res = await issuesSvc.create(tenantId, ownerId, {
      team_id: teamId,
      title: 'Dated',
      due_date: '2026-10-01',
    });
    expect(res.data.due_date).toBe('2026-10-01');
  });
});

describe('B2 — leads are deduped like contacts always were', () => {
  const leadsCsv = (rows: string[]) =>
    ['First Name,Last Name,Email,Company', ...rows].join('\n');
  const mapping = { 'First Name': 'first_name', 'Last Name': 'last_name', Email: 'email', Company: 'company_name' };

  it('re-importing the same file with "update" updates instead of doubling', async () => {
    const email = `lead-${rid()}@dedupe.test`;
    const first = await imports.run(
      tenantId, ownerId, 'leads',
      leadsCsv([`Asha,Rao,${email},Ripen Labs`]),
      mapping, 'update', 'leads-1.csv',
    );
    expect(first.data.rows_created).toBe(1);

    const second = await imports.run(
      tenantId, ownerId, 'leads',
      leadsCsv([`Asha,RENAMED,${email},Ripen Labs`]),
      mapping, 'update', 'leads-2.csv',
    );
    expect(second.data.rows_created).toBe(0);
    expect(second.data.rows_updated).toBe(1);

    const rows = await dbAdmin
      .select()
      .from(leads)
      .where(and(eq(leads.tenant_id, tenantId), eq(leads.email, email)));
    expect(rows).toHaveLength(1); // the founder's users used to get 2 here
    expect(rows[0]!.last_name).toBe('RENAMED');
  });

  it('"skip" skips a matching lead', async () => {
    const email = `lead-${rid()}@skip.test`;
    await imports.run(tenantId, ownerId, 'leads', leadsCsv([`Vik,Iyer,${email},Meridian`]), mapping, 'skip');
    const again = await imports.run(tenantId, ownerId, 'leads', leadsCsv([`Vik,Iyer,${email},Meridian`]), mapping, 'skip');
    expect(again.data.rows_created).toBe(0);
    expect(again.data.rows_skipped).toBe(1);
  });

  it('duplicate rows inside ONE file collapse to a single create', async () => {
    const email = `lead-${rid()}@infile.test`;
    const res = await imports.run(
      tenantId, ownerId, 'leads',
      leadsCsv([`Nia,One,${email},A`, `Nia,Two,${email},B`, `Nia,Three,${email},C`]),
      mapping, 'update',
    );
    expect(res.data.rows_created).toBe(1);
    expect(res.data.rows_skipped).toBe(2);
    const rows = await dbAdmin
      .select()
      .from(leads)
      .where(and(eq(leads.tenant_id, tenantId), eq(leads.email, email)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_name).toBe('One'); // first row wins
  });

  it('a discarded lead does not block a fresh import of the same email', async () => {
    const email = `lead-${rid()}@back.test`;
    await imports.run(tenantId, ownerId, 'leads', leadsCsv([`Old,Gone,${email},X`]), mapping, 'update');
    await dbAdmin
      .update(leads)
      .set({ status: 'discarded' })
      .where(and(eq(leads.tenant_id, tenantId), eq(leads.email, email)));
    const res = await imports.run(tenantId, ownerId, 'leads', leadsCsv([`New,Again,${email},Y`]), mapping, 'update');
    expect(res.data.rows_created).toBe(1);
  });
});

describe('B2 — templates auto-map 100%', () => {
  it.each(['leads', 'people', 'companies'] as ImportObject[])('%s template maps every column', (object) => {
    const t = imports.template(object);
    expect(t.data.file_name).toContain(object);
    const parsed = imports.parse(object, t.data.csv, t.data.file_name);
    for (const h of parsed.data.headers) {
      expect({ column: h.column, suggested: h.suggested }).toEqual({ column: h.column, suggested: expect.any(String) });
    }
  });
});
