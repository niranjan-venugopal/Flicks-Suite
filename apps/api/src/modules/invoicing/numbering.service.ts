import { Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, desc, ne, sql } from 'drizzle-orm';
import {
  invoiceSequences,
  tenants,
  invoices,
  creditNotes,
  debitNotes,
} from '@flicks/db/schema';
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
  SERIES_HORIZON,
  type FyInfo,
  type NumberFormatParts,
  type SeriesMode,
} from './numbering.util';

const DOC_TYPES = ['INVOICE', 'QUOTE', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const;

/**
 * Round P R2 — the continuous counter row. One per (tenant, document type,
 * branch); the existing unique index on (tenant_id, document_type, fy_label,
 * branch_code) keeps it single. It is never an FY row: every FY lookup below
 * filters it out by label.
 */
const ALL_LABEL = 'ALL';
const ALL_END_DATE = '9999-12-31';

interface SeqConfig {
  prefix: string;
  separator: string;
  fy_format: string;
  zero_padding: number;
  starting_number: number;
  current_number: number;
  branch_code: string;
  series_mode: SeriesMode;
}

type SequenceRow = typeof invoiceSequences.$inferSelect;

/** The stored mode, defensively narrowed (the column is CHECKed in 0066). */
function modeOf(row: { series_mode?: string | null } | undefined): SeriesMode {
  return row?.series_mode === 'continuous' ? 'continuous' : 'fiscal_year';
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** True for a real calendar date in YYYY-MM-DD (V8 rolls 2026-02-30 forward; the round-trip catches it). */
function isCalendarDate(iso: string): boolean {
  const t = new Date(`${iso}T00:00:00Z`).getTime();
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso;
}

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
 *
 * Round P R2 — two series modes per document type. The current-FY row is the
 * config holder (prefix, separator, zero_padding, starting_number,
 * series_mode) in both modes and FY rollover copies it forward, so the mode
 * survives April 1 with no special case. In 'continuous' mode the counter
 * lives in the sentinel 'ALL' row (fy_end_date 9999-12-31) and never resets;
 * the number is printed without the FY token (prefix LB24 + pad 5 + separator
 * '' → LB2400001) while invoices.fy_label still records the document's own
 * FY, so GSTR-1 period grouping is unchanged.
 *
 * The mode is a per-document-type choice, not a per-FY-row one: reserveNext()
 * branches on the DOCUMENT's own FY row (a backdated or future-dated
 * document lands on a different row than the one the tab edits), so upsert()
 * keeps every FY row of the doc type in agreement — past rows follow the
 * mode (their own prefix/format stays: an old FY series is never
 * re-numbered), future rows (created by a document dated into the next FY)
 * take the whole config, which is what that FY starts with. In continuous
 * mode the number is always printed with the 'ALL' row's config, which
 * upsert() refreshes on every save, so a backdated continuous document never
 * borrows a stale prefix from its FY row.
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

  /** Tenant + doc type + branch, FY rows only (the 'ALL' counter row excluded). */
  private fyScope(tenantId: string, documentType: string, branch: string) {
    return and(
      eq(invoiceSequences.tenant_id, tenantId),
      eq(invoiceSequences.document_type, documentType),
      eq(invoiceSequences.branch_code, branch),
      ne(invoiceSequences.fy_label, ALL_LABEL),
    );
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
    const scope = this.fyScope(tenantId, documentType, branch);
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

  /**
   * The latest FY row for a doc type — the config reserveNext() copies into
   * a new FY's row, and what list()/upsert() fall back to between April 1 and
   * the first document of the new FY (so a continuous series is not shown,
   * or silently re-saved, as a financial-year one in that window).
   */
  private async latestFyRow(
    tx: Db,
    tenantId: string,
    documentType: string,
    branch: string,
  ): Promise<SequenceRow | undefined> {
    const [row] = await tx
      .select()
      .from(invoiceSequences)
      .where(this.fyScope(tenantId, documentType, branch))
      .orderBy(desc(invoiceSequences.fy_start_date), desc(invoiceSequences.current_number))
      .limit(1);
    return row;
  }

  /** The continuous counter row, if the mode was ever enabled. */
  private async findAllRow(
    tx: Db,
    tenantId: string,
    documentType: string,
    branch: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<SequenceRow | undefined> {
    const q = tx
      .select()
      .from(invoiceSequences)
      .where(
        and(
          eq(invoiceSequences.tenant_id, tenantId),
          eq(invoiceSequences.document_type, documentType),
          eq(invoiceSequences.branch_code, branch),
          eq(invoiceSequences.fy_label, ALL_LABEL),
        ),
      )
      .limit(1);
    const [row] = opts.forUpdate ? await q.for('update') : await q;
    return row;
  }

  /**
   * Whether `formatted` is already the number of a document of this type in
   * the tenant — the next create would then hit the per-tenant unique index
   * (deleted and cancelled documents keep their number, so they count). Each
   * doc type has its own table and index; quotes live in `invoices`.
   */
  private async numberInUse(
    tx: Db,
    tenantId: string,
    documentType: string,
    formatted: string,
  ): Promise<boolean> {
    if (documentType === 'CREDIT_NOTE') {
      const [hit] = await tx
        .select({ id: creditNotes.id })
        .from(creditNotes)
        .where(
          and(eq(creditNotes.tenant_id, tenantId), eq(creditNotes.credit_note_number, formatted)),
        )
        .limit(1);
      return !!hit;
    }
    if (documentType === 'DEBIT_NOTE') {
      const [hit] = await tx
        .select({ id: debitNotes.id })
        .from(debitNotes)
        .where(
          and(eq(debitNotes.tenant_id, tenantId), eq(debitNotes.debit_note_number, formatted)),
        )
        .limit(1);
      return !!hit;
    }
    const [hit] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.tenant_id, tenantId), eq(invoices.invoice_number, formatted)))
      .limit(1);
    return !!hit;
  }

  /** The message for a config whose next number already exists. */
  private static numberTakenMessage(formatted: string): string {
    return (
      `The next number ${formatted} is already used by an existing document — ` +
      'change the prefix or the starting number.'
    );
  }

  /** Current-FY sequences for all four document types (merging defaults). */
  async list(tenantId: string) {
    const today = todayIso();
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
        const mine = all.filter(
          (r) => r.document_type === docType && r.fy_label !== ALL_LABEL,
        );
        const allRow = all.find(
          (r) => r.document_type === docType && r.fy_label === ALL_LABEL,
        );
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
        // Config holder: this FY's row, else the latest FY row (what
        // reserveNext() will copy into this FY's row on first use). The
        // counter is this FY's only — a prior FY's never carries over.
        const seed = row ?? prior;
        const cfg: SeqConfig = seed
          ? {
              prefix: seed.prefix,
              separator: seed.separator,
              fy_format: seed.fy_format,
              zero_padding: seed.zero_padding,
              starting_number: seed.starting_number,
              current_number: row?.current_number ?? 0,
              branch_code: seed.branch_code,
              series_mode: modeOf(seed),
            }
          : defaultConfig(docType);
        const continuous = cfg.series_mode === 'continuous';
        const fyLabel = formatFyLabel(cfg.fy_format, fy.startYear, fy.endYear);
        const continuousCurrent = continuous ? (allRow?.current_number ?? 0) : null;
        const nextNumber = Math.max(
          (continuous ? continuousCurrent! : cfg.current_number) + 1,
          cfg.starting_number,
        );
        return {
          id: row?.id ?? null,
          document_type: docType,
          fy_label: fyLabel,
          ...cfg,
          continuous_current_number: continuousCurrent,
          next_number_preview: formatNumber({
            prefix: cfg.prefix,
            separator: cfg.separator,
            fyLabel: continuous ? null : fyLabel,
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
    const onDate = dto.on_date ?? todayIso();
    if (!isCalendarDate(onDate)) {
      throw new BadRequestException('on_date must be a valid YYYY-MM-DD date');
    }
    const branch = dto.branch_code ?? '';
    return this.db.withTenant(tenantId, async (tx) => {
      const startMonth = await this.fyStartMonth(tx, tenantId);
      const base = defaultConfig(dto.document_type);
      const rows = await tx
        .select()
        .from(invoiceSequences)
        .where(this.fyScope(tenantId, dto.document_type, branch))
        .orderBy(desc(invoiceSequences.fy_start_date), desc(invoiceSequences.current_number));
      const latest = rows[0]; // config holder (reserveNext's `prior`)
      const allRow = await this.findAllRow(tx, tenantId, dto.document_type, branch);

      const mode: SeriesMode = dto.series_mode ?? modeOf(latest);
      const cfg: SeqConfig = {
        prefix: dto.prefix ?? latest?.prefix ?? base.prefix,
        separator: dto.separator ?? latest?.separator ?? base.separator,
        fy_format: dto.fy_format ?? latest?.fy_format ?? base.fy_format,
        zero_padding: dto.zero_padding ?? latest?.zero_padding ?? base.zero_padding,
        starting_number:
          dto.starting_number ?? latest?.starting_number ?? base.starting_number,
        current_number: 0,
        branch_code: branch,
        series_mode: mode,
      };
      const fy = computeFiscalYear(onDate, startMonth, cfg.fy_format);
      const fyLabel = dto.fy_label ?? fy.label;
      // The counter that will actually issue on `onDate`: the ALL row in
      // continuous mode; otherwise that date's own FY row (window first,
      // label fallback as findFyRow) — never a previous FY's counter.
      const fyRow =
        rows.find((r) => r.fy_start_date === fy.startDate) ??
        rows.find((r) => r.fy_label === fyLabel);
      cfg.current_number =
        mode === 'continuous' ? (allRow?.current_number ?? 0) : (fyRow?.current_number ?? 0);
      const nextNumber = Math.max(cfg.current_number + 1, cfg.starting_number);
      const parts: NumberFormatParts = {
        prefix: cfg.prefix,
        separator: cfg.separator,
        fyLabel: mode === 'continuous' ? null : fyLabel,
        zeroPadding: cfg.zero_padding,
        number: nextNumber,
      };
      const validation = validateNumberFormat(parts, { horizon: SERIES_HORIZON[mode] });
      // Same refusal upsert() applies: a config whose next number already
      // exists is not "valid" — the next create would 409.
      if (
        validation.valid &&
        (await this.numberInUse(tx, tenantId, dto.document_type, validation.sample))
      ) {
        validation.valid = false;
        validation.errors.push(NumberingService.numberTakenMessage(validation.sample));
      }
      return {
        data: {
          document_type: dto.document_type,
          series_mode: mode,
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
   *
   * R2: `series_mode` is stored on the FY row with the rest of the config.
   * When it is 'continuous' the 'ALL' counter row is upserted with the same
   * prefix/separator/zero_padding/starting_number and its current_number
   * preserved (0 when new) — so switching away and back resumes where the
   * series stopped. Warnings (joined into one string): the mid-FY GST note,
   * "Continuous series resumes at N (not at your starting number)" and
   * "Financial-year series resumes at N".
   */
  async upsert(tenantId: string, dto: UpsertSequenceDto, userId: string) {
    const today = todayIso();
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
      // First save of a new FY before any document was issued: inherit the
      // previous FY's config (incl. series_mode) exactly as reserveNext()
      // would, instead of silently resetting a partial save to the defaults.
      const prior = existing
        ? undefined
        : await this.latestFyRow(tx, tenantId, dto.document_type, branch);
      const seed = existing ?? prior;
      const allRow = await this.findAllRow(tx, tenantId, dto.document_type, branch);

      const cfg: SeqConfig = {
        prefix: dto.prefix ?? seed?.prefix ?? base.prefix,
        separator: dto.separator ?? seed?.separator ?? base.separator,
        fy_format: dto.fy_format ?? seed?.fy_format ?? base.fy_format,
        zero_padding: dto.zero_padding ?? seed?.zero_padding ?? base.zero_padding,
        starting_number:
          dto.starting_number ?? seed?.starting_number ?? base.starting_number,
        current_number: existing?.current_number ?? 0,
        branch_code: branch,
        series_mode: dto.series_mode ?? modeOf(seed),
      };
      const fyLabel = formatFyLabel(cfg.fy_format, fy.startYear, fy.endYear);
      const continuous = cfg.series_mode === 'continuous';
      const prevMode = modeOf(seed);
      const issuedOnFy = existing?.current_number ?? 0;
      const issuedOnAll = allRow?.current_number ?? 0;
      // The number the series will actually issue next under this config.
      const nextNumber = Math.max(
        (continuous ? issuedOnAll : issuedOnFy) + 1,
        cfg.starting_number,
      );

      // Hard validation (§6.4) against the next number; the 16-char horizon
      // check is advisory.
      const validation = validateNumberFormat(
        {
          prefix: cfg.prefix,
          separator: cfg.separator,
          fyLabel: continuous ? null : fyLabel,
          zeroPadding: cfg.zero_padding,
          number: nextNumber,
        },
        { horizon: SERIES_HORIZON[cfg.series_mode] },
      );
      if (!validation.valid) {
        throw new BadRequestException(validation.errors.join(' '));
      }
      // A format that collides with a number already issued (e.g. FY mode
      // INV + '' + '2026' + pad 4 issued INV20260001; continuous prefix
      // INV2026 + pad 4 would issue it again) must be refused HERE, where
      // the user can act on it — otherwise every document create 409s with
      // no pointer back to this tab.
      if (await this.numberInUse(tx, tenantId, dto.document_type, validation.sample)) {
        throw new BadRequestException(NumberingService.numberTakenMessage(validation.sample));
      }

      const warnings: string[] = [];
      // Mid-FY change warning (§6.4): the printed series changed after
      // numbers were issued on the series that was in use (the ALL row when
      // it was continuous, else this FY's row). A mode switch or a pad-width
      // change is such a change too.
      const issuedBefore = prevMode === 'continuous' ? issuedOnAll : issuedOnFy;
      const changedMidFy =
        !!seed &&
        issuedBefore > 0 &&
        (seed.prefix !== cfg.prefix ||
          seed.separator !== cfg.separator ||
          seed.fy_format !== cfg.fy_format ||
          seed.zero_padding !== cfg.zero_padding ||
          seed.starting_number !== cfg.starting_number ||
          prevMode !== cfg.series_mode);
      if (changedMidFy) {
        warnings.push(
          'Changing numbering mid-financial-year can break GST compliance — consult your CA.',
        );
      }
      // Switching to continuous when the ALL row already issued numbers past
      // the chosen starting number: the series carries on, it does not
      // restart (deleted drafts stay burned either way).
      if (continuous && prevMode !== 'continuous' && issuedOnAll >= cfg.starting_number) {
        warnings.push(
          `Continuous series resumes at ${validation.sample} (not at your starting number).`,
        );
      }
      // Switching back mid-year when this FY's own counter is what decides
      // the next number (it already issued past the starting number).
      // Nothing issued on it yet → nothing to resume, no sentence.
      if (!continuous && prevMode === 'continuous' && issuedOnFy >= cfg.starting_number) {
        warnings.push(`Financial-year series resumes at ${validation.sample}.`);
      }
      warnings.push(...validation.warnings);

      let saved: SequenceRow | undefined;
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
            series_mode: cfg.series_mode,
            // GREATEST in SQL, never a value read earlier: a concurrent
            // reserveNext() must not lose its increment to this save.
            ...(twinCounter > 0 && {
              current_number: sql<number>`GREATEST(${invoiceSequences.current_number}, ${twinCounter})`,
            }),
            updated_at: new Date(),
          })
          .where(
            and(eq(invoiceSequences.id, existing.id), eq(invoiceSequences.tenant_id, tenantId)),
          )
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
            series_mode: cfg.series_mode,
          })
          .returning();
      }

      // The mode is per document type (see the class doc): every other FY
      // row of this doc type follows the tab. Past rows take the mode only;
      // future rows (a document dated into the next FY created them with
      // the config of that moment) take the whole config so the next FY
      // starts with what the tab shows, in either direction of a switch.
      const siblings = await tx
        .select()
        .from(invoiceSequences)
        .where(
          and(
            this.fyScope(tenantId, dto.document_type, branch),
            ne(invoiceSequences.id, saved!.id),
          ),
        )
        .orderBy(desc(invoiceSequences.fy_start_date), desc(invoiceSequences.current_number));
      const propagated: Array<{ id: string; fy_label: string; fy_start_date: string }> = [];
      for (const sib of siblings) {
        const future = sib.fy_start_date > fy.startDate;
        if (!future) {
          if (modeOf(sib) === cfg.series_mode) continue;
          await tx
            .update(invoiceSequences)
            .set({ series_mode: cfg.series_mode, updated_at: new Date() })
            .where(and(eq(invoiceSequences.id, sib.id), eq(invoiceSequences.tenant_id, tenantId)));
          propagated.push({ id: sib.id, fy_label: sib.fy_label, fy_start_date: sib.fy_start_date });
          continue;
        }
        const sibFy = computeFiscalYear(sib.fy_start_date, startMonth);
        const sibLabel = formatFyLabel(cfg.fy_format, sibFy.startYear, sibFy.endYear);
        // Never move a label onto one another row already holds (a legacy
        // twin from the label-keyed days) — the unique index would 409.
        const labelFree =
          sibLabel === sib.fy_label ||
          (saved!.fy_label !== sibLabel && !siblings.some((o) => o.id !== sib.id && o.fy_label === sibLabel));
        const nextLabel = labelFree ? sibLabel : sib.fy_label;
        const same =
          sib.fy_label === nextLabel &&
          sib.prefix === cfg.prefix &&
          sib.separator === cfg.separator &&
          sib.fy_format === cfg.fy_format &&
          sib.zero_padding === cfg.zero_padding &&
          sib.starting_number === cfg.starting_number &&
          modeOf(sib) === cfg.series_mode;
        if (same) continue;
        await tx
          .update(invoiceSequences)
          .set({
            fy_label: nextLabel,
            prefix: cfg.prefix,
            separator: cfg.separator,
            fy_format: cfg.fy_format,
            zero_padding: cfg.zero_padding,
            starting_number: cfg.starting_number,
            series_mode: cfg.series_mode,
            updated_at: new Date(),
          })
          .where(and(eq(invoiceSequences.id, sib.id), eq(invoiceSequences.tenant_id, tenantId)));
        propagated.push({ id: sib.id, fy_label: nextLabel, fy_start_date: sib.fy_start_date });
      }

      // The continuous counter row: created the first time the mode is
      // enabled (fy_start_date = that day), config refreshed on every save,
      // current_number never touched here — only reserveNext() moves it.
      let allSaved: SequenceRow | undefined;
      if (continuous) {
        [allSaved] = await tx
          .insert(invoiceSequences)
          .values({
            tenant_id: tenantId,
            document_type: dto.document_type,
            fy_label: ALL_LABEL,
            fy_start_date: today,
            fy_end_date: ALL_END_DATE,
            prefix: cfg.prefix,
            separator: cfg.separator,
            fy_format: cfg.fy_format,
            zero_padding: cfg.zero_padding,
            starting_number: cfg.starting_number,
            current_number: 0,
            branch_code: branch,
            series_mode: 'continuous',
          })
          .onConflictDoUpdate({
            target: [
              invoiceSequences.tenant_id,
              invoiceSequences.document_type,
              invoiceSequences.fy_label,
              invoiceSequences.branch_code,
            ],
            set: {
              prefix: cfg.prefix,
              separator: cfg.separator,
              fy_format: cfg.fy_format,
              zero_padding: cfg.zero_padding,
              starting_number: cfg.starting_number,
              series_mode: 'continuous',
              updated_at: new Date(),
            },
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
        ...((foldedTwins.length > 0 || allSaved || propagated.length > 0) && {
          metadata: {
            ...(foldedTwins.length > 0 && { folded_twins: foldedTwins }),
            ...(allSaved && {
              continuous_counter: { id: allSaved.id, current_number: allSaved.current_number },
            }),
            // The other FY rows this save brought in line with the tab.
            ...(propagated.length > 0 && { propagated_rows: propagated }),
          },
        }),
      });
      return {
        data: {
          ...saved!,
          continuous_current_number: continuous ? (allSaved?.current_number ?? 0) : null,
        },
        warning: warnings.length > 0 ? warnings.join(' ') : undefined,
        sample: validation.sample,
      };
    });
  }

  /**
   * Atomically reserve the next number for a document, inside the caller's
   * transaction. Serialised per (tenant, doc type) with a transaction-scoped
   * advisory lock, so two first documents of a new FY can't race the unique
   * index (SELECT … FOR UPDATE alone has nothing to lock when the FY row
   * doesn't exist yet). Creates the FY row on first use (April-1 reset is
   * implicit via the new fy_start_date), inheriting the latest FY row's
   * config — series_mode included, so a continuous series survives rollover.
   * In continuous mode the 'ALL' row is the counter (locked / created under
   * the same advisory lock) and the number carries no FY token. Returns the
   * formatted number + the document's own fy_label in both modes. Consumed by
   * invoice/note creation.
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

    // Inherit config from the latest FY sequence for this doc type, if any
    // (the current FY's own row when it exists — highest counter first).
    const prior = await this.latestFyRow(tx, tenantId, documentType, branch);

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
          series_mode: prior ? modeOf(prior) : base.series_mode,
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

    // Print with the row's own format — the row is the source of truth once
    // it exists (a format change via upsert lands here, not on `prior`). The
    // document's FY label is recorded in both modes (GSTR-1 period grouping).
    const fyLabel = formatFyLabel(row.fy_format, fy.startYear, fy.endYear);

    // The mode is per document type: upsert() keeps every FY row in
    // agreement and a row created here inherits `prior`'s, so the document's
    // own row answers for the tab's choice whatever the document's date.
    if (modeOf(row) === 'continuous') {
      let allRow = await this.findAllRow(tx, tenantId, documentType, branch, {
        forUpdate: true,
      });
      if (!allRow) {
        // upsert() creates this row when the mode is enabled; only a row
        // removed by hand gets here. Same pattern as the FY row above; the
        // config comes from the latest FY row (the tab's), not from a
        // possibly older row the document's date happens to fall in.
        const cfgRow = prior ?? row;
        await tx
          .insert(invoiceSequences)
          .values({
            tenant_id: tenantId,
            document_type: documentType,
            fy_label: ALL_LABEL,
            fy_start_date: todayIso(),
            fy_end_date: ALL_END_DATE,
            prefix: cfgRow.prefix,
            separator: cfgRow.separator,
            fy_format: cfgRow.fy_format,
            zero_padding: cfgRow.zero_padding,
            starting_number: cfgRow.starting_number,
            current_number: 0,
            branch_code: branch,
            series_mode: 'continuous',
          })
          .onConflictDoNothing();
        allRow = await this.findAllRow(tx, tenantId, documentType, branch, {
          forUpdate: true,
        });
      }
      if (!allRow) {
        throw new Error(
          `Could not establish the continuous ${documentType} numbering sequence`,
        );
      }
      // The ALL row holds the counter AND the series' config (refreshed by
      // every save): a continuous number prints the same whichever FY the
      // document is dated in — never a stale prefix from a past FY's row.
      const nextNumber = Math.max(allRow.current_number + 1, allRow.starting_number);
      await tx
        .update(invoiceSequences)
        .set({ current_number: nextNumber, updated_at: new Date() })
        .where(and(eq(invoiceSequences.id, allRow.id), eq(invoiceSequences.tenant_id, tenantId)));
      const formatted = formatNumber({
        prefix: allRow.prefix,
        separator: allRow.separator,
        fyLabel: null,
        zeroPadding: allRow.zero_padding,
        number: nextNumber,
      });
      return { number: nextNumber, formatted, fyLabel, sequenceId: allRow.id };
    }

    const nextNumber = Math.max(row.current_number + 1, row.starting_number);
    await tx
      .update(invoiceSequences)
      .set({ current_number: nextNumber, updated_at: new Date() })
      .where(and(eq(invoiceSequences.id, row.id), eq(invoiceSequences.tenant_id, tenantId)));

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
    series_mode: 'fiscal_year',
  };
}
