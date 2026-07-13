import { Injectable } from '@nestjs/common';
import { and, ilike, isNull, or } from 'drizzle-orm';
import { deals, directoryCompanies, directoryPeople } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';

/**
 * Global CRM search (PRD v5 §19.8) — the ⌘K palette. Trigram/ILIKE across the
 * three primary objects (companies, people, deals), accelerated by the pg_trgm
 * GIN indexes from 0031. Tenant-scoped by RLS; each bucket is capped so the
 * query stays fast (< 150ms P95 at 10k records) and the palette stays snappy.
 */
@Injectable()
export class SearchService {
  constructor(private readonly db: DatabaseService) {}

  async search(tenantId: string, rawQuery: string, limit = 8) {
    const q = (rawQuery ?? '').trim();
    if (q.length < 2) {
      return { data: { query: q, companies: [], people: [], deals: [] } };
    }
    // Escape ILIKE metacharacters (default escape char is backslash).
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const cap = Math.min(Math.max(limit, 1), 20);

    return this.db.withTenant(tenantId, async (tx) => {
      const [companies, people, dealRows] = await Promise.all([
        tx
          .select({ id: directoryCompanies.id, name: directoryCompanies.name, domain: directoryCompanies.domain })
          .from(directoryCompanies)
          .where(
            and(
              isNull(directoryCompanies.deleted_at),
              or(ilike(directoryCompanies.name, like), ilike(directoryCompanies.domain, like)),
            ),
          )
          .limit(cap),
        tx
          .select({ id: directoryPeople.id, display_name: directoryPeople.display_name, email: directoryPeople.email, company_id: directoryPeople.company_id })
          .from(directoryPeople)
          .where(
            and(
              isNull(directoryPeople.deleted_at),
              or(ilike(directoryPeople.display_name, like), ilike(directoryPeople.email, like)),
            ),
          )
          .limit(cap),
        tx
          .select({ id: deals.id, title: deals.title, status: deals.status, value_base_amount: deals.value_base_amount })
          .from(deals)
          .where(and(isNull(deals.deleted_at), ilike(deals.title, like)))
          .limit(cap),
      ]);
      return { data: { query: q, companies, people, deals: dealRows } };
    });
  }
}
