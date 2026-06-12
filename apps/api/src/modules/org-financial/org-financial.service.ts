import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, eq, isNull, desc, asc } from 'drizzle-orm';
import {
  tenants,
  tenantBankAccounts,
  tenantCurrencyBankDefaults,
  type TenantBankAccount,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type {
  UpdateOrgFinancialDto,
  CreateBankAccountDto,
  UpdateBankAccountDto,
  SetCurrencyDefaultDto,
} from './org-financial.dto';

/** Roles that see full account numbers; everyone else gets last-4 (§8). */
const FULL_NUMBER_ROLES = new Set(['owner', 'admin', 'finance', 'super_admin', 'fam']);

function maskAccount(acct: TenantBankAccount, role: string) {
  if (FULL_NUMBER_ROLES.has(role)) return acct;
  const n = acct.account_number;
  return {
    ...acct,
    account_number: n.length <= 4 ? n : `${'•'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`,
  };
}

/**
 * Organization → Financial details (PRD §7.2 / §8): the single source of truth
 * for GSTIN/PAN/FY (columns on `tenants` — never duplicated) and the company
 * bank accounts that render on invoices. Read by Invoicing now, Payroll later.
 */
@Injectable()
export class OrgFinancialService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ─── financial details (tenants columns) ────────────────────────────────────

  async getFinancial(tenantId: string) {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({
          name: tenants.name,
          legal_name: tenants.legal_name,
          gstin: tenants.gstin,
          pan: tenants.pan,
          cin: tenants.cin,
          fiscal_year_start_month: tenants.fiscal_year_start_month,
          currency: tenants.currency,
          address_line1: tenants.address_line1,
          address_line2: tenants.address_line2,
          city: tenants.city,
          state_code: tenants.state_code,
          postal_code: tenants.postal_code,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    if (!row) throw new NotFoundException('Organization not found');
    return { data: row };
  }

  async updateFinancial(dto: UpdateOrgFinancialDto, userId: string, tenantId: string) {
    const before = (await this.getFinancial(tenantId)).data;
    const [updated] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .update(tenants)
        .set({ ...dto, updated_at: new Date() })
        .where(eq(tenants.id, tenantId))
        .returning({
          legal_name: tenants.legal_name,
          gstin: tenants.gstin,
          pan: tenants.pan,
          cin: tenants.cin,
          fiscal_year_start_month: tenants.fiscal_year_start_month,
        }),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'org.financial.update',
      resourceType: 'tenant',
      resourceId: tenantId,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: updated as unknown as Record<string, unknown>,
    });
    return { data: updated };
  }

  // ─── bank accounts ──────────────────────────────────────────────────────────

  async listBankAccounts(tenantId: string, role: string) {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(tenantBankAccounts)
        .where(
          and(
            eq(tenantBankAccounts.tenant_id, tenantId),
            isNull(tenantBankAccounts.deleted_at),
          ),
        )
        .orderBy(desc(tenantBankAccounts.is_default), asc(tenantBankAccounts.created_at)),
    );
    const defaults = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(tenantCurrencyBankDefaults)
        .where(eq(tenantCurrencyBankDefaults.tenant_id, tenantId)),
    );
    return {
      data: rows.map((r) => maskAccount(r, role)),
      meta: {
        currency_defaults: Object.fromEntries(
          defaults.map((d) => [d.currency.trim(), d.bank_account_id]),
        ),
      },
    };
  }

  async getBankAccount(tenantId: string, id: string, role: string) {
    const row = await this.fetchAccount(tenantId, id);
    return { data: maskAccount(row, role) };
  }

  async createBankAccount(dto: CreateBankAccountDto, userId: string, tenantId: string) {
    this.assertBankShape(dto);
    const warning = await this.beneficiaryWarning(tenantId, dto.beneficiary_name);

    const created = await this.db.withTenant(tenantId, async (tx) => {
      if (dto.is_default) await this.clearDefault(tx, tenantId);
      const [row] = await tx
        .insert(tenantBankAccounts)
        .values({
          ...dto,
          tenant_id: tenantId,
          // First account becomes the default automatically.
          is_default: dto.is_default ?? (await this.countAccounts(tx, tenantId)) === 0,
          created_by: userId,
          updated_by: userId,
        })
        .returning();
      return row!;
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'org.bank_account.create',
      resourceType: 'tenant_bank_account',
      resourceId: created.id,
      // Never put the full account number in the audit trail.
      afterState: { ...created, account_number: `…${created.account_number.slice(-4)}` },
    });
    return { data: created, warning };
  }

  async updateBankAccount(id: string, dto: UpdateBankAccountDto, userId: string, tenantId: string) {
    const existing = await this.fetchAccount(tenantId, id);
    this.assertBankShape({ ...existing, ...dto } as CreateBankAccountDto);
    const warning = dto.beneficiary_name
      ? await this.beneficiaryWarning(tenantId, dto.beneficiary_name)
      : undefined;

    const updated = await this.db.withTenant(tenantId, async (tx) => {
      if (dto.is_default) await this.clearDefault(tx, tenantId);
      const [row] = await tx
        .update(tenantBankAccounts)
        .set({ ...dto, updated_by: userId, updated_at: new Date() })
        .where(eq(tenantBankAccounts.id, id))
        .returning();
      return row!;
    });

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'org.bank_account.update',
      resourceType: 'tenant_bank_account',
      resourceId: id,
      afterState: { ...updated, account_number: `…${updated.account_number.slice(-4)}` },
    });
    return { data: updated, warning };
  }

  /** Soft delete; also removes any per-currency defaults pointing at it. */
  async deleteBankAccount(id: string, userId: string, tenantId: string) {
    await this.fetchAccount(tenantId, id);
    await this.db.withTenant(tenantId, async (tx) => {
      await tx
        .delete(tenantCurrencyBankDefaults)
        .where(eq(tenantCurrencyBankDefaults.bank_account_id, id));
      await tx
        .update(tenantBankAccounts)
        .set({ deleted_at: new Date(), is_default: false, is_active: false, updated_by: userId })
        .where(eq(tenantBankAccounts.id, id));
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'org.bank_account.delete',
      resourceType: 'tenant_bank_account',
      resourceId: id,
    });
    return { data: { id } };
  }

  async setDefault(id: string, userId: string, tenantId: string) {
    await this.fetchAccount(tenantId, id);
    const updated = await this.db.withTenant(tenantId, async (tx) => {
      await this.clearDefault(tx, tenantId);
      const [row] = await tx
        .update(tenantBankAccounts)
        .set({ is_default: true, updated_by: userId, updated_at: new Date() })
        .where(eq(tenantBankAccounts.id, id))
        .returning();
      return row!;
    });
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'org.bank_account.set_default',
      resourceType: 'tenant_bank_account',
      resourceId: id,
    });
    return { data: updated };
  }

  async setCurrencyDefault(dto: SetCurrencyDefaultDto, userId: string, tenantId: string) {
    const account = await this.fetchAccount(tenantId, dto.bank_account_id);
    const currency = dto.currency.toUpperCase();
    // §8: an account used for foreign currency needs SWIFT/BIC + bank address.
    if (currency !== 'INR' && !account.swift_bic) {
      throw new BadRequestException(
        `Account …${account.account_number.slice(-4)} has no SWIFT/BIC — add one before using it for ${currency}`,
      );
    }
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .insert(tenantCurrencyBankDefaults)
        .values({ tenant_id: tenantId, currency, bank_account_id: dto.bank_account_id })
        .onConflictDoUpdate({
          target: [tenantCurrencyBankDefaults.tenant_id, tenantCurrencyBankDefaults.currency],
          set: { bank_account_id: dto.bank_account_id },
        })
        .returning(),
    );
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      action: 'org.bank_account.set_currency_default',
      resourceType: 'tenant_currency_bank_default',
      resourceId: row!.id,
      metadata: { currency, bank_account_id: dto.bank_account_id },
    });
    return { data: row };
  }

  // ─── invoice-time selection (§8) ────────────────────────────────────────────

  /**
   * Resolve which bank account renders on an invoice, inside the caller's
   * tenant transaction. Order: explicit override → per-currency default →
   * overall default → first active account → none.
   */
  async resolveForInvoice(
    tx: Db,
    tenantId: string,
    currency: string,
    overrideId?: string | null,
  ): Promise<string | null> {
    if (overrideId) {
      const [row] = await tx
        .select({ id: tenantBankAccounts.id })
        .from(tenantBankAccounts)
        .where(
          and(
            eq(tenantBankAccounts.id, overrideId),
            eq(tenantBankAccounts.tenant_id, tenantId),
            eq(tenantBankAccounts.is_active, true),
            isNull(tenantBankAccounts.deleted_at),
          ),
        )
        .limit(1);
      if (!row) throw new BadRequestException('Selected bank account not found or inactive');
      return row.id;
    }
    const [byCurrency] = await tx
      .select({ id: tenantCurrencyBankDefaults.bank_account_id })
      .from(tenantCurrencyBankDefaults)
      .innerJoin(
        tenantBankAccounts,
        eq(tenantCurrencyBankDefaults.bank_account_id, tenantBankAccounts.id),
      )
      .where(
        and(
          eq(tenantCurrencyBankDefaults.tenant_id, tenantId),
          eq(tenantCurrencyBankDefaults.currency, currency.toUpperCase()),
          eq(tenantBankAccounts.is_active, true),
          isNull(tenantBankAccounts.deleted_at),
        ),
      )
      .limit(1);
    if (byCurrency) return byCurrency.id;

    const [fallback] = await tx
      .select({ id: tenantBankAccounts.id })
      .from(tenantBankAccounts)
      .where(
        and(
          eq(tenantBankAccounts.tenant_id, tenantId),
          eq(tenantBankAccounts.is_active, true),
          isNull(tenantBankAccounts.deleted_at),
        ),
      )
      .orderBy(desc(tenantBankAccounts.is_default), asc(tenantBankAccounts.created_at))
      .limit(1);
    return fallback?.id ?? null;
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async fetchAccount(tenantId: string, id: string) {
    const [row] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(tenantBankAccounts)
        .where(and(eq(tenantBankAccounts.id, id), isNull(tenantBankAccounts.deleted_at)))
        .limit(1),
    );
    if (!row) throw new NotFoundException('Bank account not found');
    return row;
  }

  private async countAccounts(tx: Db, tenantId: string): Promise<number> {
    const rows = await tx
      .select({ id: tenantBankAccounts.id })
      .from(tenantBankAccounts)
      .where(
        and(eq(tenantBankAccounts.tenant_id, tenantId), isNull(tenantBankAccounts.deleted_at)),
      );
    return rows.length;
  }

  private async clearDefault(tx: Db, tenantId: string) {
    await tx
      .update(tenantBankAccounts)
      .set({ is_default: false })
      .where(
        and(eq(tenantBankAccounts.tenant_id, tenantId), eq(tenantBankAccounts.is_default, true)),
      );
  }

  /** §8: an account is only fully usable when it has IFSC (INR) or SWIFT+address (FX). */
  private assertBankShape(dto: CreateBankAccountDto) {
    if (!dto.ifsc && !dto.swift_bic) {
      throw new BadRequestException(
        'Provide an IFSC (for INR transfers) and/or a SWIFT/BIC (for international transfers)',
      );
    }
    if (dto.swift_bic && !dto.bank_address) {
      throw new BadRequestException(
        'Bank address is required when the account is used internationally (SWIFT/BIC set)',
      );
    }
  }

  /** §8: warn when the beneficiary doesn't match the legal name on record. */
  private async beneficiaryWarning(tenantId: string, beneficiary: string) {
    const [t] = await this.db.withTenant(tenantId, (tx) =>
      tx
        .select({ legal_name: tenants.legal_name, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    const legal = (t?.legal_name ?? t?.name ?? '').trim().toLowerCase();
    if (legal && beneficiary.trim().toLowerCase() !== legal) {
      return `Beneficiary name doesn't match your legal name on record (“${t?.legal_name ?? t?.name}”) — mismatched names can cause your bank to hold incoming transfers.`;
    }
    return undefined;
  }
}
