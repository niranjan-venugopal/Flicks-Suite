import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or, gt } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  invoicingSettings,
  invoicingSetupProgress,
  invoicingDebugConsents,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import { AuditService } from '../audit/audit.service';
import { RazorpayService } from './razorpay.service';
import { InvoicingCryptoService } from './invoicing-crypto.service';
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
    private readonly razorpay: RazorpayService,
    private readonly crypto: InvoicingCryptoService,
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

  /** Never leak the Razorpay webhook secret or OAuth tokens to the client. */
  private maskSettings(row: typeof invoicingSettings.$inferSelect) {
    const {
      razorpay_webhook_secret,
      razorpay_access_token,
      razorpay_refresh_token,
      razorpay_public_token,
      razorpay_oauth_state,
      ...rest
    } = row;
    return {
      ...rest,
      razorpay_webhook_configured: !!razorpay_webhook_secret,
      razorpay_connected: !!(row.razorpay_account_id && razorpay_access_token),
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

  // ─── Razorpay OAuth Connect (PRD §6.6/§9.3, Sprint 15) ──────────────────────

  /** Start OAuth: persist a CSRF state on the tenant, return the authorize URL. */
  async razorpayConnectUrl(tenantId: string, userId: string) {
    const state = randomBytes(24).toString('hex');
    await this.db.withTenant(
      tenantId,
      async (tx) => {
        await tx
          .insert(invoicingSettings)
          .values({ tenant_id: tenantId })
          .onConflictDoNothing();
        await tx
          .update(invoicingSettings)
          .set({ razorpay_oauth_state: state, updated_at: new Date() })
          .where(eq(invoicingSettings.tenant_id, tenantId));
      },
      userId,
    );
    // buildAuthorizeUrl throws 503 if the partner app is not provisioned.
    return { data: { url: this.razorpay.buildAuthorizeUrl(state) } };
  }

  /**
   * OAuth callback (no tenant JWT — Razorpay redirects the browser). Resolves
   * the tenant from the signed-out `state`, exchanges the code, and persists the
   * encrypted tokens. Runs on the service-role connection. Returns the resolved
   * tenantId so the controller can redirect back to the web settings page.
   */
  async razorpayCallback(code: string, state: string): Promise<string> {
    if (!code || !state) {
      throw new BadRequestException('Missing OAuth code/state');
    }
    const [match] = await this.dbAdmin
      .select({ tenant_id: invoicingSettings.tenant_id })
      .from(invoicingSettings)
      .where(eq(invoicingSettings.razorpay_oauth_state, state))
      .limit(1);
    if (!match) throw new BadRequestException('Invalid or expired OAuth state');
    const tenantId = match.tenant_id;

    const tok = await this.razorpay.exchangeCode(code);

    await this.dbAdmin
      .update(invoicingSettings)
      .set({
        razorpay_account_id: tok.razorpay_account_id ?? null,
        razorpay_access_token: this.crypto.encrypt(tok.access_token),
        razorpay_refresh_token: this.crypto.encrypt(tok.refresh_token),
        razorpay_public_token: tok.public_token ?? null,
        razorpay_token_expires_at: new Date(Date.now() + tok.expires_in * 1000),
        razorpay_connected_at: new Date(),
        razorpay_oauth_state: null,
        updated_at: new Date(),
      })
      .where(eq(invoicingSettings.tenant_id, tenantId));

    await this.dbAdmin
      .insert(invoicingSetupProgress)
      .values({ tenant_id: tenantId, wizard_started_at: new Date() })
      .onConflictDoNothing();
    await this.dbAdmin
      .update(invoicingSetupProgress)
      .set({ razorpay_connected: true, updated_at: new Date() })
      .where(eq(invoicingSetupProgress.tenant_id, tenantId));

    await this.audit.log({
      tenantId,
      action: 'invoicing.razorpay_connected',
      resourceType: 'invoicing_settings',
      afterState: { account_id: tok.razorpay_account_id ?? null },
    });
    return tenantId;
  }

  /** Disconnect: revoke the token, clear the credentials (Owner-only route). */
  async razorpayDisconnect(tenantId: string, userId: string) {
    const [current] = await this.dbAdmin
      .select({ token: invoicingSettings.razorpay_access_token })
      .from(invoicingSettings)
      .where(eq(invoicingSettings.tenant_id, tenantId))
      .limit(1);
    if (current?.token) {
      await this.razorpay.revoke(this.crypto.decrypt(current.token));
    }

    await this.db.withTenant(
      tenantId,
      async (tx) => {
        await tx
          .update(invoicingSettings)
          .set({
            razorpay_account_id: null,
            razorpay_access_token: null,
            razorpay_refresh_token: null,
            razorpay_public_token: null,
            razorpay_token_expires_at: null,
            razorpay_connected_at: null,
            razorpay_oauth_state: null,
            updated_at: new Date(),
          })
          .where(eq(invoicingSettings.tenant_id, tenantId));
        await tx
          .update(invoicingSetupProgress)
          .set({ razorpay_connected: false, updated_at: new Date() })
          .where(eq(invoicingSetupProgress.tenant_id, tenantId));
      },
      userId,
    );

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.razorpay_disconnected',
      resourceType: 'invoicing_settings',
    });
    return { data: { razorpay_connected: false } };
  }

  /**
   * Resolve a usable access token for creating an order (service-role; called
   * from the public order endpoint, which has no tenant JWT). Refreshes and
   * re-persists when the access token is within 5 minutes of expiry. Returns
   * null when the tenant has not connected Razorpay.
   */
  async resolveRazorpayForOrder(
    tenantId: string,
  ): Promise<{ accessToken: string; publicToken: string | null } | null> {
    const [s] = await this.dbAdmin
      .select()
      .from(invoicingSettings)
      .where(eq(invoicingSettings.tenant_id, tenantId))
      .limit(1);
    if (!s?.razorpay_access_token) return null;

    let accessToken = this.crypto.decrypt(s.razorpay_access_token);
    const expMs = s.razorpay_token_expires_at
      ? new Date(s.razorpay_token_expires_at).getTime()
      : 0;
    if (
      expMs &&
      expMs - Date.now() < 5 * 60 * 1000 &&
      s.razorpay_refresh_token
    ) {
      const refreshed = await this.razorpay.refresh(
        this.crypto.decrypt(s.razorpay_refresh_token),
      );
      accessToken = refreshed.access_token;
      await this.dbAdmin
        .update(invoicingSettings)
        .set({
          razorpay_access_token: this.crypto.encrypt(refreshed.access_token),
          razorpay_refresh_token: this.crypto.encrypt(refreshed.refresh_token),
          razorpay_token_expires_at: new Date(
            Date.now() + refreshed.expires_in * 1000,
          ),
          razorpay_public_token:
            refreshed.public_token ?? s.razorpay_public_token,
          updated_at: new Date(),
        })
        .where(eq(invoicingSettings.tenant_id, tenantId));
    }
    return { accessToken, publicToken: s.razorpay_public_token };
  }

  // ─── FAM debug consent (PRD §10.5) — owner grants/revokes; FAM reads via fam.service ──

  async getFamConsent(tenantId: string, userId: string) {
    const rows = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select()
          .from(invoicingDebugConsents)
          .where(
            and(
              eq(invoicingDebugConsents.tenant_id, tenantId),
              isNull(invoicingDebugConsents.revoked_at),
              or(
                isNull(invoicingDebugConsents.expires_at),
                gt(invoicingDebugConsents.expires_at, new Date()),
              ),
            ),
          )
          .orderBy(invoicingDebugConsents.created_at),
      userId,
    );
    return { data: rows[rows.length - 1] ?? null };
  }

  async grantFamConsent(
    tenantId: string,
    userId: string,
    dto: { scope?: string[]; expires_at?: string; note?: string },
  ) {
    const expiresAt = dto.expires_at ? new Date(`${dto.expires_at}T23:59:59.999Z`) : null;
    const row = await this.db.withTenant(
      tenantId,
      async (tx) => {
        // Supersede any current active grant, then insert the new one.
        await tx
          .update(invoicingDebugConsents)
          .set({ revoked_at: new Date(), updated_at: new Date() })
          .where(
            and(
              eq(invoicingDebugConsents.tenant_id, tenantId),
              isNull(invoicingDebugConsents.revoked_at),
            ),
          );
        const [created] = await tx
          .insert(invoicingDebugConsents)
          .values({
            tenant_id: tenantId,
            granted_by: userId,
            scope: dto.scope ?? ['invoice_counts', 'webhook_log', 'email_log', 'audit'],
            note: dto.note ?? null,
            expires_at: expiresAt,
          })
          .returning();
        return created!;
      },
      userId,
    );

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.fam_debug_consent_granted',
      resourceType: 'invoicing_debug_consent',
      resourceId: row.id,
      afterState: { scope: row.scope, expires_at: dto.expires_at ?? null },
    });
    return { data: row };
  }

  async revokeFamConsent(tenantId: string, userId: string) {
    await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .update(invoicingDebugConsents)
          .set({ revoked_at: new Date(), updated_at: new Date() })
          .where(
            and(
              eq(invoicingDebugConsents.tenant_id, tenantId),
              isNull(invoicingDebugConsents.revoked_at),
            ),
          ),
      userId,
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'invoicing.fam_debug_consent_revoked',
      resourceType: 'invoicing_debug_consent',
    });
    return { data: { revoked: true } };
  }
}
