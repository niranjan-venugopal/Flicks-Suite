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

export type ImportObject = 'people' | 'companies' | 'leads';
export type DupeStrategy = 'skip' | 'update' | 'create';

/** Targets per object — the mapping UI offers exactly these. */
export const IMPORT_TARGETS: Record<ImportObject, string[]> = {
  people: ['first_name', 'last_name', 'email', 'phone', 'title', 'company_name'],
  companies: ['name', 'domain', 'website', 'industry', 'phone', 'city', 'country_code'],
  leads: ['first_name', 'last_name', 'email', 'phone', 'company_name', 'note', 'source'],
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
  ) {
    const plans = await this.db.withTenant(tenantId, (tx) => this.plan(tx, object, csvText, mapping, strategy));
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
  ) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const plans = await this.plan(tx, object, csvText, mapping, strategy);
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
            else await this.writeLead(tx, tenantId, batch!.id, p);
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
      const rows = await tx.select().from(importBatches).orderBy(desc(importBatches.created_at)).limit(20);
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
              inArray(importBatches.object_type, ['people', 'companies', 'leads']),
            ),
          )
          .limit(1);
        if (!batch) throw new NotFoundException('Import not found');
        if (batch.status === 'undone') throw new BadRequestException('Already undone');
        if (Date.now() - batch.created_at.getTime() > UNDO_WINDOW_MS) {
          throw new BadRequestException('The 24h undo window has passed');
        }
        if (batch.object_type === 'people') {
          await tx.update(directoryPeople).set({ deleted_at: new Date() }).where(and(eq(directoryPeople.import_batch_id, batchId), isNull(directoryPeople.deleted_at)));
        } else if (batch.object_type === 'companies') {
          await tx.update(directoryCompanies).set({ deleted_at: new Date() }).where(and(eq(directoryCompanies.import_batch_id, batchId), isNull(directoryCompanies.deleted_at)));
        } else {
          await tx.update(leads).set({ status: 'discarded', updated_at: new Date() }).where(and(eq(leads.import_batch_id, batchId), sql`${leads.status} IN ('new','working')`));
        }
        const [row] = await tx.update(importBatches).set({ status: 'undone', undone_at: new Date() }).where(eq(importBatches.id, batchId)).returning();
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.import.undo', resourceType: 'import_batch', resourceId: batchId });
        return { data: row! };
      },
      userId,
    );
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async plan(tx: Db, object: ImportObject, csvText: string, mapping: Record<string, string>, strategy: DupeStrategy): Promise<RowPlan[]> {
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
    if (object === 'people' && emails.length) {
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
    if (object === 'leads' && emails.length) {
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
      const fileKey =
        object === 'companies'
          ? (v.domain?.toLowerCase().replace(/^www\./, '') || v.name?.toLowerCase() || '')
          : v.email?.toLowerCase() || '';
      const dupInFile = fileKey ? seenInFile.has(fileKey) : false;
      if (fileKey) seenInFile.add(fileKey);

      if (object === 'people') {
        if (!v.first_name && !v.email) return { row, action: 'error' as const, reason: 'needs a name or email', values: v };
        if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return { row, action: 'error' as const, reason: 'invalid email', values: v };
        if (dupInFile) return { row, action: 'skip' as const, reason: 'duplicate in file', values: v };
        const match = v.email ? personByEmail.get(v.email.toLowerCase()) : undefined;
        if (match) {
          if (strategy === 'skip') return { row, action: 'skip' as const, reason: 'email match', values: v, existing_id: match };
          if (strategy === 'update') return { row, action: 'update' as const, reason: 'email match', values: v, existing_id: match };
        }
        return { row, action: 'create' as const, values: v };
      }
      if (object === 'companies') {
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
      if (!v.first_name && !v.email) return { row, action: 'error' as const, reason: 'needs a name or email', values: v };
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return { row, action: 'error' as const, reason: 'invalid email', values: v };
      if (dupInFile) return { row, action: 'skip' as const, reason: 'duplicate in file', values: v };
      const leadMatch = v.email ? leadByEmail.get(v.email.toLowerCase()) : undefined;
      if (leadMatch) {
        if (strategy === 'skip') return { row, action: 'skip' as const, reason: 'email match', values: v, existing_id: leadMatch };
        if (strategy === 'update') return { row, action: 'update' as const, reason: 'email match', values: v, existing_id: leadMatch };
      }
      return { row, action: 'create' as const, values: v };
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
    if (v.company_name) companyId = await this.findOrCreateCompany(tx, tenantId, userId, batchId, v.company_name);
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

  private async findOrCreateCompany(tx: Db, tenantId: string, userId: string, batchId: string, name: string): Promise<string> {
    const [existing] = await tx
      .select({ id: directoryCompanies.id })
      .from(directoryCompanies)
      .where(and(sql`lower(${directoryCompanies.name}) = ${name.toLowerCase()}`, isNull(directoryCompanies.deleted_at)))
      .limit(1);
    if (existing) return existing.id;
    const [c] = await tx
      .insert(directoryCompanies)
      .values({ tenant_id: tenantId, name, source: 'import', import_batch_id: batchId, created_by: userId })
      .returning({ id: directoryCompanies.id });
    return c!.id;
  }

  private assertObject(object: string): asserts object is ImportObject {
    if (!['people', 'companies', 'leads'].includes(object)) throw new BadRequestException('object must be people | companies | leads');
  }
}
