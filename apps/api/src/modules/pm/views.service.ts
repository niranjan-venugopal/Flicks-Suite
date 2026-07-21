import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { pmViewFavorites, savedViews } from '@flicks/db/schema';
import { DatabaseService } from '../../core/database/database.service';
import { CrmPublicService } from '../crm/public';
import { DomainEventsService } from '../../core/events/domain-events.service';

const PM_VIEW_TYPES = ['pm_issue', 'pm_project'] as const;

/**
 * PM saved views + sidebar favorites (PRD v6 §9.4). Views live in the shared
 * saved_views table, consumed strictly through the CRM public facade (module
 * boundary); favorites are PM-owned rows pinning a view to the user's sidebar.
 */
@Injectable()
export class PmViewsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly crm: CrmPublicService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  private assertPmType(objectType: string) {
    if (!PM_VIEW_TYPES.includes(objectType as never)) {
      throw new BadRequestException('object_type must be pm_issue or pm_project');
    }
  }

  async list(tenantId: string, userId: string, objectType: string) {
    this.assertPmType(objectType);
    const views = await this.crm.listViews(tenantId, userId, objectType);
    const favorites = await this.db.withTenant(
      tenantId,
      (tx) =>
        tx
          .select({ view_id: pmViewFavorites.view_id })
          .from(pmViewFavorites)
          .where(and(eq(pmViewFavorites.tenant_id, tenantId), eq(pmViewFavorites.user_id, userId))),
      userId,
    );
    return { data: { views: views.data, favorite_ids: favorites.map((f) => f.view_id) } };
  }

  async create(
    tenantId: string,
    userId: string,
    dto: { object_type: string; name: string; is_shared?: boolean; filters?: Record<string, unknown>; sort?: Record<string, unknown> },
  ) {
    this.assertPmType(dto.object_type);
    const res = await this.crm.createView(tenantId, userId, dto);
    await this.domainEvents.publish({
      name: 'pm.view.saved',
      tenantId,
      actorUserId: userId,
      payload: { view_id: (res.data as { id: string }).id },
    });
    return res;
  }

  async remove(tenantId: string, userId: string, id: string) {
    return this.crm.removeView(tenantId, userId, id);
  }

  async setFavorite(tenantId: string, userId: string, viewId: string, favorite: boolean) {
    return this.db.withTenant(
      tenantId,
      async (tx) => {
        // The view must exist, be a PM view, and be visible (own or shared).
        const [view] = await tx
          .select({ id: savedViews.id, object_type: savedViews.object_type, owner: savedViews.owner_user_id, shared: savedViews.is_shared })
          .from(savedViews)
          .where(and(eq(savedViews.id, viewId), eq(savedViews.tenant_id, tenantId), inArray(savedViews.object_type, [...PM_VIEW_TYPES])))
          .limit(1);
        if (!view || (!view.shared && view.owner !== userId)) {
          throw new BadRequestException('view not found or not visible');
        }
        if (favorite) {
          await tx
            .insert(pmViewFavorites)
            .values({ tenant_id: tenantId, user_id: userId, view_id: viewId })
            .onConflictDoNothing();
        } else {
          await tx
            .delete(pmViewFavorites)
            .where(and(eq(pmViewFavorites.user_id, userId), eq(pmViewFavorites.view_id, viewId)));
        }
        await this.domainEvents.publish({
          name: 'pm.view.favorited',
          tenantId,
          actorUserId: userId,
          payload: { view_id: viewId, favorite },
        });
        return { data: { view_id: viewId, favorite } };
      },
      userId,
    );
  }
}
