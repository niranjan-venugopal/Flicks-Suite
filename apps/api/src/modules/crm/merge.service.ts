import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  activities,
  dealPeople,
  deals,
  directoryCompanies,
  directoryPeople,
  emailMessages,
  leads,
  memberships,
  sequenceEnrollments,
} from '@flicks/db/schema';
import type { Db } from '@flicks/db';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventsService } from '../../core/events/domain-events.service';

/**
 * C15 merge + dedupe finder and §19.7 offboarding reassignment.
 * Merging repoints every CRM reference to the survivor inside ONE tenant
 * transaction, then soft-deletes the loser with a `merged_into_id` tombstone.
 * All winner-field choices happen client-side and arrive as a patch.
 */

const LEGAL_SUFFIX = /\s+(pvt\.?|private|ltd\.?|limited|inc\.?|incorporated|llc|llp|gmbh|co\.?|corp\.?|corporation)\.?$/i;
const normName = (n: string) => n.toLowerCase().replace(LEGAL_SUFFIX, '').replace(LEGAL_SUFFIX, '').trim();

@Injectable()
export class MergeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  /** Dedupe finder: people by exact email, companies by domain or normalized name. */
  async candidates(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const people = await tx
        .select({ id: directoryPeople.id, name: directoryPeople.display_name, email: directoryPeople.email })
        .from(directoryPeople)
        .where(and(isNull(directoryPeople.deleted_at), sql`${directoryPeople.email} IS NOT NULL`));
      const byEmail = new Map<string, typeof people>();
      for (const p of people) {
        const k = p.email!.toLowerCase();
        byEmail.set(k, [...(byEmail.get(k) ?? []), p]);
      }
      const personPairs = [...byEmail.values()]
        .filter((g) => g.length > 1)
        .map((g) => ({ type: 'person' as const, a: g[0]!, b: g[1]!, reason: 'same email', confidence: 98 }));

      const companies = await tx
        .select({ id: directoryCompanies.id, name: directoryCompanies.name, domain: directoryCompanies.domain })
        .from(directoryCompanies)
        .where(isNull(directoryCompanies.deleted_at));
      const seen = new Map<string, typeof companies[number]>();
      const companyPairs: Array<{ type: 'company'; a: typeof companies[number]; b: typeof companies[number]; reason: string; confidence: number }> = [];
      for (const c of companies) {
        if (c.domain) {
          const k = `d:${c.domain.toLowerCase()}`;
          const prev = seen.get(k);
          if (prev) companyPairs.push({ type: 'company', a: prev, b: c, reason: 'same domain', confidence: 95 });
          else seen.set(k, c);
        }
        const nk = `n:${normName(c.name)}`;
        const prevN = seen.get(nk);
        if (prevN && prevN.id !== c.id) companyPairs.push({ type: 'company', a: prevN, b: c, reason: 'similar name', confidence: 80 });
        else if (!prevN) seen.set(nk, c);
      }
      // De-dupe pairs that matched on both domain and name.
      const uniq = new Map<string, (typeof companyPairs)[number]>();
      for (const p of companyPairs) uniq.set([p.a.id, p.b.id].sort().join(':'), p);
      return { data: [...personPairs, ...uniq.values()].slice(0, 50) };
    });
  }

  /** What a merge would move — shown in the confirm box. */
  async previewCompanyMerge(tenantId: string, winnerId: string, loserId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      await this.assertCompanies(tx, winnerId, loserId);
      const [people] = await tx.select({ n: sql<number>`count(*)::int` }).from(directoryPeople).where(and(eq(directoryPeople.company_id, loserId), isNull(directoryPeople.deleted_at)));
      const [dealRows] = await tx.select({ n: sql<number>`count(*)::int` }).from(deals).where(and(eq(deals.company_id, loserId), isNull(deals.deleted_at)));
      const [acts] = await tx.select({ n: sql<number>`count(*)::int` }).from(activities).where(eq(activities.company_id, loserId));
      return { data: { people: people!.n, deals: dealRows!.n, activities: acts!.n } };
    });
  }

  async previewPersonMerge(tenantId: string, winnerId: string, loserId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      await this.assertPeople(tx, winnerId, loserId);
      const [dealRows] = await tx.select({ n: sql<number>`count(*)::int` }).from(deals).where(and(eq(deals.primary_person_id, loserId), isNull(deals.deleted_at)));
      const [acts] = await tx.select({ n: sql<number>`count(*)::int` }).from(activities).where(eq(activities.person_id, loserId));
      const [emails] = await tx.select({ n: sql<number>`count(*)::int` }).from(emailMessages).where(eq(emailMessages.person_id, loserId));
      return { data: { deals: dealRows!.n, activities: acts!.n, emails: emails!.n } };
    });
  }

  /** Merge two people: repoint deals/participants/activities/emails/enrollments/leads. */
  async mergePeople(tenantId: string, userId: string, winnerId: string, loserId: string, patch: Record<string, string> = {}) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertPeople(tx, winnerId, loserId);
        await tx.update(deals).set({ primary_person_id: winnerId }).where(eq(deals.primary_person_id, loserId));
        // Participants: drop loser rows that would collide with an existing winner row.
        const winnerDeals = await tx.select({ deal_id: dealPeople.deal_id }).from(dealPeople).where(eq(dealPeople.person_id, winnerId));
        const winnerDealIds = winnerDeals.map((d) => d.deal_id);
        if (winnerDealIds.length) {
          await tx.delete(dealPeople).where(and(eq(dealPeople.person_id, loserId), inArray(dealPeople.deal_id, winnerDealIds)));
        }
        await tx.update(dealPeople).set({ person_id: winnerId }).where(eq(dealPeople.person_id, loserId));
        await tx.update(activities).set({ person_id: winnerId }).where(eq(activities.person_id, loserId));
        await tx.update(emailMessages).set({ person_id: winnerId }).where(eq(emailMessages.person_id, loserId));
        // Enrollments: exit the loser's active ones (the winner may already be enrolled).
        await tx.update(sequenceEnrollments)
          .set({ status: 'exited', exit_reason: 'manual', updated_at: new Date() })
          .where(and(eq(sequenceEnrollments.person_id, loserId), eq(sequenceEnrollments.status, 'active')));
        await tx.update(leads).set({ converted_person_id: winnerId }).where(eq(leads.converted_person_id, loserId));

        const allowed = ['first_name', 'last_name', 'email', 'phone', 'title'];
        const fieldPatch = Object.fromEntries(Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v));
        if (Object.keys(fieldPatch).length) {
          // The loser is about to be tombstoned, so its unique email frees up.
          if (fieldPatch.email) {
            await tx.update(directoryPeople).set({ email: null }).where(eq(directoryPeople.id, loserId));
          }
          await tx.update(directoryPeople).set({ ...fieldPatch, updated_at: new Date(), updated_by: userId }).where(eq(directoryPeople.id, winnerId));
        }
        await tx.update(directoryPeople)
          .set({ deleted_at: new Date(), merged_into_id: winnerId, updated_by: userId })
          .where(eq(directoryPeople.id, loserId));

        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.contact.merge', resourceType: 'person', resourceId: winnerId, metadata: { loser_id: loserId } });
        await this.domainEvents.publish(
          { name: 'crm.contact.merged', tenantId, actorUserId: userId, payload: { winner_id: winnerId, loser_id: loserId } },
          tx,
        );
        return { data: { winner_id: winnerId, loser_id: loserId } };
      },
      userId,
    );
  }

  /** Merge two companies: repoint people/deals/activities/leads. */
  async mergeCompanies(tenantId: string, userId: string, winnerId: string, loserId: string, patch: Record<string, string> = {}) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        await this.assertCompanies(tx, winnerId, loserId);
        await tx.update(directoryPeople).set({ company_id: winnerId }).where(eq(directoryPeople.company_id, loserId));
        await tx.update(deals).set({ company_id: winnerId }).where(eq(deals.company_id, loserId));
        await tx.update(activities).set({ company_id: winnerId }).where(eq(activities.company_id, loserId));
        await tx.update(leads).set({ converted_company_id: winnerId }).where(eq(leads.converted_company_id, loserId));

        const allowed = ['name', 'domain', 'website', 'industry', 'phone', 'size_band'];
        const fieldPatch = Object.fromEntries(Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v));
        if (Object.keys(fieldPatch).length) {
          if (fieldPatch.domain) {
            await tx.update(directoryCompanies).set({ domain: null }).where(eq(directoryCompanies.id, loserId));
          }
          await tx.update(directoryCompanies).set({ ...fieldPatch, updated_at: new Date(), updated_by: userId }).where(eq(directoryCompanies.id, winnerId));
        }
        await tx.update(directoryCompanies)
          .set({ deleted_at: new Date(), merged_into_id: winnerId, updated_by: userId })
          .where(eq(directoryCompanies.id, loserId));

        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.company.merge', resourceType: 'company', resourceId: winnerId, metadata: { loser_id: loserId } });
        await this.domainEvents.publish(
          { name: 'crm.company.merged', tenantId, actorUserId: userId, payload: { winner_id: winnerId, loser_id: loserId } },
          tx,
        );
        return { data: { winner_id: winnerId, loser_id: loserId } };
      },
      userId,
    );
  }

  // ─── §19.7 offboarding reassignment ─────────────────────────────────────────

  async reassignPreview(tenantId: string, fromUserId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [openDeals] = await tx.select({ n: sql<number>`count(*)::int` }).from(deals)
        .where(and(eq(deals.owner_user_id, fromUserId), eq(deals.status, 'open'), isNull(deals.deleted_at)));
      const [openActs] = await tx.select({ n: sql<number>`count(*)::int` }).from(activities)
        .where(and(eq(activities.assignee_user_id, fromUserId), sql`${activities.completed_at} IS NULL`));
      const [activeLeads] = await tx.select({ n: sql<number>`count(*)::int` }).from(leads)
        .where(and(eq(leads.owner_user_id, fromUserId), sql`${leads.status} IN ('new','working')`));
      return { data: { open_deals: openDeals!.n, open_activities: openActs!.n, active_leads: activeLeads!.n } };
    });
  }

  /** Move all open work from one member to another (deactivation flow, §19.7). */
  async reassign(tenantId: string, userId: string, fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) throw new BadRequestException('Pick a different member to receive the work');
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [target] = await tx.select({ id: memberships.id }).from(memberships)
          .where(and(eq(memberships.user_id, toUserId), eq(memberships.status, 'active'), ne(memberships.role, 'auditor')))
          .limit(1);
        if (!target) throw new BadRequestException('The receiving member must be active (and not an auditor)');

        const movedDeals = await tx.update(deals)
          .set({ owner_user_id: toUserId, updated_at: new Date(), updated_by: userId })
          .where(and(eq(deals.owner_user_id, fromUserId), eq(deals.status, 'open'), isNull(deals.deleted_at)))
          .returning({ id: deals.id });
        const movedActs = await tx.update(activities)
          .set({ assignee_user_id: toUserId, updated_at: new Date() })
          .where(and(eq(activities.assignee_user_id, fromUserId), sql`${activities.completed_at} IS NULL`))
          .returning({ id: activities.id });
        const movedLeads = await tx.update(leads)
          .set({ owner_user_id: toUserId, updated_at: new Date() })
          .where(and(eq(leads.owner_user_id, fromUserId), sql`${leads.status} IN ('new','working')`))
          .returning({ id: leads.id });

        await this.audit.log({
          tenantId, actorUserId: userId, action: 'crm.reassign', resourceType: 'user', resourceId: fromUserId,
          metadata: { to_user_id: toUserId, deals: movedDeals.length, activities: movedActs.length, leads: movedLeads.length },
        });
        return { data: { deals: movedDeals.length, activities: movedActs.length, leads: movedLeads.length } };
      },
      userId,
    );
  }

  // ─── Guards ──────────────────────────────────────────────────────────────────

  // Both rows are locked FOR UPDATE in a deterministic (id-sorted) order so
  // two opposing merges — mergePeople(A,B) ∥ mergePeople(B,A) — serialize on
  // the same first lock instead of cross-tombstoning. Ordering the lock avoids
  // a lock-order deadlock. Whichever merge commits first soft-deletes a row;
  // the second then re-reads and fails the "both must exist" check.
  private async assertPeople(tx: Db, winnerId: string, loserId: string) {
    if (winnerId === loserId) throw new BadRequestException('Pick two different records');
    const rows = await tx.select({ id: directoryPeople.id }).from(directoryPeople)
      .where(and(inArray(directoryPeople.id, [winnerId, loserId]), isNull(directoryPeople.deleted_at)))
      .orderBy(asc(directoryPeople.id))
      .for('update');
    if (rows.length !== 2) throw new NotFoundException('Both people must exist (and not be deleted)');
  }

  private async assertCompanies(tx: Db, winnerId: string, loserId: string) {
    if (winnerId === loserId) throw new BadRequestException('Pick two different records');
    const rows = await tx.select({ id: directoryCompanies.id }).from(directoryCompanies)
      .where(and(inArray(directoryCompanies.id, [winnerId, loserId]), isNull(directoryCompanies.deleted_at)))
      .orderBy(asc(directoryCompanies.id))
      .for('update');
    if (rows.length !== 2) throw new NotFoundException('Both companies must exist (and not be deleted)');
  }
}
