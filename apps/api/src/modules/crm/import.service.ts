import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { directoryCompanies, directoryPeople, importBatches, leads } from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';
import { scoreLead } from './leads.service';

/**
 * CSV import wizard backend (PRD v5 C14). One object type per run (people /
 * companies / leads), match on person email or company domain/name, three
 * duplicate strategies (skip / update / create). Dry run writes nothing;
 * a real run stamps rows with the batch id so `undo` (24h) can retract
 * exactly what the batch created. Beta cap: 10,000 rows per file.
 */

const MAX_ROWS = 10_000;
const UNDO_WINDOW_MS = 24 * 3600_000;

export type ImportObject = 'people' | 'companies' | 'leads' | 'all';
export type DupeStrategy = 'skip' | 'update' | 'create';
/** 'all' runs: what a row without a usable Type column becomes. */
export type ImportFallbackType = 'contact' | 'lead';

/** Targets per object — the mapping UI offers exactly these. */
export const IMPORT_TARGETS: Record<ImportObject, string[]> = {
  people: ['first_name', 'last_name', 'email', 'phone', 'title', 'company_name'],
  companies: ['name', 'domain', 'website', 'industry', 'phone', 'city', 'country_code'],
  leads: ['first_name', 'last_name', 'email', 'phone', 'company_name', 'note', 'source'],
  // Round C — ONE combined file ("when the client has their own excel"): a
  // Type column decides contact vs lead per row; the company_* columns
  // describe the CONTACT's company (created/linked in the directory), while
  // lead rows keep the company as text only. The company_ prefix also
  // resolves the person/company phone collision.
  all: [
    'type', 'first_name', 'last_name', 'email', 'phone', 'title', 'note', 'source',
    'company_name', 'company_domain', 'company_website', 'company_industry',
    'company_phone', 'company_city', 'company_country_code',
  ],
};

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF. No deps. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/** Suggest a target for a CSV header (Pipedrive/HubSpot-ish names included). */
function suggestTarget(header: string, object: ImportObject): string | null {
  const h = header.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const has = (...keys: string[]) => keys.some((k) => h.includes(k));
  const t = IMPORT_TARGETS[object];
  const pick = (k: string) => (t.includes(k) ? k : null);
  // Combined mode (round C): Type + company-prefixed columns route BEFORE the
  // generic rules — "Company Phone" must land on company_phone, not the
  // person's phone, and "Company" alone is the company name.
  if (object === 'all') {
    if (h === 'type' || h === 'record_type' || h === 'row_type') return 'type';
    if (has('company', 'org', 'account')) {
      if (has('domain')) return 'company_domain';
      if (has('website', 'url')) return 'company_website';
      if (has('industry')) return 'company_industry';
      if (has('phone', 'mobile', 'tel')) return 'company_phone';
      if (has('city')) return 'company_city';
      if (has('country')) return 'company_country_code';
      return 'company_name';
    }
  }
  if (has('email')) return pick('email');
  if (has('first_name', 'firstname')) return pick('first_name');
  if (has('last_name', 'lastname', 'surname')) return pick('last_name');
  // Company/org columns before the generic person-name rule — "Org - Name"
  // must not fall into first_name just because it contains "name".
  if (has('company', 'org', 'account')) return object === 'companies' ? pick('name') : pick('company_name');
  if (has('full_name', 'person_name', 'contact_name', 'name') && object === 'people') return pick('first_name');
  if (has('domain')) return pick('domain');
  if (has('website', 'url')) return pick('website');
  if (has('phone', 'mobile', 'tel')) return pick('phone');
  if (has('title', 'job', 'role', 'designation')) return pick('title');
  if (has('industry')) return pick('industry');
  if (has('city')) return pick('city');
  if (has('country')) return pick('country_code');
  if (has('note', 'message', 'comment', 'description')) return pick('note');
  if (has('source', 'channel')) return pick('source');
  if (has('name') && object === 'companies') return pick('name');
  return null;
}

interface RowPlan {
  row: number;
  action: 'create' | 'update' | 'skip' | 'error';
  reason?: string;
  values: Record<string, string>;
  existing_id?: string;
  /** 'all' runs only: what this row becomes (Type column or the fallback). */
  kind?: 'contact' | 'lead';
}

@Injectable()
export class ImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  /**
   * Downloadable starter file per entity (round B — HubSpot and Zoho both
   * hand out sample import files; neither of our importers ever did).
   * Columns are the real mapping targets, so a filled template auto-maps
   * 100% on upload; the sample rows show the expected shapes.
   */
  template(object: ImportObject) {
    this.assertObject(object);
    const files: Record<ImportObject, { headers: string[]; samples: string[][] }> = {
      leads: {
        headers: ['First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Lead Source', 'Description'],
        samples: [
          ['Asha', 'Rao', 'asha@ripenlabs.in', '+91 98400 12345', 'Ripen Labs', 'Website', 'Asked for a demo of the HRMS'],
          ['Vikram', 'Iyer', 'vikram@meridian.co.in', '', 'Meridian Textiles', 'Referral', ''],
        ],
      },
      people: {
        headers: ['First Name', 'Last Name', 'Email', 'Phone', 'Job Title', 'Company'],
        samples: [
          ['Priya', 'Menon', 'priya@zenithworks.in', '+91 98110 22334', 'Head of Operations', 'Zenith Works'],
          ['Rahul', 'Shah', 'rahul.shah@cobaltapps.com', '', 'CTO', 'Cobalt Apps'],
        ],
      },
      companies: {
        headers: ['Name', 'Domain', 'Website', 'Industry', 'Phone', 'City', 'Country'],
        samples: [
          ['Zenith Works', 'zenithworks.in', 'https://zenithworks.in', 'Manufacturing', '+91 44 2811 0000', 'Chennai', 'IN'],
          ['Cobalt Apps', 'cobaltapps.com', 'https://cobaltapps.com', 'Software', '', 'Pune', 'IN'],
        ],
      },
      // Round C — the combined file: one Contact row with full company
      // columns, one Lead row (company stays text; blank company_* is fine).
      all: {
        headers: ['Type', 'First Name', 'Last Name', 'Email', 'Phone', 'Job Title', 'Lead Source', 'Description', 'Company', 'Company Domain', 'Company Website', 'Company Industry', 'Company Phone', 'Company City', 'Company Country'],
        samples: [
          ['Contact', 'Priya', 'Menon', 'priya@zenithworks.in', '+91 98110 22334', 'Head of Operations', '', 'Met at SaaSBoomi Chennai', 'Zenith Works', 'zenithworks.in', 'https://zenithworks.in', 'Manufacturing', '+91 44 2811 0000', 'Chennai', 'IN'],
          ['Lead', 'Asha', 'Rao', 'asha@ripenlabs.in', '+91 98400 12345', '', 'Website', 'Asked for a demo of the HRMS', 'Ripen Labs', '', '', '', '', '', ''],
        ],
      },
    };
    const f = files[object];
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [f.headers, ...f.samples].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
    return { data: { file_name: `flicks-${object}-template.csv`, csv } };
  }

  /** Step 1–2: parse, return headers + suggested mapping + sample rows. */
  parse(object: ImportObject, csvText: string, fileName?: string) {
    this.assertObject(object);
    const rows = parseCsv(csvText);
    if (rows.length < 2) throw new BadRequestException('The file needs a header row and at least one data row');
    if (rows.length - 1 > MAX_ROWS) throw new BadRequestException(`Beta limit: max ${MAX_ROWS.toLocaleString()} rows per file`);
    const headers = rows[0]!.map((h) => h.trim());
    return {
      data: {
        file_name: fileName ?? null,
        rows: rows.length - 1,
        headers: headers.map((h, i) => ({
          column: h || `Column ${i + 1}`,
          suggested: suggestTarget(h, object),
          samples: rows.slice(1, 4).map((r) => r[i] ?? ''),
        })),
        targets: IMPORT_TARGETS[object],
      },
    };
  }

  /** Step 4: dry run — plan every row, write nothing. */
  async dryRun(
    tenantId: string,
    object: ImportObject,
    csvText: string,
    mapping: Record<string, string>, // csv column -> target
    strategy: DupeStrategy,
    fallbackType: ImportFallbackType = 'contact',
  ) {
    const plans = await this.db.withTenant(tenantId, (tx) => this.plan(tx, object, csvText, mapping, strategy, fallbackType));
    const count = (a: RowPlan['action']) => plans.filter((p) => p.action === a).length;
    return {
      data: {
        rows_read: plans.length,
        will_create: count('create'),
        will_update: count('update'),
        will_skip: count('skip'),
        errors: count('error'),
        preview: plans.slice(0, 50).map((p) => ({ row: p.row, action: p.action, reason: p.reason, values: p.values })),
      },
    };
  }

  /** Step 5: the real run. */
  async run(
    tenantId: string,
    userId: string,
    object: ImportObject,
    csvText: string,
    mapping: Record<string, string>,
    strategy: DupeStrategy,
    fileName?: string,
    fallbackType: ImportFallbackType = 'contact',
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const plans = await this.plan(tx, object, csvText, mapping, strategy, fallbackType);
        const [batch] = await tx
          .insert(importBatches)
          .values({ tenant_id: tenantId, object_type: object, file_name: fileName ?? null, rows_read: plans.length, created_by: userId })
          .returning();
        let created = 0, updated = 0, skipped = 0;
        const errors: Array<{ row: number; error: string }> = [];

        for (const p of plans) {
          if (p.action === 'error') { errors.push({ row: p.row, error: p.reason! }); continue; }
          if (p.action === 'skip') { skipped++; continue; }
          try {
            if (object === 'people') await this.writePerson(tx, tenantId, userId, batch!.id, p);
            else if (object === 'companies') await this.writeCompany(tx, tenantId, userId, batch!.id, p);
            else if (object === 'leads') await this.writeLead(tx, tenantId, batch!.id, p);
            // 'all' — the plan stamped each row's kind (Type column/fallback).
            else if (p.kind === 'lead') await this.writeLead(tx, tenantId, batch!.id, p);
            else await this.writePerson(tx, tenantId, userId, batch!.id, p);
            if (p.action === 'create') created++; else updated++;
          } catch (err) {
            errors.push({ row: p.row, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          }
        }

        const [done] = await tx
          .update(importBatches)
          .set({ rows_created: created, rows_updated: updated, rows_skipped: skipped + errors.length, errors: errors.slice(0, 200) })
          .where(eq(importBatches.id, batch!.id))
          .returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.import.run', resourceType: 'import_batch', resourceId: batch!.id });
        await this.domainEvents.publish(
          { name: 'crm.import.completed', tenantId, actorUserId: userId, payload: { batch_id: batch!.id, object_type: object, created, updated, skipped: skipped + errors.length } },
          tx,
        );
        return { data: done! };
      },
      userId,
    );
  }

  async listBatches(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      // Explicit tenant predicate (round F): this is the "Recent imports"
      // list that showed one tenant's batches to every workspace when a
      // mis-roled production pool bypassed RLS.
      const rows = await tx
        .select()
        .from(importBatches)
        .where(eq(importBatches.tenant_id, tenantId))
        .orderBy(desc(importBatches.created_at))
        .limit(20);
      return { data: rows };
    });
  }

  /** Undo (24h): soft-delete/remove exactly the rows this batch CREATED. */
  async undo(tenantId: string, userId: string, batchId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // Explicit tenant predicate (house rule) + object_type guard: the
        // table is shared with PM, and the leads branch below is the `else`,
        // so an unguarded PM batch id would be treated as a lead import.
        const [batch] = await tx
          .select()
          .from(importBatches)
          .where(
            and(
              eq(importBatches.id, batchId),
              eq(importBatches.tenant_id, tenantId),
              inArray(importBatches.object_type, ['people', 'companies', 'leads', 'all']),
            ),
          )
          .limit(1);
        if (!batch) throw new NotFoundException('Import not found');
        if (batch.status === 'undone') throw new BadRequestException('Already undone');
        if (Date.now() - batch.created_at.getTime() > UNDO_WINDOW_MS) {
          throw new BadRequestException('The 24h undo window has passed');
        }
        // One unconditional sweep (round C): retract whatever the batch
        // stamped in ANY of the three tables — no-ops where it wrote nothing.
        // The old per-object branches also had a real bug: companies
        // auto-created during a PEOPLE import carried the batch id but the
        // people-only branch never touched directory_companies, so undo left
        // them behind. 'all' batches need the sweep by construction.
        await tx.update(directoryPeople).set({ deleted_at: new Date() }).where(and(eq(directoryPeople.import_batch_id, batchId), isNull(directoryPeople.deleted_at)));
        await tx.update(directoryCompanies).set({ deleted_at: new Date() }).where(and(eq(directoryCompanies.import_batch_id, batchId), isNull(directoryCompanies.deleted_at)));
        await tx.update(leads).set({ status: 'discarded', updated_at: new Date() }).where(and(eq(leads.import_batch_id, batchId), sql`${leads.status} IN ('new','working')`));
        const [row] = await tx.update(importBatches).set({ status: 'undone', undone_at: new Date() }).where(eq(importBatches.id, batchId)).returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.import.undo', resourceType: 'import_batch', resourceId: batchId });
        return { data: row! };
      },
      userId,
    );
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async plan(tx: Db, object: ImportObject, csvText: string, mapping: Record<string, string>, strategy: DupeStrategy, fallbackType: ImportFallbackType = 'contact'): Promise<RowPlan[]> {
    this.assertObject(object);
    if (!['skip', 'update', 'create'].includes(strategy)) throw new BadRequestException('Bad duplicate strategy');
    const rows = parseCsv(csvText);
    if (rows.length < 2) throw new BadRequestException('The file needs a header row and at least one data row');
    if (rows.length - 1 > MAX_ROWS) throw new BadRequestException(`Beta limit: max ${MAX_ROWS.toLocaleString()} rows per file`);
    const headers = rows[0]!.map((h) => h.trim());
    const valid = new Set(IMPORT_TARGETS[object]);
    const colToTarget = new Map<number, string>();
    for (const [col, target] of Object.entries(mapping)) {
      if (!target || target === 'skip') continue;
      if (!valid.has(target)) throw new BadRequestException(`Unknown target "${target}" for ${object}`);
      const idx = headers.findIndex((h) => h === col);
      if (idx >= 0) colToTarget.set(idx, target);
    }
    if (colToTarget.size === 0) throw new BadRequestException('Map at least one column');

    // Pre-load the match keys in one query per run.
    const values = rows.slice(1).map((r) => {
      const v: Record<string, string> = {};
      for (const [idx, target] of colToTarget) v[target] = (r[idx] ?? '').trim();
      return v;
    });
    const emails = [...new Set(values.map((v) => v.email?.toLowerCase()).filter(Boolean))] as string[];
    const domains = [...new Set(values.map((v) => v.domain?.toLowerCase().replace(/^www\./, '')).filter(Boolean))] as string[];
    const names = [...new Set(values.map((v) => v.name?.toLowerCase()).filter(Boolean))] as string[];

    const personByEmail = new Map<string, string>();
    const companyByKey = new Map<string, string>();
    const leadByEmail = new Map<string, string>();
    if ((object === 'people' || object === 'all') && emails.length) {
      const found = await tx.select({ id: directoryPeople.id, email: directoryPeople.email }).from(directoryPeople)
        .where(and(inArray(sql`lower(${directoryPeople.email}::text)`, emails), isNull(directoryPeople.deleted_at)));
      for (const f of found) personByEmail.set(f.email!.toLowerCase(), f.id);
    }
    if (object === 'companies' && (domains.length || names.length)) {
      const found = await tx.select({ id: directoryCompanies.id, domain: directoryCompanies.domain, name: directoryCompanies.name }).from(directoryCompanies)
        .where(isNull(directoryCompanies.deleted_at));
      for (const f of found) {
        if (f.domain) companyByKey.set(`d:${f.domain.toLowerCase()}`, f.id);
        companyByKey.set(`n:${f.name.toLowerCase()}`, f.id);
      }
    }
    // Round B — leads were NEVER deduped: this branch simply didn't exist, so
    // the Step-3 strategy screen was a no-op for the most-imported entity and
    // re-uploading a leads file silently doubled every lead (Zoho and HubSpot
    // both match leads on email). Discarded leads don't block a re-import.
    if ((object === 'leads' || object === 'all') && emails.length) {
      const found = await tx.select({ id: leads.id, email: leads.email }).from(leads)
        .where(and(inArray(sql`lower(${leads.email}::text)`, emails), sql`${leads.status} <> 'discarded'`));
      for (const f of found) if (f.email) leadByEmail.set(f.email.toLowerCase(), f.id);
    }

    // Within-file duplicates (both competitors skip these): the FIRST row
    // wins, later rows carrying the same key are skipped whatever the
    // strategy — "update" repeatedly rewriting one record row-by-row is
    // never what anyone means by importing a file.
    const seenInFile = new Set<string>();

    return values.map((v, i) => {
      const row = i + 2; // 1-based + header

      // 'all' (round C): the Type column decides what each row becomes;
      // blank falls back to the wizard's choice; anything else is a per-row
      // error rather than a silent guess.
      let kind: 'contact' | 'lead' | undefined;
      if (object === 'all') {
        const raw = (v.type ?? '').trim().toLowerCase();
        if (!raw) kind = fallbackType;
        else if (['contact', 'contacts', 'person', 'people'].includes(raw)) kind = 'contact';
        else if (['lead', 'leads'].includes(raw)) kind = 'lead';
        else return { row, action: 'error' as const, reason: `unrecognized Type "${(v.type ?? '').trim()}" — use Contact or Lead`, values: v };
      }
      // Per-entity dedupe rules apply per ROW in 'all' mode: a contact row
      // matches directory people; a lead row matches leads; the within-file
      // key carries the kind so a Contact and a Lead may share an email.
      const entity: 'people' | 'companies' | 'leads' =
        object === 'all' ? (kind === 'lead' ? 'leads' : 'people') : object;

      const fileKey =
        entity === 'companies'
          ? (v.domain?.toLowerCase().replace(/^www\./, '') || v.name?.toLowerCase() || '')
          : v.email
            ? `${kind ?? entity}:${v.email.toLowerCase()}`
            : '';
      const dupInFile = fileKey ? seenInFile.has(fileKey) : false;
      if (fileKey) seenInFile.add(fileKey);

      if (entity === 'people') {
        if (!v.first_name && !v.email) return { row, action: 'error' as const, reason: 'needs a name or email', values: v, ...(kind && { kind }) };
        if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return { row, action: 'error' as const, reason: 'invalid email', values: v, ...(kind && { kind }) };
        if (dupInFile) return { row, action: 'skip' as const, reason: 'duplicate in file', values: v, ...(kind && { kind }) };
        const match = v.email ? personByEmail.get(v.email.toLowerCase()) : undefined;
        if (match) {
          if (strategy === 'skip') return { row, action: 'skip' as const, reason: 'email match', values: v, existing_id: match, ...(kind && { kind }) };
          if (strategy === 'update') return { row, action: 'update' as const, reason: 'email match', values: v, existing_id: match, ...(kind && { kind }) };
        }
        return { row, action: 'create' as const, values: v, ...(kind && { kind }) };
      }
      if (entity === 'companies') {
        if (!v.name) return { row, action: 'error' as const, reason: 'company name required', values: v };
        if (dupInFile) return { row, action: 'skip' as const, reason: 'duplicate in file', values: v };
        const domain = v.domain?.toLowerCase().replace(/^www\./, '');
        const match = (domain && companyByKey.get(`d:${domain}`)) || companyByKey.get(`n:${v.name.toLowerCase()}`);
        if (match) {
          if (strategy === 'skip') return { row, action: 'skip' as const, reason: 'domain/name match', values: v, existing_id: match };
          if (strategy === 'update') return { row, action: 'update' as const, reason: 'domain/name match', values: v, existing_id: match };
        }
        return { row, action: 'create' as const, values: v };
      }
      // leads
      if (!v.first_name && !v.email) return { row, action: 'error' as const, reason: 'needs a name or email', values: v, ...(kind && { kind }) };
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return { row, action: 'error' as const, reason: 'invalid email', values: v, ...(kind && { kind }) };
      if (dupInFile) return { row, action: 'skip' as const, reason: 'duplicate in file', values: v, ...(kind && { kind }) };
      const leadMatch = v.email ? leadByEmail.get(v.email.toLowerCase()) : undefined;
      if (leadMatch) {
        if (strategy === 'skip') return { row, action: 'skip' as const, reason: 'email match', values: v, existing_id: leadMatch, ...(kind && { kind }) };
        if (strategy === 'update') return { row, action: 'update' as const, reason: 'email match', values: v, existing_id: leadMatch, ...(kind && { kind }) };
      }
      return { row, action: 'create' as const, values: v, ...(kind && { kind }) };
    });
  }

  private async writePerson(tx: Db, tenantId: string, userId: string, batchId: string, p: RowPlan) {
    const v = p.values;
    if (p.action === 'update' && p.existing_id) {
      const patch: Record<string, unknown> = { updated_at: new Date(), updated_by: userId };
      if (v.first_name) patch.first_name = v.first_name;
      if (v.last_name) patch.last_name = v.last_name;
      if (v.phone) patch.phone = v.phone;
      if (v.title) patch.title = v.title;
      await tx.update(directoryPeople).set(patch).where(eq(directoryPeople.id, p.existing_id));
      return;
    }
    let companyId: string | null = null;
    if (v.company_name) {
      // company_* fields only arrive in 'all' mode; a plain people import
      // passes the bare name exactly as before.
      companyId = await this.findOrCreateCompany(tx, tenantId, userId, batchId, {
        name: v.company_name,
        domain: v.company_domain,
        website: v.company_website,
        industry: v.company_industry,
        phone: v.company_phone,
        city: v.company_city,
        country_code: v.company_country_code,
      });
    }
    await tx.insert(directoryPeople).values({
      tenant_id: tenantId,
      first_name: v.first_name || v.email!.split('@')[0]!,
      last_name: v.last_name || null,
      email: v.email?.toLowerCase() || null,
      phone: v.phone || null,
      title: v.title || null,
      company_id: companyId,
      source: 'import',
      import_batch_id: batchId,
      created_by: userId,
    });
  }

  private async writeCompany(tx: Db, tenantId: string, userId: string, batchId: string, p: RowPlan) {
    const v = p.values;
    if (p.action === 'update' && p.existing_id) {
      const patch: Record<string, unknown> = { updated_at: new Date(), updated_by: userId };
      if (v.website) patch.website = v.website;
      if (v.industry) patch.industry = v.industry;
      if (v.phone) patch.phone = v.phone;
      if (v.city) patch.city = v.city;
      if (v.country_code && /^[a-z]{2}$/i.test(v.country_code)) patch.country_code = v.country_code.toUpperCase();
      await tx.update(directoryCompanies).set(patch).where(eq(directoryCompanies.id, p.existing_id));
      return;
    }
    await tx.insert(directoryCompanies).values({
      tenant_id: tenantId,
      name: v.name!,
      domain: v.domain?.toLowerCase().replace(/^www\./, '') || null,
      website: v.website || null,
      industry: v.industry || null,
      phone: v.phone || null,
      city: v.city || null,
      country_code: v.country_code && /^[a-z]{2}$/i.test(v.country_code) ? v.country_code.toUpperCase() : null,
      source: 'import',
      import_batch_id: batchId,
      created_by: userId,
    });
  }

  private async writeLead(tx: Db, tenantId: string, batchId: string, p: RowPlan) {
    const v = p.values;
    if (p.action === 'update' && p.existing_id) {
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (v.first_name) patch.first_name = v.first_name;
      if (v.last_name) patch.last_name = v.last_name;
      if (v.company_name) patch.company_name = v.company_name;
      if (v.phone) patch.phone = v.phone;
      if (v.note) patch.note = v.note;
      await tx.update(leads).set(patch).where(and(eq(leads.id, p.existing_id), eq(leads.tenant_id, tenantId)));
      return;
    }
    await tx.insert(leads).values({
      tenant_id: tenantId,
      first_name: v.first_name || v.email!.split('@')[0]!,
      last_name: v.last_name || null,
      company_name: v.company_name || null,
      email: v.email?.toLowerCase() || null,
      phone: v.phone || null,
      note: v.note || null,
      source: 'import',
      score: scoreLead({ ...v, source: 'import' }),
      import_batch_id: batchId,
    });
  }

  /**
   * Match by domain, then case-insensitive name; a MATCH returns the id
   * without updating (no surprise overwrites of directory data from a file);
   * a create carries whatever company_* columns the row supplied (round C).
   */
  private async findOrCreateCompany(
    tx: Db,
    tenantId: string,
    userId: string,
    batchId: string,
    c: { name: string; domain?: string; website?: string; industry?: string; phone?: string; city?: string; country_code?: string },
  ): Promise<string> {
    const domain = c.domain?.toLowerCase().replace(/^www\./, '') || null;
    if (domain) {
      const [byDomain] = await tx
        .select({ id: directoryCompanies.id })
        .from(directoryCompanies)
        .where(and(sql`lower(${directoryCompanies.domain}::text) = ${domain}`, isNull(directoryCompanies.deleted_at)))
        .limit(1);
      if (byDomain) return byDomain.id;
    }
    const [existing] = await tx
      .select({ id: directoryCompanies.id })
      .from(directoryCompanies)
      .where(and(sql`lower(${directoryCompanies.name}) = ${c.name.toLowerCase()}`, isNull(directoryCompanies.deleted_at)))
      .limit(1);
    if (existing) return existing.id;
    const [created] = await tx
      .insert(directoryCompanies)
      .values({
        tenant_id: tenantId,
        name: c.name,
        domain,
        website: c.website || null,
        industry: c.industry || null,
        phone: c.phone || null,
        city: c.city || null,
        country_code: c.country_code && /^[a-z]{2}$/i.test(c.country_code) ? c.country_code.toUpperCase() : null,
        source: 'import',
        import_batch_id: batchId,
        created_by: userId,
      })
      .returning({ id: directoryCompanies.id });
    return created!.id;
  }

  private assertObject(object: string): asserts object is ImportObject {
    if (!['people', 'companies', 'leads', 'all'].includes(object)) throw new BadRequestException('object must be people | companies | leads | all');
  }
}
