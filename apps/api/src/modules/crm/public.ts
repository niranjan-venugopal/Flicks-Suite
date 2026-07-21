import { Injectable } from '@nestjs/common';
import { DirectoryService } from './directory.service';
import { DealsService } from './deals.service';
import { LeadsService, type CreateLeadDto } from './leads.service';
import { SavedViewsService } from './saved-views.service';

/**
 * CRM public facade (PRD v5 §2.3) — the ONLY surface other modules (today:
 * the public REST API) may consume from CRM. Everything passes through the
 * same services the UI uses, so RLS scoping, FX snapshots, dedupe rules and
 * domain events apply identically.
 */
@Injectable()
export class CrmPublicService {
  constructor(
    private readonly directory: DirectoryService,
    private readonly deals: DealsService,
    private readonly leads: LeadsService,
    private readonly savedViews: SavedViewsService,
  ) {}

  listPeople(tenantId: string, query: { q?: string; page?: number; limit?: number }) {
    return this.directory.listPeople(tenantId, query);
  }

  createPerson(tenantId: string, actorUserId: string, dto: Parameters<DirectoryService['createPerson']>[2]) {
    return this.directory.createPerson(tenantId, actorUserId, dto);
  }

  listCompanies(tenantId: string, query: { q?: string; page?: number; limit?: number }) {
    return this.directory.listCompanies(tenantId, query);
  }

  createCompany(tenantId: string, actorUserId: string, dto: Parameters<DirectoryService['createCompany']>[2]) {
    return this.directory.createCompany(tenantId, actorUserId, dto);
  }

  getDeal(tenantId: string, id: string) {
    return this.deals.get(tenantId, id);
  }

  createDeal(tenantId: string, actorUserId: string, dto: Parameters<DealsService['create']>[2]) {
    return this.deals.create(tenantId, actorUserId, dto);
  }

  listLeads(tenantId: string, status?: string) {
    return this.leads.list(tenantId, status);
  }

  createLead(tenantId: string, actorUserId: string, dto: CreateLeadDto) {
    return this.leads.create(tenantId, actorUserId, dto);
  }

  // ─── Saved views (PRD v6 §9.4 — PM reuses the shared saved_views table) ────

  listViews(tenantId: string, userId: string, objectType?: string) {
    return this.savedViews.list(tenantId, userId, objectType);
  }

  createView(tenantId: string, userId: string, dto: Parameters<SavedViewsService['create']>[2]) {
    return this.savedViews.create(tenantId, userId, dto);
  }

  updateView(tenantId: string, userId: string, id: string, dto: Record<string, unknown>) {
    return this.savedViews.update(tenantId, userId, id, dto);
  }

  removeView(tenantId: string, userId: string, id: string) {
    return this.savedViews.remove(tenantId, userId, id);
  }
}
