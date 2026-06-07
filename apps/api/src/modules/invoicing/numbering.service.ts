import { Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, desc, sql } from 'drizzle-orm';
import { invoiceSequences, tenants } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { Db } from '@flicks/db';
import type { UpsertSequenceDto, PreviewNumberDto } from './dto/invoicing.dto';
import {
  computeFiscalYear,
  formatNumber,
  validateNumberFormat,
  DEFAULT_PREFIXES,
  type NumberFormatParts,
} from './numbering.util';

const DOC_TYPES = ['INVOICE', 'QUOTE', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const;

interface SeqConfig {
  prefix: string;
  separator: string;
  fy_format: string;
  zero_padding: number;
  starting_number: number;
  current_number: number;
  branch_code: string;
}

/**
 * Invoice numbering engine (PRD §6.4): per-doc-type sequences, live preview,
 * hard validation, April-1 FY reset, atomic reservation.
 */
@Injectable()
export class NumberingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async fyStartMonth(tx: Db, tenantId: string): Promise<number> {
    const [row] = await tx
      .select({ m: tenants.fiscal_year_start_month })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return row?.m ?? 4;
  }

  /** Current-FY sequences for all four document types (merging defaults). */
  async list(tenantId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.withTenant(tenantId, async (tx) => {
      const startMonth = await this.fyStartMonth(tx, tenantId);
      const existing = await tx
        .select()
        .from(invoiceSequences)
        .where(eq(invoiceSequences.tenant_id, tenantId));

      const data = DOC_TYPES.map((docType) => {
        const fy = computeFiscalYear(today, startMonth, '26-27');
        const row = existing.find(
          (r) =>
            r.document_type === docType &&
            r.fy_label === fy.label &&
            r.branch_code === '',
        );
        const cfg: SeqConfig = row
          ? {
              prefix: row.prefix,
              separator: row.separator,
              fy_format: row.fy_format,
              zero_padding: row.zero_padding,
              starting_number: row.starting_number,
              current_number: row.current_number,
              branch_code: row.branch_code,
            }
          : defaultConfig(docType);
        const fyLabel = computeFiscalYear(today, startMonth, cfg.fy_format).label;
        const nextNumber = Math.max(
          cfg.current_number + 1,
          cfg.starting_number,
        );
        return {
          id: row?.id ?? null,
          document_type: docType,
          fy_label: fyLabel,
          ...cfg,
          next_number_preview: formatNumber({
            prefix: cfg.prefix,
            separator: cfg.separator,
            fyLabel,
            zeroPadding: cfg.zero_padding,
            number: nextNumber,
          }),
        };
      });
      return { data };
    });
  }

  /** Live "next number" preview for a proposed (or current) config. */
  async preview(tenantId: string, dto: PreviewNumberDto) {
    const onDate = dto.on_date ?? new Date().toISOString().slice(0, 10);
    return this.db.withTenant(tenantId, async (tx) => {
      const startMonth = await this.fyStartMonth(tx, tenantId);
      const base = defaultConfig(dto.document_type);
      const [row] = await tx
        .select()
        .from(invoiceSequences)
        .where(
          and(
            eq(invoiceSequences.tenant_id, tenantId),
            eq(invoiceSequences.document_type, dto.document_type),
            eq(invoiceSequences.branch_code, dto.branch_code ?? ''),
          ),
        )
        .orderBy(desc(invoiceSequences.fy_start_date))
        .limit(1);

      const cfg: SeqConfig = {
        prefix: dto.prefix ?? row?.prefix ?? base.prefix,
        separator: dto.separator ?? row?.separator ?? base.separator,
        fy_format: dto.fy_format ?? row?.fy_format ?? base.fy_format,
        zero_padding: dto.zero_padding ?? row?.zero_padding ?? base.zero_padding,
        starting_number:
          dto.starting_number ?? row?.starting_number ?? base.starting_number,
        current_number: row?.current_number ?? 0,
        branch_code: dto.branch_code ?? '',
      };
      const fyLabel =
        dto.fy_label ?? computeFiscalYear(onDate, startMonth, cfg.fy_format).label;
      const nextNumber = Math.max(cfg.current_number + 1, cfg.starting_number);
      const parts: NumberFormatParts = {
        prefix: cfg.prefix,
        separator: cfg.separator,
        fyLabel,
        zeroPadding: cfg.zero_padding,
        number: nextNumber,
      };
      const validation = validateNumberFormat(parts);
      return {
        data: {
          document_type: dto.document_type,
          fy_label: fyLabel,
          next_number_preview: validation.sample,
          ...validation,
        },
      };
    });
  }

  /** Create/update a sequence config for the current FY (or a given fy_label). */
  async upsert(tenantId: string, dto: UpsertSequenceDto, userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.withTenant(tenantId, async (tx) => {
      const startMonth = await this.fyStartMonth(tx, tenantId);
      const base = defaultConfig(dto.document_type);
      const fyFormat = dto.fy_format ?? base.fy_format;
      const fy = computeFiscalYear(today, startMonth, fyFormat);
      const fyLabel = dto.fy_label ?? fy.label;
      const branch = dto.branch_code ?? '';

      const [existing] = await tx
        .select()
        .from(invoiceSequences)
        .where(
          and(
            eq(invoiceSequences.tenant_id, tenantId),
            eq(invoiceSequences.document_type, dto.document_type),
            eq(invoiceSequences.fy_label, fyLabel),
            eq(invoiceSequences.branch_code, branch),
          ),
        )
        .limit(1);

      const cfg: SeqConfig = {
        prefix: dto.prefix ?? existing?.prefix ?? base.prefix,
        separator: dto.separator ?? existing?.separator ?? base.separator,
        fy_format: fyFormat,
        zero_padding:
          dto.zero_padding ?? existing?.zero_padding ?? base.zero_padding,
        starting_number:
          dto.starting_number ??
          existing?.starting_number ??
          base.starting_number,
        current_number: existing?.current_number ?? 0,
        branch_code: branch,
      };

      // Hard validation (§6.4).
      const validation = validateNumberFormat({
        prefix: cfg.prefix,
        separator: cfg.separator,
        fyLabel,
        zeroPadding: cfg.zero_padding,
        number: cfg.starting_number,
      });
      if (!validation.valid) {
        throw new BadRequestException(validation.errors.join(' '));
      }

      // Mid-FY change warning (§6.4): config changed after numbers were issued.
      const changedMidFy =
        !!existing &&
        existing.current_number > 0 &&
        (existing.prefix !== cfg.prefix ||
          existing.separator !== cfg.separator ||
          existing.fy_format !== cfg.fy_format ||
          existing.starting_number !== cfg.starting_number);
      const warning = changedMidFy
        ? 'Changing numbering mid-financial-year can break GST compliance — consult your CA.'
        : undefined;

      let saved;
      if (existing) {
        [saved] = await tx
          .update(invoiceSequences)
          .set({
            prefix: cfg.prefix,
            separator: cfg.separator,
            fy_format: cfg.fy_format,
            zero_padding: cfg.zero_padding,
            starting_number: cfg.starting_number,
            updated_at: new Date(),
          })
          .where(eq(invoiceSequences.id, existing.id))
          .returning();
      } else {
        [saved] = await tx
          .insert(invoiceSequences)
          .values({
            tenant_id: tenantId,
            document_type: dto.document_type,
            fy_label: fyLabel,
            fy_start_date: fy.startDate,
            fy_end_date: fy.endDate,
            prefix: cfg.prefix,
            separator: cfg.separator,
            fy_format: cfg.fy_format,
            zero_padding: cfg.zero_padding,
            starting_number: cfg.starting_number,
            current_number: 0,
            branch_code: branch,
          })
          .returning();
      }

      await this.audit.log({
        tenantId,
        actorUserId: userId,
        action: 'invoicing.sequence.upsert',
        resourceType: 'invoice_sequence',
        resourceId: saved!.id,
        afterState: saved as unknown as Record<string, unknown>,
      });
      return { data: saved, warning, sample: validation.sample };
    });
  }

  /**
   * Atomically reserve the next number for a document, inside the caller's
   * transaction (SELECT … FOR UPDATE → increment). Creates the FY sequence row
   * on first use (April-1 reset is implicit via the new fy_label). Returns the
   * formatted number + fy_label. Consumed by invoice creation (Sprint 3).
   */
  async reserveNext(
    tx: Db,
    tenantId: string,
    documentType: string,
    isoDate: string,
    opts: { startMonth?: number } = {},
  ): Promise<{ number: number; formatted: string; fyLabel: string; sequenceId: string }> {
    const base = defaultConfig(documentType);
    const startMonth =
      opts.startMonth ?? (await this.fyStartMonth(tx, tenantId));
    const branch = '';

    // Inherit config from the latest prior sequence for this doc type, if any.
    const [prior] = await tx
      .select()
      .from(invoiceSequences)
      .where(
        and(
          eq(invoiceSequences.tenant_id, tenantId),
          eq(invoiceSequences.document_type, documentType),
          eq(invoiceSequences.branch_code, branch),
        ),
      )
      .orderBy(desc(invoiceSequences.fy_start_date))
      .limit(1);

    const fyFormat = prior?.fy_format ?? base.fy_format;
    const fy = computeFiscalYear(isoDate, startMonth, fyFormat);

    // Lock the current-FY row if it exists.
    const [locked] = await tx
      .select()
      .from(invoiceSequences)
      .where(
        and(
          eq(invoiceSequences.tenant_id, tenantId),
          eq(invoiceSequences.document_type, documentType),
          eq(invoiceSequences.fy_label, fy.label),
          eq(invoiceSequences.branch_code, branch),
        ),
      )
      .for('update')
      .limit(1);

    let row = locked;
    if (!row) {
      [row] = await tx
        .insert(invoiceSequences)
        .values({
          tenant_id: tenantId,
          document_type: documentType,
          fy_label: fy.label,
          fy_start_date: fy.startDate,
          fy_end_date: fy.endDate,
          prefix: prior?.prefix ?? base.prefix,
          separator: prior?.separator ?? base.separator,
          fy_format: fyFormat,
          zero_padding: prior?.zero_padding ?? base.zero_padding,
          starting_number: prior?.starting_number ?? base.starting_number,
          current_number: 0,
          branch_code: branch,
        })
        .returning();
    }

    const nextNumber = Math.max(row!.current_number + 1, row!.starting_number);
    await tx
      .update(invoiceSequences)
      .set({ current_number: nextNumber, updated_at: new Date() })
      .where(eq(invoiceSequences.id, row!.id));

    const formatted = formatNumber({
      prefix: row!.prefix,
      separator: row!.separator,
      fyLabel: fy.label,
      zeroPadding: row!.zero_padding,
      number: nextNumber,
    });
    return { number: nextNumber, formatted, fyLabel: fy.label, sequenceId: row!.id };
  }
}

function defaultConfig(documentType: string): SeqConfig {
  return {
    prefix: DEFAULT_PREFIXES[documentType] ?? 'INV',
    separator: '/',
    fy_format: '26-27',
    zero_padding: 4,
    starting_number: 1,
    current_number: 0,
    branch_code: '',
  };
}
