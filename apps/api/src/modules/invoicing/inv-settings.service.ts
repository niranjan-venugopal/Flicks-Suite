import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  invoicingSettings,
  invoicingSetupProgress,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import type { UpdateInvSettingsDto, UpdateSetupProgressDto } from './dto/invoicing.dto';

/**
 * Invoicing settings + setup-wizard progress (PRD §7.1, §11). One row per
 * tenant for each table; both are lazily created on first read so the wizard
 * and settings tabs always have something to bind to. Tenant-scoped (RLS).
 */
@Injectable()
export class InvSettingsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly audit: AuditService,
  ) {}

  // ─── invoicing_settings ────────────────────────────────────────────────────

  async getSettings(tenantId: string, userId: string) {
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(invoicingSettings)
          .where(eq(invoicingSettings.tenant_id, tenantId))
          .limit(1);
        if (existing) return existing;
        const [created] = await tx
          .insert(invoicingSettings)
          .values({ tenant_id: tenantId })
          .onConflictDoNothing()
          .returning();
        if (created) return created;
        const [reread] = await tx
          .select()
          .from(invoicingSettings)
          .where(eq(invoicingSettings.tenant_id, tenantId))
          .limit(1);
        return reread!;
      },
      userId,
    );
    return { data: this.maskSettings(row) };
  }

  async updateSettings(
    tenantId: string,
    userId: string,
    dto: UpdateInvSettingsDto,
  ) {
    // Only persist provided keys; ignore undefined so PATCH is partial.
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) patch[k] = v;
    }

    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        // Ensure a row exists, then update.
        await tx
          .insert(invoicingSettings)
          .values({ tenant_id: tenantId })
          .onConflictDoNothing();
        const [updated] = await tx
          .update(invoicingSettings)
          .set({ ...patch, updated_at: new Date() })
          .where(eq(invoicingSettings.tenant_id, tenantId))
          .returning();
        return updated!;
      },
      userId,
    );

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.settings_updated',
      resourceType: 'invoicing_settings',
      resourceId: row.id,
      afterState: { keys: Object.keys(patch) },
    });

    return { data: this.maskSettings(row) };
  }

  /** Never leak the Razorpay webhook secret to the client. */
  private maskSettings(row: typeof invoicingSettings.$inferSelect) {
    const { razorpay_webhook_secret, ...rest } = row;
    return {
      ...rest,
      razorpay_webhook_configured: !!razorpay_webhook_secret,
    };
  }

  // ─── invoicing_setup_progress (wizard) ──────────────────────────────────────

  async getSetupProgress(tenantId: string, userId: string) {
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(invoicingSetupProgress)
          .where(eq(invoicingSetupProgress.tenant_id, tenantId))
          .limit(1);
        if (existing) return existing;
        const [created] = await tx
          .insert(invoicingSetupProgress)
          .values({ tenant_id: tenantId, wizard_started_at: new Date() })
          .onConflictDoNothing()
          .returning();
        if (created) return created;
        const [reread] = await tx
          .select()
          .from(invoicingSetupProgress)
          .where(eq(invoicingSetupProgress.tenant_id, tenantId))
          .limit(1);
        return reread!;
      },
      userId,
    );
    return { data: this.withProgressMeta(row) };
  }

  async updateSetupProgress(
    tenantId: string,
    userId: string,
    dto: UpdateSetupProgressDto,
  ) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v !== undefined) patch[k] = v;
    }

    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await tx
          .insert(invoicingSetupProgress)
          .values({ tenant_id: tenantId, wizard_started_at: new Date() })
          .onConflictDoNothing();
        const [updated] = await tx
          .update(invoicingSetupProgress)
          .set({ ...patch, updated_at: new Date() })
          .where(eq(invoicingSetupProgress.tenant_id, tenantId))
          .returning();
        return updated!;
      },
      userId,
    );
    return { data: this.withProgressMeta(row) };
  }

  async completeWizard(tenantId: string, userId: string) {
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        await tx
          .insert(invoicingSetupProgress)
          .values({ tenant_id: tenantId, wizard_started_at: new Date() })
          .onConflictDoNothing();
        const [updated] = await tx
          .update(invoicingSetupProgress)
          .set({ wizard_completed_at: new Date(), updated_at: new Date() })
          .where(eq(invoicingSetupProgress.tenant_id, tenantId))
          .returning();
        return updated!;
      },
      userId,
    );

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.setup_completed',
      resourceType: 'invoicing_setup_progress',
      resourceId: row.id,
    });

    return { data: this.withProgressMeta(row) };
  }

  /** Adds a derived completed-step count / percentage for the wizard UI. */
  private withProgressMeta(row: typeof invoicingSetupProgress.$inferSelect) {
    const steps = [
      row.business_details_confirmed,
      row.upi_configured,
      row.razorpay_connected,
      row.template_chosen,
      row.numbering_configured,
      row.payment_terms_set,
      row.currencies_enabled,
      row.default_gst_set,
      row.default_notes_set,
      row.email_signature_set,
      row.reminder_schedule_set,
    ];
    const done = steps.filter(Boolean).length;
    return {
      ...row,
      completed_steps: done,
      total_steps: steps.length,
      percent_complete: Math.round((done / steps.length) * 100),
      is_complete: !!row.wizard_completed_at,
    };
  }
}
