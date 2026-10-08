import { CanActivate, ConflictException, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '@flicks/shared/types';

/** Sent by the web on every API call: the company the tab believes it is in. */
export const TENANT_HEADER = 'x-flicks-tenant';

/**
 * Account-level routes stay reachable whatever the tab believes — they are
 * how the client learns which company the session is really in (same set
 * the live-seat check in RolesGuard exempts).
 */
const EXEMPT_PATH = /^\/api\/v1\/(auth|me)(\/|$)/;

/**
 * Round R (founder: "nothing shared between companies, even by mistake").
 *
 * The sign-in cookie is shared by every tab of the browser. Switching company
 * in tab 2 re-issues that cookie for company B while tab 1 still shows
 * company A — until this guard, anything tab 1 then saved landed in B. The
 * web sends X-Flicks-Tenant with the company it is rendering; when it does
 * not match the company the token is scoped to, the request is refused with
 * 409 TENANT_MISMATCH and the tab reloads into the right company.
 *
 * Requests without the header (navigations, iframes, downloads, API keys,
 * third parties) are untouched — the header is an extra check, never a
 * credential.
 */
@Injectable()
export class TenantHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const raw = req.headers[TENANT_HEADER];
    const claimed = Array.isArray(raw) ? raw[0] : raw;
    if (!claimed) return true;
    const user = req.user;
    if (!user) return true;
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    if (EXEMPT_PATH.test(path)) return true;
    // A platform admin outside any workspace carries no tenant to compare.
    if (user.isPlatformAdmin && !user.tenantId) return true;
    if (claimed !== (user.tenantId ?? '')) {
      throw new ConflictException({
        code: 'TENANT_MISMATCH',
        message: 'This tab was signed in to a different company — reload to continue.',
      });
    }
    return true;
  }
}
