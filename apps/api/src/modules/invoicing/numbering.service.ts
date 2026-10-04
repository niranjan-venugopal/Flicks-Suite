import { Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, desc, ne, sql } from 'drizzle-orm';
import { invoiceSequences, tenants } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { Db } from '@flicks/db';
import type { UpsertSequenceDto, PreviewNumberDto } from './dto/invoicing.dto';
import {
  computeFiscalYear,
  formatFyLabel,
  formatNumber,
  validateNumberFormat,
  DEFAULT_PREFIXES,
  type FyInfo,
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

type SequenceRow = typeof invoiceSequences.$inferSelect;

/**
 * Invoice numbering engine (PRD §6.4): per-doc-type sequences, live preview,
 * hard validation, April-1 FY reset, atomic reservation.
 *
 * Round P R1.4 — the current-FY row is keyed by `fy_start_date`, never by the
 * label: `fy_label` is DERIVED from `fy_format` (26-27 / 2026-27 / …), so
 * matching on it meant a saved non-default format was invisible to list()
 * and upsert() wrote a parallel row at current_number 0. Where that bug has
 * already left two rows for one FY, the row that issued numbers wins
 * (current_number DESC) and the next upsert folds the twin away.
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

  /**
   * The sequence row for one FY window, format-independent. Falls back to a
   * label match so a tenant that moved its fiscal-year start month (same
   * label, different window) keeps its series instead of hitting the unique
   * index. `forUpdate` takes the row lock for reserveNext.
   */
  private async findFyRow(
    tx: Db,
    tenantId: string,
    documentType: string,
    branch: string,
    fy: FyInfo,
    fyLabel: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<SequenceRow | undefined> {
    const scope = and(
      eq(invoiceSequences.tenant_id, tenantId),
      eq(invoiceSequences.document_type, documentType),
      eq(invoiceSequences.branch_code, branch),
    );
    const byWindow = tx
      .select()
      .from(invoiceSequences)
      .where(and(scope, eq(invoiceSequences.fy_start_date, fy.startDate)))
      .orderBy(desc(invoiceSequences.current_number), desc(invoiceSequences.updated_at))
      .limit(1);
    const [row] = opts.forUpdate ? await byWindow.for('update') : await byWindow;
    if (row) return row;

    const byLabel = tx
      .select()
      .from(invoiceSequences)
      .where(and(scope, eq(invoiceSequences.fy_label, fyLabel)))
      .limit(1);
    const [legacy] = opts.forUpdate ? await byLabel.for('update') : await byLabel;
    return legacy;
  }

  /** Current-FY sequences for all four document types (merging defaults). */
  async list(tenantId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.withTenant(tenantId, async (tx) => {
      const startMonth = await this.fyStartMonth(tx, tenantId);
      const fy = computeFiscalYear(today, startMonth);
      // One fetch, resolved per doc type exactly the way reserveNext() does:
      // the current window first (highest counter wins, so a legacy duplicate
      // pair resolves to the row that actually issued numbers), else the row
      // carrying this FY's label under the latest format — the series a
      // tenant that moved its FY start month is still issuing on.
      const all = await tx
        .select()
        .from(invoiceSequences)
        .where(
          and(
            eq(invoiceSequences.tenant_id, tenantId),
            eq(invoiceSequences.branch_code, ''),
          ),
        )
        .orderBy(
          desc(invoiceSequences.fy_start_date),
          desc(invoiceSequences.current_number),
          desc(invoiceSequences.updated_at),
        );

      const data = DOC_TYPES.map((docType) => {
        const mine = all.filter((r) => r.document_type === docType);
        const prior = mine[0]; // latest window, highest counter (reserveNext's `prior`)
        const row =
          mine
            .filter((r) => r.fy_start_date === fy.startDate)
            .sort(
              (a, b) =>
                b.current_number - a.current_number ||
                (b.updated_at?.getTime() ?? 0) - (a.updated_at?.getTime() ?? 0),
            )[0] ??
          (prior
            ? mine.find(
                (r) =>
                  r.fy_label ===
                  formatFyLabel(prior.fy_format, fy.startYear, fy.endYear),
              )
            : undefined);
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
        const fyLabel = formatFyLabel(cfg.fy_format, fy.startYear, fy.endYear);
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
        .orderBy(desc(invoiceSequences.fy_start_date), desc(invoiceSequences.current_number))
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

  /**
   * Create/update the current-FY sequence config. Updates the existing FY row
   * in place (fy_label recomputed for the chosen format) — never a second row
   * for the same FY. `dto.fy_label` is accepted for compatibility but the
   * stored label is always derived from `fy_format`, which is what
   * reserveNext() prints.
   */
  async upsert(tenantId: string, dto: UpsertSequenceDto, userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.withTenant(tenantId, async (tx) => {
      const startMonth = await this.fyStartMonth(tx, tenantId);
      const base = defaultConfig(dto.document_type);
      const branch = dto.branch_code ?? '';
      const fy = computeFiscalYear(today, startMonth);

      // Look the row up by FY window first; the label we'd store is only
      // needed for the legacy fallback, so derive it from the requested (or
      // default) format.
      const probeLabel = formatFyLabel(
        dto.fy_format ?? base.fy_format,
        fy.startYear,
        fy.endYear,
      );
      const existing = await this.findFyRow(
        tx,
        tenantId,
        dto.document_type,
        branch,
        fy,
        probeLabel,
      );

      const cfg: SeqConfig = {
        prefix: dto.prefix ?? existing?.prefix ?? base.prefix,
        separator: dto.separator ?? existing?.separator ?? base.separator,
        fy_format: dto.fy_format ?? existing?.fy_format ?? base.fy_format,
        zero_padding:
          dto.zero_padding ?? existing?.zero_padding ?? base.zero_padding,
        starting_number:
          dto.starting_number ??
          existing?.starting_number ??
          base.starting_number,
        current_number: existing?.current_number ?? 0,
        branch_code: branch,
      };
      const fyLabel = formatFyLabel(cfg.fy_format, fy.startYear, fy.endYear);

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
      let foldedTwins: Array<{
        id: string;
        fy_label: string;
        fy_start_date: string;
        current_number: number;
      }> = [];
      if (existing) {
        if (existing.fy_label !== fyLabel) {
          // A twin row left by the old label-keyed upsert may already hold
          // the label we're moving to (unique index). Fold it away rather
          // than 409 at the user. Within the current window `existing` holds
          // the highest counter, but a same-label twin from ANOTHER window
          // (tenant moved its FY start month) may have issued numbers under
          // this very label — adopt the highest counter so none can repeat.
          foldedTwins = await tx
            .delete(invoiceSequences)
            .where(
              and(
                eq(invoiceSequences.tenant_id, tenantId),
                eq(invoiceSequences.document_type, dto.document_type),
                eq(invoiceSequences.branch_code, branch),
                eq(invoiceSequences.fy_label, fyLabel),
                ne(invoiceSequences.id, existing.id),
              ),
            )
            .returning({
              id: invoiceSequences.id,
              fy_label: invoiceSequences.fy_label,
              fy_start_date: invoiceSequences.fy_start_date,
              current_number: invoiceSequences.current_number,
            });
        }
        const twinCounter = Math.max(0, ...foldedTwins.map((t) => t.current_number));
        [saved] = await tx
          .update(invoiceSequences)
          .set({
            fy_label: fyLabel,
            fy_start_date: fy.startDate,
            fy_end_date: fy.endDate,
            prefix: cfg.prefix,
            separator: cfg.separator,
            fy_format: cfg.fy_format,
            zero_padding: cfg.zero_padding,
            starting_number: cfg.starting_number,
            // GREATEST in SQL, never a value read earlier: a concurrent
            // reserveNext() must not lose its increment to this save.
            ...(twinCounter > 0 && {
              current_number: sql<number>`GREATEST(${invoiceSequences.current_number}, ${twinCounter})`,
            }),
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
        beforeState: existing as unknown as Record<string, unknown> | undefined,
        afterState: saved as unknown as Record<string, unknown>,
        // Support can reconstruct a folded legacy twin from the audit row
        // alone — the diagnostic query only shows rows that still exist.
        ...(foldedTwins.length > 0 && { metadata: { folded_twins: foldedTwins } }),
      });
      return { data: saved, warning, sample: validation.sample };
    });
  }

  /**
   * Atomically reserve the next number for a document, inside the caller's
   * transaction. Serialised per (tenant, doc type) with a transaction-scoped
   * advisory lock, so two first documents of a new FY can't race the unique
   * index (SELECT … FOR UPDATE alone has nothing to lock when the FY row
   * doesn't exist yet). Creates the FY row on first use (April-1 reset is
   * implicit via the new fy_start_date). Returns the formatted number +
   * fy_label. Consumed by invoice/note creation.
   */
  async reserveNext(
    tx: Db,
    tenantId: string,
    documentType: string,
    isoDate: string,
    opts: { startMonth?: number } = {},
  ): Promise<{ number: number; formatted: string; fyLabel: string; sequenceId: string }> {
    const base = defaultConfig(documentType);
    const branch = '';

    // Released at commit/rollback; keyed per tenant + document type so the
    // INVOICE and QUOTE series don't queue behind each other.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${documentType}`}))`,
    );

    const startMonth =
      opts.startMonth ?? (await this.fyStartMonth(tx, tenantId));

    // Inherit config from the latest sequence for this doc type, if any (the
    // current FY's own row when it exists — highest counter first).
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
      .orderBy(desc(invoiceSequences.fy_start_date), desc(invoiceSequences.current_number))
      .limit(1);

    const fyFormat = prior?.fy_format ?? base.fy_format;
    const fy = computeFiscalYear(isoDate, startMonth, fyFormat);

    let row = await this.findFyRow(tx, tenantId, documentType, branch, fy, fy.label, {
      forUpdate: true,
    });
    if (!row) {
      await tx
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
        .onConflictDoNothing();
      row = await this.findFyRow(tx, tenantId, documentType, branch, fy, fy.label, {
        forUpdate: true,
      });
    }
    if (!row) {
      // Unreachable under the advisory lock; surfaced rather than deref'd.
      throw new Error(
        `Could not establish the ${documentType} numbering sequence for FY ${fy.label}`,
      );
    }

    const nextNumber = Math.max(row.current_number + 1, row.starting_number);
    await tx
      .update(invoiceSequences)
      .set({ current_number: nextNumber, updated_at: new Date() })
      .where(eq(invoiceSequences.id, row.id));

    // Print with the row's own format — the row is the source of truth once
    // it exists (a format change via upsert lands here, not on `prior`).
    const fyLabel = formatFyLabel(row.fy_format, fy.startYear, fy.endYear);
    const formatted = formatNumber({
      prefix: row.prefix,
      separator: row.separator,
      fyLabel,
      zeroPadding: row.zero_padding,
      number: nextNumber,
    });
    return { number: nextNumber, formatted, fyLabel, sequenceId: row.id };
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
