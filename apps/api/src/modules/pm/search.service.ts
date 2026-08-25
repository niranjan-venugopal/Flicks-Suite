import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { pmIssues, pmTeams } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { PmVisibilityService } from './sync/visibility.service';

/**
 * PM search (PRD v6 §13) — three lexical passes answering the "literal
 * search" complaint without an AI dependency:
 *  1. key prefix  — "ENG-4" / "eng4" matches ENG-4, ENG-40…
 *  2. FTS         — websearch_to_tsquery over the generated tsvector
 *                   (title weight A, description B; comments join v1.5)
 *  3. trigram     — title similarity for partial words ("auth" →
 *                   "authentication") via pg_trgm
 * Results are merged (key > FTS > trigram), deduped, visibility-filtered by
 * the SAME PmVisibilityService the sync path uses. P95 < 200ms @10k target.
 */
@Injectable()
export class PmSearchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly visibility: PmVisibilityService,
  ) {}

  async search(tenantId: string, userId: string, q: string) {
    const query = (q ?? '').trim();
    if (!query) return { data: { issues: [] } };
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const scope = await this.visibility.scopeTx(tx, tenantId, userId);
        if (!scope.teamIds.length) return { data: { issues: [] } };
        if (scope.guest && !scope.projectIds.length) return { data: { issues: [] } };

        // Guests search only inside their invited projects; members inside
        // their visible teams — the SAME rule as list/bootstrap/delta.
        const base = scope.guest
          ? and(
              eq(pmIssues.tenant_id, tenantId),
              inArray(pmIssues.project_id, scope.projectIds),
              isNull(pmIssues.deleted_at),
            )
          : and(
              eq(pmIssues.tenant_id, tenantId),
              inArray(pmIssues.team_id, scope.teamIds),
              isNull(pmIssues.deleted_at),
            );
        const pick = {
          id: pmIssues.id,
          team_id: pmIssues.team_id,
          number: pmIssues.number,
          title: pmIssues.title,
          state_id: pmIssues.state_id,
          priority: pmIssues.priority,
          assignee_user_id: pmIssues.assignee_user_id,
          team_key: pmTeams.key,
        };

        const results: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        const add = (rows: Array<Record<string, unknown>>, source: string) => {
          for (const r of rows) {
            if (seen.has(r.id as string)) continue;
            seen.add(r.id as string);
            results.push({ ...r, match: source });
          }
        };

        // 1. Issue-key prefix: "ENG-42", "eng 4", "eng4".
        const keyMatch = query.match(/^([a-zA-Z][a-zA-Z0-9]{0,5})[-\s]?(\d*)$/);
        if (keyMatch) {
          const teamKey = keyMatch[1]!.toUpperCase();
          const numPrefix = keyMatch[2] ?? '';
          add(
            await tx
              .select(pick)
              .from(pmIssues)
              .innerJoin(pmTeams, eq(pmTeams.id, pmIssues.team_id))
              .where(
                and(
                  base,
                  eq(pmTeams.key, teamKey),
                  numPrefix ? sql`${pmIssues.number}::text LIKE ${numPrefix + '%'}` : sql`true`,
                ),
              )
              .orderBy(pmIssues.number)
              .limit(10),
            'key',
          );
        }

        // 2. FTS (websearch semantics: quoted phrases, or, -exclusions).
        add(
          await tx
            .select(pick)
            .from(pmIssues)
            .innerJoin(pmTeams, eq(pmTeams.id, pmIssues.team_id))
            .where(and(base, sql`${pmIssues}.search_tsv @@ websearch_to_tsquery('english', ${query})`))
            .orderBy(desc(sql`ts_rank(${pmIssues}.search_tsv, websearch_to_tsquery('english', ${query}))`))
            .limit(15),
          'fts',
        );

        // 3. Trigram + substring for partial words. Whole-title similarity
        //    alone under-scores short queries against long titles ("auth" vs
        //    "Authentication session refresh audit" ≈ 0.11), so an ILIKE
        //    branch — served by the same trigram GIN index — guarantees the
        //    word-prefix case.
        if (query.length >= 3) {
          const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
          add(
            await tx
              .select(pick)
              .from(pmIssues)
              .innerJoin(pmTeams, eq(pmTeams.id, pmIssues.team_id))
              .where(
                and(
                  base,
                  sql`(similarity(${pmIssues.title}, ${query}) > 0.12 OR ${pmIssues.title} ILIKE ${'%' + escaped + '%'})`,
                ),
              )
              .orderBy(desc(sql`similarity(${pmIssues.title}, ${query})`))
              .limit(10),
            'trigram',
          );
        }

        return { data: { issues: results.slice(0, 20) } };
      },
      userId,
    );
  }
}
