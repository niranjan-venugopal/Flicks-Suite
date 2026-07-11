import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, desc, sql, isNull } from 'drizzle-orm';
import {
  invoiceSubscriptions,
  invoiceSubscriptionProrationEvents,
  invoices,
  customers,
} from '@flicks/db/schema';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { CreateSubscriptionDto, UpdateSeatsDto } from './dto/invoicing.dto';

const toCents = (v: string | number | null | undefined) =>
  Math.round((typeof v === 'number' ? v : parseFloat(v ?? '0')) * 100);
const money = (c: number) => (c / 100).toFixed(2);

export function periodDays(period: string, customDays?: number | null): number {
  switch (period) {
    case 'monthly': return 30;
    case 'quarterly': return 91;
    case 'annually': return 365;
    case 'custom': return Math.max(1, customDays ?? 30);
    default: return 30;
  }
}

export function advanceDate(iso: string, period: string, customDays?: number | null): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (period === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (period === 'annually') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCDate(d.getUTCDate() + periodDays(period, customDays));
  return d.toISOString().slice(0, 10);
}

/** Per-cycle TAXABLE base: flat amount or seat_rate × seat_count (§6.3). */
export function cycleAmountCents(sub: {
  pricing_model: string;
  flat_amount: string | null;
  seat_rate: string | null;
  seat_count: number | null;
}): number {
  if (sub.pricing_model === 'per_seat') {
    return toCents(sub.seat_rate) * (sub.seat_count ?? 0);
  }
  return toCents(sub.flat_amount);
}

/**
 * GST rate applied to every generated subscription base line. Generation
 * (invoicing.jobs.ts) and the auto-debit mandate amount (§8A) MUST use the
 * same rate — the mandate charges the GST-inclusive total so the generated
 * invoice reaches PAID exactly (an under-charge strands the tax and the
 * invoice goes OVERDUE forever).
 */
export const SUBSCRIPTION_GST_RATE = 18;

/**
 * GST-inclusive per-cycle amount the mandate charges — matches the single
 * base line's invoice total: base + round(base × rate%). Prorations are
 * mid-cycle one-offs a fixed Razorpay plan can't carry; they invoice
 * separately and stay a manual-collection concern.
 */
export function mandateChargeCents(sub: Parameters<typeof cycleAmountCents>[0]): number {
  const base = cycleAmountCents(sub);
  return base + Math.round((base * SUBSCRIPTION_GST_RATE) / 100);
}

/**
 * Recurring subscriptions (PRD §6.3/§6.8). v3 ships flat-rate and per-seat.
 * Currency is LOCKED at creation. The Razorpay mandate is stubbed: activate()
 * stands in for mandate authorization until live keys exist; the generation /
 * pre-debit / dunning sweeps live in InvoicingJobs.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async list(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: invoiceSubscriptions.id,
          name: invoiceSubscriptions.name,
          status: invoiceSubscriptions.status,
          pricing_model: invoiceSubscriptions.pricing_model,
          currency: invoiceSubscriptions.currency,
          flat_amount: invoiceSubscriptions.flat_amount,
          seat_rate: invoiceSubscriptions.seat_rate,
          seat_count: invoiceSubscriptions.seat_count,
          billing_period: invoiceSubscriptions.billing_period,
          next_billing_date: invoiceSubscriptions.next_billing_date,
          total_cycles_billed: invoiceSubscriptions.total_cycles_billed,
          failed_charge_count: invoiceSubscriptions.failed_charge_count,
          mandate_authorized_at: invoiceSubscriptions.mandate_authorized_at,
          collection_mode: invoiceSubscriptions.collection_mode,
          mandate_status: invoiceSubscriptions.mandate_status,
          customer_name: customers.display_name,
          customer_id: invoiceSubscriptions.customer_id,
        })
        .from(invoiceSubscriptions)
        .leftJoin(customers, eq(invoiceSubscriptions.customer_id, customers.id))
        .where(eq(invoiceSubscriptions.tenant_id, tenantId))
        .orderBy(desc(invoiceSubscriptions.created_at));

      // Normalised MRR across ACTIVE/TRIALING profiles (prototype header).
      const mrrCents = rows
        .filter((r) => ['ACTIVE', 'TRIALING'].includes(r.status))
        .reduce((a, r) => {
          const amt = cycleAmountCents(r);
          const div = r.billing_period === 'quarterly' ? 3 : r.billing_period === 'annually' ? 12 : 1;
          return a + Math.round(amt / div);
        }, 0);
      return { data: rows, meta: { mrr: money(mrrCents) } };
    });
  }

  async get(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const sub = await this.fetch(tx, id);
      const subInvoices = await tx
        .select({
          id: invoices.id,
          invoice_number: invoices.invoice_number,
          invoice_date: invoices.invoice_date,
          status: invoices.status,
          total_amount: invoices.total_amount,
          currency: invoices.currency,
        })
        .from(invoices)
        .where(eq(invoices.subscription_id, id))
        .orderBy(desc(invoices.created_at));
      const prorations = await tx
        .select()
        .from(invoiceSubscriptionProrationEvents)
        .where(eq(invoiceSubscriptionProrationEvents.subscription_id, id))
        .orderBy(desc(invoiceSubscriptionProrationEvents.created_at));
      return { data: { ...sub, invoices: subInvoices, proration_events: prorations } };
    });
  }

  async create(dto: CreateSubscriptionDto, userId: string, tenantId: string) {
    if (dto.pricing_model === 'flat_rate' && toCents(dto.flat_amount) <= 0) {
      throw new BadRequestException('flat_amount must be positive for flat-rate subscriptions');
    }
    if (dto.pricing_model === 'per_seat' && (toCents(dto.seat_rate) <= 0 || !dto.seat_count || dto.seat_count <= 0)) {
      throw new BadRequestException('seat_rate and seat_count are required for per-seat subscriptions');
    }

    const created = await this.db.withTenant(tenantId, async (tx) => {
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, dto.customer_id))
        .limit(1);
      if (!customer) throw new NotFoundException('Customer not found');

      const trialDays = dto.trial_days ?? 0;
      const trialEnds = trialDays > 0
        ? new Date(new Date(`${dto.start_date}T00:00:00Z`).getTime() + trialDays * 86400000)
            .toISOString()
            .slice(0, 10)
        : null;

      const [sub] = await tx
        .insert(invoiceSubscriptions)
        .values({
          tenant_id: tenantId,
          customer_id: dto.customer_id,
          name: dto.name,
          status: 'PENDING_MANDATE',
          pricing_model: dto.pricing_model,
          currency: dto.currency ?? customer.default_currency ?? 'INR', // LOCKED from here on
          flat_amount: dto.flat_amount,
          seat_rate: dto.seat_rate,
          seat_count: dto.seat_count,
          billing_period: dto.billing_period,
          custom_period_days: dto.custom_period_days,
          anchor_day: dto.anchor_day,
          start_date: dto.start_date,
          end_condition: dto.end_condition ?? 'until_cancelled',
          end_after_cycles: dto.end_after_cycles,
          end_date: dto.end_date,
          trial_days: trialDays,
          trial_ends_at: trialEnds,
          next_billing_date: dto.start_date,
          next_billing_amount: money(
            cycleAmountCents({
              pricing_model: dto.pricing_model,
              flat_amount: dto.flat_amount ?? null,
              seat_rate: dto.seat_rate ?? null,
              seat_count: dto.seat_count ?? null,
            }),
          ),
          created_by: userId,
        })
        .returning();
      return sub!;
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.subscription.create',
      resourceType: 'invoice_subscription',
      resourceId: created.id,
      afterState: created as unknown as Record<string, unknown>,
    });
    return { data: created };
  }

  /**
   * Start a MANUAL-collection subscription (TRIALING while inside the trial
   * window). Auto-debit profiles must go through enable-autodebit → the real
   * Razorpay mandate flow — activating them here would fake an authorization.
   */
  async activate(id: string, userId: string, tenantId: string) {
    const updated = await this.db.withTenant(tenantId, async (tx) => {
      const sub = await this.fetch(tx, id);
      if (sub.status !== 'PENDING_MANDATE' && sub.status !== 'PAUSED') {
        throw new BadRequestException(`Cannot activate from ${sub.status}`);
      }
      if (sub.collection_mode === 'auto_debit') {
        throw new BadRequestException(
          'Auto-debit profiles activate through mandate authorization — use enable-autodebit.',
        );
      }
      const inTrial = sub.trial_ends_at && sub.trial_ends_at >= new Date().toISOString().slice(0, 10);
      const [row] = await tx
        .update(invoiceSubscriptions)
        .set({
          status: inTrial ? 'TRIALING' : 'ACTIVE',
          failed_charge_count: 0,
          paused_at: null,
          updated_at: new Date(),
        })
        .where(eq(invoiceSubscriptions.id, id))
        .returning();
      return row!;
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.subscription.activate',
      resourceType: 'invoice_subscription',
      resourceId: id,
    });
    return { data: updated };
  }

  /** Stubbed Razorpay mandate link (live URL when keys are configured). */
  async mandateLink(id: string, tenantId: string) {
    const sub = await this.db.withTenant(tenantId, (tx) => this.fetch(tx, id));
    const keyId = this.config.get<string>('RAZORPAY_KEY_ID');
    return {
      data: {
        subscription_id: sub.id,
        url: keyId
          ? `https://rzp.io/mandate/${sub.razorpay_subscription_id ?? sub.id}`
          : null,
        stub: !keyId,
        note: keyId
          ? undefined
          : 'Razorpay keys not configured — use POST /subscriptions/:id/activate to simulate mandate authorization in dev.',
      },
    };
  }

  /** Mid-cycle seat change → proration event applied to the next invoice (§6.3). */
  async updateSeats(id: string, dto: UpdateSeatsDto, userId: string, tenantId: string) {
    const result = await this.db.withTenant(tenantId, async (tx) => {
      const sub = await this.fetch(tx, id);
      if (sub.pricing_model !== 'per_seat') {
        throw new BadRequestException('Seat changes only apply to per-seat subscriptions');
      }
      const oldSeats = sub.seat_count ?? 0;
      const diff = dto.seat_count - oldSeats;
      if (diff === 0) return { sub, proration: null };

      // Prorate the seat delta over the remaining days of the current cycle.
      const days = periodDays(sub.billing_period, sub.custom_period_days);
      const next = sub.next_billing_date ?? sub.start_date;
      const remaining = Math.max(
        0,
        Math.min(
          days,
          Math.ceil((new Date(`${next}T00:00:00Z`).getTime() - Date.now()) / 86400000),
        ),
      );
      const prorationCents = Math.round((toCents(sub.seat_rate) * diff * remaining) / days);

      const [event] = await tx
        .insert(invoiceSubscriptionProrationEvents)
        .values({
          tenant_id: tenantId,
          subscription_id: id,
          event_date: new Date().toISOString().slice(0, 10),
          event_type: diff > 0 ? 'add_seats' : 'remove_seats',
          amount: money(prorationCents),
        })
        .returning();

      const [updated] = await tx
        .update(invoiceSubscriptions)
        .set({
          seat_count: dto.seat_count,
          next_billing_amount: money(toCents(sub.seat_rate) * dto.seat_count),
          updated_at: new Date(),
        })
        .where(eq(invoiceSubscriptions.id, id))
        .returning();
      return { sub: updated!, proration: event! };
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.subscription.update_seats',
      resourceType: 'invoice_subscription',
      resourceId: id,
      metadata: {
        seat_count: dto.seat_count,
        proration: result.proration?.amount ?? '0',
      },
    });
    return { data: result.sub, meta: { proration: result.proration } };
  }

  async pause(id: string, userId: string, tenantId: string) {
    return this.transition(id, ['ACTIVE', 'TRIALING', 'PAST_DUE'], { status: 'PAUSED', paused_at: new Date() }, 'pause', userId, tenantId);
  }

  async resume(id: string, userId: string, tenantId: string) {
    return this.transition(id, ['PAUSED'], { status: 'ACTIVE', paused_at: null, failed_charge_count: 0 }, 'resume', userId, tenantId);
  }

  async cancel(id: string, reason: string | undefined, userId: string, tenantId: string) {
    return this.transition(
      id,
      ['PENDING_MANDATE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'],
      { status: 'CANCELLED', cancelled_at: new Date(), cancellation_reason: reason },
      'cancel',
      userId,
      tenantId,
    );
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async fetch(tx: Parameters<Parameters<DatabaseService['withTenant']>[1]>[0], id: string) {
    const [sub] = await tx
      .select()
      .from(invoiceSubscriptions)
      .where(eq(invoiceSubscriptions.id, id))
      .limit(1);
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  private async transition(
    id: string,
    from: string[],
    set: Record<string, unknown>,
    action: string,
    userId: string,
    tenantId: string,
  ) {
    const updated = await this.db.withTenant(tenantId, async (tx) => {
      const sub = await this.fetch(tx, id);
      if (!from.includes(sub.status)) {
        throw new BadRequestException(`Cannot ${action} from ${sub.status}`);
      }
      const [row] = await tx
        .update(invoiceSubscriptions)
        .set({ ...set, updated_at: new Date() })
        .where(eq(invoiceSubscriptions.id, id))
        .returning();
      return row!;
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: `invoicing.subscription.${action}`,
      resourceType: 'invoice_subscription',
      resourceId: id,
    });
    return { data: updated };
  }
}
