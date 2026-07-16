import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  activities,
  dealStageHistory,
  deals,
  directoryCompanies,
  directoryPeople,
  emailTemplates,
  leads,
  pipelineStages,
  pipelines,
  samplePacks,
} from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

/**
 * C22 sample data toggle: seed a small, obviously-labelled demo pack so a new
 * workspace can explore every screen, and remove EXACTLY those records later.
 * Every created id is remembered in sample_packs — removal never touches
 * anything the team created themselves.
 */

const MARK = ' (sample)';

@Injectable()
export class SampleDataService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async status(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [pack] = await tx.select().from(samplePacks).limit(1);
      return { data: { loaded: !!pack, created_at: pack?.created_at ?? null } };
    });
  }

  async seed(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [existing] = await tx.select().from(samplePacks).limit(1);
        if (existing) throw new BadRequestException('Sample data is already loaded — remove it first');

        const [pl] = await tx.select().from(pipelines).where(isNull(pipelines.deleted_at)).orderBy(asc(pipelines.display_order)).limit(1);
        if (!pl) throw new BadRequestException('Create a pipeline first (open the Deals board once)');
        const stages = await tx
          .select()
          .from(pipelineStages)
          .where(eq(pipelineStages.pipeline_id, pl.id))
          .orderBy(asc(pipelineStages.display_order));
        const open = stages.filter((s) => s.stage_type === 'open');
        const wonStage = stages.find((s) => s.stage_type === 'won');
        if (open.length === 0) throw new BadRequestException('The pipeline has no open stages');

        const ids: Record<string, string[]> = { directory_companies: [], directory_people: [], deals: [], activities: [], leads: [], email_templates: [] };

        const companies = await tx.insert(directoryCompanies).values([
          { tenant_id: tenantId, name: `TechCorp${MARK}`, domain: 'techcorp-sample.example', industry: 'Software', created_by: userId },
          { tenant_id: tenantId, name: `Meridian Retail${MARK}`, domain: 'meridian-sample.example', industry: 'Retail', created_by: userId },
        ]).returning({ id: directoryCompanies.id });
        ids.directory_companies = companies.map((c) => c.id);

        const people = await tx.insert(directoryPeople).values([
          { tenant_id: tenantId, first_name: 'Amanda', last_name: 'Reyes', email: 'amanda@techcorp-sample.example', title: 'VP Ops', company_id: companies[0]!.id, created_by: userId },
          { tenant_id: tenantId, first_name: 'Rohit', last_name: 'Menon', email: 'rohit@meridian-sample.example', title: 'Procurement', company_id: companies[1]!.id, created_by: userId },
          { tenant_id: tenantId, first_name: 'Lena', last_name: 'Fischer', email: 'lena@techcorp-sample.example', title: 'CTO', company_id: companies[0]!.id, created_by: userId },
        ]).returning({ id: directoryPeople.id });
        ids.directory_people = people.map((p) => p.id);

        const dealRows = [
          { title: `TechCorp — Suite rollout${MARK}`, company: 0, person: 0, stage: open[0]!, value: '450000' },
          { title: `Meridian renewal${MARK}`, company: 1, person: 1, stage: open[Math.min(1, open.length - 1)]!, value: '180000' },
          { title: `TechCorp — training add-on${MARK}`, company: 0, person: 2, stage: wonStage ?? open[0]!, value: '95000' },
        ];
        for (const d of dealRows) {
          const isWon = d.stage.stage_type === 'won';
          const [row] = await tx.insert(deals).values({
            tenant_id: tenantId,
            pipeline_id: pl.id,
            stage_id: d.stage.id,
            title: d.title,
            company_id: companies[d.company]!.id,
            primary_person_id: people[d.person]!.id,
            owner_user_id: userId,
            value_amount: d.value,
            currency: 'INR',
            fx_rate_to_base: '1.000000',
            value_base_amount: d.value,
            expected_close_date: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
            status: isWon ? 'won' : 'open',
            won_at: isWon ? new Date() : null,
            source: 'manual',
            created_by: userId,
            updated_by: userId,
          }).returning({ id: deals.id });
          ids.deals.push(row!.id);
          await tx.insert(dealStageHistory).values({ tenant_id: tenantId, deal_id: row!.id, from_stage_id: null, to_stage_id: d.stage.id, changed_by: userId });
        }

        const acts = await tx.insert(activities).values([
          { tenant_id: tenantId, type: 'call', subject: `Intro call with Amanda${MARK}`, deal_id: ids.deals[0], person_id: people[0]!.id, assignee_user_id: userId, due_at: new Date(Date.now() + 2 * 86_400_000), created_by: userId },
          { tenant_id: tenantId, type: 'task', subject: `Send renewal terms${MARK}`, deal_id: ids.deals[1], person_id: people[1]!.id, assignee_user_id: userId, due_at: new Date(Date.now() - 86_400_000), created_by: userId },
        ]).returning({ id: activities.id });
        ids.activities = acts.map((a) => a.id);

        const leadRows = await tx.insert(leads).values([
          { tenant_id: tenantId, first_name: 'Asha', last_name: 'Rao', email: 'asha@newco-sample.example', company_name: `NewCo${MARK}`, source: 'form:pricing', score: 30 },
          { tenant_id: tenantId, first_name: 'Daniel', last_name: 'Costa', email: 'daniel@verde-sample.example', company_name: `Verde Foods${MARK}`, source: 'manual', score: 20 },
        ]).returning({ id: leads.id });
        ids.leads = leadRows.map((l) => l.id);

        const tpl = await tx.insert(emailTemplates).values({
          tenant_id: tenantId, name: `Intro — first touch${MARK}`,
          subject: 'Quick intro, {{first_name}}?', body_html: '<p>Hi {{first_name}},</p><p>Saw {{company}} is growing — worth a quick chat?</p>',
          created_by: userId,
        }).onConflictDoNothing().returning({ id: emailTemplates.id });
        ids.email_templates = tpl.map((t) => t.id);

        await tx.insert(samplePacks).values({ tenant_id: tenantId, record_ids: ids, created_by: userId });
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.sample_data.seed', resourceType: 'tenant', resourceId: tenantId });
        return { data: { loaded: true, counts: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.length])) } };
      },
      userId,
    );
  }

  async remove(tenantId: string, userId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        const [pack] = await tx.select().from(samplePacks).limit(1);
        if (!pack) throw new NotFoundException('No sample data is loaded');
        const ids = pack.record_ids as Record<string, string[]>;
        // FK-safe order: children first. Deals cascade their history/products.
        if (ids.activities?.length) await tx.delete(activities).where(inArray(activities.id, ids.activities));
        if (ids.deals?.length) await tx.delete(deals).where(inArray(deals.id, ids.deals));
        if (ids.leads?.length) await tx.delete(leads).where(inArray(leads.id, ids.leads));
        if (ids.email_templates?.length) await tx.delete(emailTemplates).where(inArray(emailTemplates.id, ids.email_templates));
        if (ids.directory_people?.length) await tx.delete(directoryPeople).where(inArray(directoryPeople.id, ids.directory_people));
        if (ids.directory_companies?.length) await tx.delete(directoryCompanies).where(inArray(directoryCompanies.id, ids.directory_companies));
        await tx.delete(samplePacks).where(eq(samplePacks.tenant_id, tenantId));
        await this.audit.log({ tenantId, actorUserId: userId, action: 'crm.sample_data.remove', resourceType: 'tenant', resourceId: tenantId });
        return { data: { loaded: false } };
      },
      userId,
    );
  }
}
