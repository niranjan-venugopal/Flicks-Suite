import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload } from '@flicks/shared/types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuditService } from '../../../modules/audit/audit.service';

/**
 * Round H — guest seats are project-scoped, so for a guest the API is
 * DENY-BY-DEFAULT. APP_GUARD after RolesGuard, before BillingGuard.
 *
 * Why this exists: RolesGuard only ranks routes that carry @Roles(...). The
 * platform has dozens of deliberately unranked "self-service" routes (my
 * attendance, my leave, the org chart, the members roster, the tenant
 * profile, the admin dashboard, the audit-log feed…) which every workspace
 * member may call. A guest is NOT a workspace member — they are an external
 * person invited into one project — yet nothing stopped a guest JWT from
 * calling GET /settings/members, /employees/org-chart, /employees/:id,
 * /dashboard/admin/activity, or from punching attendance (which self-heals an
 * employee record for them). The guest UI never links there, but the data was
 * one URL away. Same class of exposure as the round-F CRM leak: data visible
 * to someone who must see nothing but their project.
 *
 * The fix is one choke point with an explicit ALLOWLIST of what a guest's
 * shell and PM seat legitimately use. Anything else is refused and audited.
 * A future unranked route is therefore closed to guests automatically.
 * Within the PM module, per-project read/write scoping stays where it is —
 * PmVisibilityService (the round-7 leak suite pins it).
 */
export const GUEST_ALLOWED_PREFIXES: readonly string[] = [
  // session + login + switch-company + totp
  'auth',
  // my companies (CompanySwitcher / My companies page), my presence status,
  // my consents, my data export, my NPS
  'me',
  'presence',
  'notifications',
  // the project seat itself, incl. pm/sync
  'pm',
  'consents',
  // own avatar only
  'media/avatar',
  // round-7 founder decision: a guest may start their own workspace
  'onboarding/create-tenant',
  'feedback',
  // consent-gated client telemetry
  'events',
  // the (app) layout's self-only probe — returns employeeId null for guests
  'employees/me/onboarding-status',
];

/** Strip query string, leading slash and the global `api/v1` prefix. */
export function normalizeGuestPath(rawUrl: string): string {
  const noQuery = (rawUrl ?? '').split('?')[0] ?? '';
  let p = noQuery.replace(/^\/+/, '');
  if (p.startsWith('api/v1/')) p = p.slice('api/v1/'.length);
  return p.replace(/\/+$/, '');
}

export function guestPathAllowed(rawUrl: string): boolean {
  const p = normalizeGuestPath(rawUrl);
  return GUEST_ALLOWED_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

@Injectable()
export class GuestScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();
    const user = req.user;
    // No user (JwtAuthGuard already decided), platform staff, or any real
    // workspace role: not this guard's concern.
    if (!user || user.isPlatformAdmin) return true;
    if (user.role !== 'guest') return true;

    const url = req.originalUrl ?? req.url ?? '';
    if (guestPathAllowed(url)) return true;

    await this.logDenied(req, user, url);
    throw new ForbiddenException(
      'Guest seats are project-scoped — this area is not available to guests',
    );
  }

  /** Mirror RolesGuard.logDenied: RBAC probing must be visible to Owners. */
  private async logDenied(
    req: Request & { user?: JwtPayload },
    user: JwtPayload,
    url: string,
  ): Promise<void> {
    if (!user.tenantId) return;
    try {
      await this.audit.log({
        tenantId: user.tenantId,
        actorUserId: user.sub,
        action: 'authz.denied',
        resourceType: 'rbac',
        metadata: {
          reason: 'guest_scope',
          method: req.method,
          path: normalizeGuestPath(url),
          role: user.role,
        },
      });
    } catch {
      /* best-effort */
    }
  }
}
