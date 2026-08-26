/**
 * Founder round 9 — CRM cleanup + coupon hygiene.
 *
 *  1. Leads and web forms are finally deletable (soft, like the rest of CRM):
 *     deleted rows leave every list and count, a deleted form's public token
 *     dies while its submissions/leads are kept, and its NAME is freed for
 *     reuse (the unique index went partial in migration 0053).
 *  2. Activities can be cleared in bulk: purge-preview counts what an
 *     "older than N days" purge would remove, the purge soft-deletes
 *     set-based in one tenant tx, audits the count, and recomputes the
 *     touched deals' next/last-activity stamps.
 *  3. Coupons: sequential minting is rejected outright (guessable sequences —
 *     the FOUNDER-002..050 lesson), and a FAM delete removes unredeemed codes
 *     while redeemed ones 409 (their redemption ledger is history).
 *
 * Service-level against the real Postgres, mirroring founder-round8.spec.ts.
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { dbAdmin } from '@flicks/db';
import {
  tenants,
  users,
  memberships,
  leads,
  webForms,
  activities,
  deals,
  pipelines,
  pipelineStages,
  couponCodes,
  couponRedemptions,
} from '@flicks/db/schema';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { LeadsService } from '../modules/crm/leads.service';
import { FormsService } from '../modules/crm/forms.service';
import { ActivitiesService } from '../modules/crm/activities.service';
import { FamBillingService } from '../modules/billing/fam-billing.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { DealsService } from '../modules/crm/deals.service';

const rid = () => crypto.randomBytes(4).toString('hex');

const auditLog = jest.fn(async () => {});
const audit = { log: auditLog, logPlatform: jest.fn(async () => {}) } as unknown as AuditService;
const eventsStub = { publish: async () => null };
const notifyStub = { createInAppNotification: async () => undefined, sendEmail: async () => true };
const presenceStub = { statusOf: async () => 'available' };
const configStub = { get: (k: string) => (k === 'JWT_SECRET' ? 'testsecret' : undefined) } as never;

const dbSvc = new DatabaseService();
const activitiesSvc = new ActivitiesService(
  dbSvc,
  audit,
  eventsStub as never,
  notifyStub as never,
  presenceStub as never,
);
// Round-9 surfaces under test never touch DealsService — a stub keeps the
// construction light (the convert() path has its own suite).
const leadsSvc = new LeadsService(dbSvc, audit, eventsStub as never, presenceStub as never, {} as DealsService);
const formsSvc = new FormsService(
  dbSvc,
  dbAdmin as never,
  audit,
  eventsStub as never,
  notifyStub as never,
  leadsSvc,
  activitiesSvc,
  configStub,
);
const famBilling = new FamBillingService(dbAdmin as never, audit);

let tenantId: string;
let ownerUserId: string;
let dealId: string;

beforeAll(async () => {
  const [t] = await dbAdmin
    .insert(tenants)
    .values({ name: `R9 ${rid()}`, slug: `r9-${rid()}` })
    .returning();
  tenantId = t!.id;
  const [u] = await dbAdmin
    .insert(users)
    .values({ email: `r9-owner-${rid()}@t.test`, full_name: 'R9 Owner' })
    .returning();
  ownerUserId = u!.id;
  await dbAdmin.insert(memberships).values({
    tenant_id: tenantId,
    user_id: ownerUserId,
    role: 'owner',
    status: 'active',
  });

  // A deal to hang activities on, so the purge's stamp recompute is real.
  const [pl] = await dbAdmin
    .insert(pipelines)
    .values({ tenant_id: tenantId, name: 'Default', is_default: true })
    .returning();
  const [st] = await dbAdmin
    .insert(pipelineStages)
    .values({ tenant_id: tenantId, pipeline_id: pl!.id, name: 'New', display_order: 1, win_probability: 10 })
    .returning();
  const [d] = await dbAdmin
    .insert(deals)
    .values({
      tenant_id: tenantId,
      pipeline_id: pl!.id,
      stage_id: st!.id,
      title: 'R9 deal',
      value_amount: '1000',
      currency: 'INR',
      value_base_amount: '1000',
      owner_user_id: ownerUserId,
      created_by: ownerUserId,
    })
    .returning();
  dealId = d!.id;
});

afterAll(async () => {
  await dbAdmin.delete(tenants).where(eq(tenants.id, tenantId));
  await dbAdmin.delete(users).where(eq(users.id, ownerUserId));
  await (dbAdmin as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

// ─── 1a. Leads delete ────────────────────────────────────────────────────────

describe('leads: soft delete', () => {
  it('a deleted lead leaves the list AND the counts, and cannot be decided', async () => {
    const created = await leadsSvc.create(tenantId, ownerUserId, {
      first_name: 'Junk',
      email: `junk-${rid()}@lead.test`,
    });
    const leadId = created.data.id;

    await leadsSvc.remove(tenantId, ownerUserId, leadId);

    const list = await leadsSvc.list(tenantId, 'new');
    expect(list.data.some((l) => l.id === leadId)).toBe(false);
    expect(list.counts['new'] ?? 0).toBe(0);

    // Deleted rows are gone for every action.
    await expect(leadsSvc.claim(tenantId, ownerUserId, leadId)).rejects.toThrow(NotFoundException);
    await expect(leadsSvc.discard(tenantId, ownerUserId, leadId)).rejects.toThrow(NotFoundException);
    await expect(leadsSvc.remove(tenantId, ownerUserId, leadId)).rejects.toThrow(NotFoundException);

    // …but the row itself survives underneath (soft).
    const [raw] = await dbAdmin.select().from(leads).where(eq(leads.id, leadId));
    expect(raw?.deleted_at).toBeTruthy();
  });

  it('a discarded lead (kept for analytics) can still be deleted outright', async () => {
    const created = await leadsSvc.create(tenantId, ownerUserId, {
      first_name: 'Spam',
      email: `spam-${rid()}@lead.test`,
    });
    await leadsSvc.discard(tenantId, ownerUserId, created.data.id);
    const res = await leadsSvc.remove(tenantId, ownerUserId, created.data.id);
    expect(res.data.deleted).toBe(true);
    const list = await leadsSvc.list(tenantId, 'discarded');
    expect(list.data.some((l) => l.id === created.data.id)).toBe(false);
  });
});

// ─── 1b. Web forms delete ────────────────────────────────────────────────────

describe('web forms: soft delete', () => {
  it('deleting a form kills the public token, keeps submissions, frees the name', async () => {
    const name = `R9 Landing ${rid()}`;
    const created = await formsSvc.create(tenantId, ownerUserId, { name });
    const formId = created.data.id;
    const token = created.data.token;

    // Public resolution works while alive.
    const alive = await formsSvc.publicForm(token);
    expect(alive.data.title).toBeTruthy();

    await formsSvc.remove(tenantId, ownerUserId, formId);

    // Gone from the list, public token dead, active untouchable.
    const list = await formsSvc.list(tenantId);
    expect(list.data.some((f) => f.id === formId)).toBe(false);
    await expect(formsSvc.publicForm(token)).rejects.toThrow(NotFoundException);
    await expect(formsSvc.setActive(tenantId, ownerUserId, formId, true)).rejects.toThrow(NotFoundException);

    // The NAME is reusable — this failed before 0053 made the index partial.
    const recreated = await formsSvc.create(tenantId, ownerUserId, { name });
    expect(recreated.data.id).not.toBe(formId);

    const [raw] = await dbAdmin.select().from(webForms).where(eq(webForms.id, formId));
    expect(raw?.deleted_at).toBeTruthy();
  });
});

// ─── 2. Activity purge ───────────────────────────────────────────────────────

describe('activities: bulk purge', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  let oldCompletedId: string;
  let freshCompletedId: string;
  let oldOpenId: string;

  beforeAll(async () => {
    const mk = async (over: Partial<typeof activities.$inferInsert>) => {
      const [row] = await dbAdmin
        .insert(activities)
        .values({
          tenant_id: tenantId,
          type: 'task',
          subject: `r9-${rid()}`,
          deal_id: dealId,
          assignee_user_id: ownerUserId,
          created_by: ownerUserId,
          ...over,
        })
        .returning();
      return row!.id;
    };
    oldCompletedId = await mk({ completed_at: daysAgo(200), created_at: daysAgo(210) });
    freshCompletedId = await mk({ completed_at: daysAgo(5), created_at: daysAgo(6) });
    oldOpenId = await mk({ due_at: daysAgo(150), created_at: daysAgo(151) });
  });

  it('preview counts exactly what the purge would remove (completed-only)', async () => {
    const preview = await activitiesSvc.purgePreview(tenantId, 90, true);
    expect(preview.data.count).toBe(1); // only the 200-day-old completed one
  });

  it('purge removes only completed-older-than-cutoff, audits the count, keeps the rest', async () => {
    auditLog.mockClear();
    const res = await activitiesSvc.purgeOlderThan(tenantId, ownerUserId, {
      days: 90,
      completedOnly: true,
    });
    expect(res.data.removed).toBe(1);

    const [gone] = await dbAdmin.select().from(activities).where(eq(activities.id, oldCompletedId));
    expect(gone?.deleted_at).toBeTruthy();
    const [keptFresh] = await dbAdmin.select().from(activities).where(eq(activities.id, freshCompletedId));
    expect(keptFresh?.deleted_at).toBeNull();
    const [keptOpen] = await dbAdmin.select().from(activities).where(eq(activities.id, oldOpenId));
    expect(keptOpen?.deleted_at).toBeNull();

    const call = auditLog.mock.calls.find(
      (c) => (c as unknown as [{ action: string }])[0].action === 'crm.activities.purge',
    ) as unknown as [{ metadata: { removed: number; days: number } }] | undefined;
    expect(call?.[0].metadata.removed).toBe(1);
    expect(call?.[0].metadata.days).toBe(90);
  });

  it('the everything mode also clears old OPEN activities and recomputes deal stamps', async () => {
    const res = await activitiesSvc.purgeOlderThan(tenantId, ownerUserId, {
      days: 90,
      completedOnly: false,
    });
    expect(res.data.removed).toBe(1); // the 150-day-old open task

    // With that open task gone, the deal's next_activity_at recomputes to null
    // (the only remaining activity is completed).
    const [d] = await dbAdmin.select().from(deals).where(eq(deals.id, dealId));
    expect(d?.next_activity_at).toBeNull();

    const [live] = await dbAdmin
      .select({ n: activities.id })
      .from(activities)
      .where(and(eq(activities.tenant_id, tenantId), isNull(activities.deleted_at)));
    expect(live).toBeTruthy(); // the fresh completed one survives
  });
});

// ─── 3. Coupons ──────────────────────────────────────────────────────────────

describe('coupons: sequential retired + delete', () => {
  const PREFIX = `R9C${rid().slice(0, 3).toUpperCase()}`;
  let famUserId: string;

  beforeAll(async () => {
    const [u] = await dbAdmin
      .insert(users)
      .values({ email: `r9-fam-${rid()}@t.test`, full_name: 'R9 Fam' })
      .returning();
    famUserId = u!.id;
  });

  afterAll(async () => {
    // Redemption rows FK-reference the coupon — clear them first (in prod the
    // tenant cascade does this; here the coupon cleanup runs before the
    // tenant's).
    const rows = await dbAdmin
      .select({ id: couponCodes.id })
      .from(couponCodes)
      .where(eq(couponCodes.campaign, `r9-${PREFIX}`));
    for (const r of rows) {
      await dbAdmin.delete(couponRedemptions).where(eq(couponRedemptions.coupon_id, r.id));
    }
    await dbAdmin.delete(couponCodes).where(eq(couponCodes.campaign, `r9-${PREFIX}`));
    await dbAdmin.delete(users).where(eq(users.id, famUserId));
  });

  it('sequential minting is rejected — numbered sequences are guessable', async () => {
    await expect(
      famBilling.batchCreate(famUserId, {
        prefix: PREFIX,
        mode: 'sequential',
        count: 3,
        months: 1,
        campaign: `r9-${PREFIX}`,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('an unredeemed coupon deletes; a redeemed one 409s and survives', async () => {
    const minted = await famBilling.batchCreate(famUserId, {
      prefix: PREFIX,
      mode: 'random',
      count: 2,
      months: 1,
      campaign: `r9-${PREFIX}`,
    });
    const [codeA, codeB] = minted.data.codes;
    const [rowA] = await dbAdmin.select().from(couponCodes).where(eq(couponCodes.code, codeA!));
    const [rowB] = await dbAdmin.select().from(couponCodes).where(eq(couponCodes.code, codeB!));

    // Unredeemed → deletes cleanly.
    const res = await famBilling.remove(famUserId, rowA!.id);
    expect(res.data.deleted).toBe(true);
    const [goneA] = await dbAdmin.select().from(couponCodes).where(eq(couponCodes.id, rowA!.id));
    expect(goneA).toBeUndefined();

    // Mark B redeemed (ledger row + count) → delete refused, row intact.
    await dbAdmin
      .update(couponCodes)
      .set({ redemption_count: 1 })
      .where(eq(couponCodes.id, rowB!.id));
    await dbAdmin.insert(couponRedemptions).values({
      coupon_id: rowB!.id,
      tenant_id: tenantId,
      redeemed_by: ownerUserId,
      months: 1,
    });
    await expect(famBilling.remove(famUserId, rowB!.id)).rejects.toThrow(ConflictException);
    const [stillB] = await dbAdmin.select().from(couponCodes).where(eq(couponCodes.id, rowB!.id));
    expect(stillB).toBeTruthy();
  });

  it('the retire statement pattern spares redeemed codes by construction', async () => {
    // Mirror of scripts/supabase-editor/06-retire-coupons.sql, scoped to this
    // spec's campaign: only redemption_count = 0 rows go.
    const before = await dbAdmin
      .select()
      .from(couponCodes)
      .where(eq(couponCodes.campaign, `r9-${PREFIX}`));
    expect(before.length).toBe(1); // only the redeemed B remains from above

    await dbAdmin
      .delete(couponCodes)
      .where(and(eq(couponCodes.campaign, `r9-${PREFIX}`), eq(couponCodes.redemption_count, 0)));

    const after = await dbAdmin
      .select()
      .from(couponCodes)
      .where(eq(couponCodes.campaign, `r9-${PREFIX}`));
    expect(after.map((c) => Number(c.redemption_count))).toEqual([1]);
  });
});
