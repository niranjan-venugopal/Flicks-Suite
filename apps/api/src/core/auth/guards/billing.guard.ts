import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload } from '@flicks/shared/types';
import { BILLING_EXEMPT_KEY } from '../decorators/billing-exempt.decorator';
import { BillingStateService } from '../../billing/billing-state.service';

/**
 * Billing paywall (PRD v4 §8B.5) — APP_GUARD after RolesGuard.
 *
 * A locked workspace (trial expired with no subscription, past-due beyond
 * grace, or canceled past its period) becomes READ-ONLY: GET/HEAD/OPTIONS
 * pass, everything else 402s with code BILLING_REQUIRED so the web shell can
 * raise the D19 wall. Never applies to: @Public routes (webhooks, hosted
 * pages, unsubscribe), @BillingExempt surfaces (auth, billing itself,
 * consents, feedback, data export), platform staff, or the Specflicks
 * internal tenant.
 *
 * The per-tenant lock verdict is cached for 60s (billing-state service) so
 * the guard costs nothing on the hot path.
 */
@Injectable()
export class BillingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billingState: BillingStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const exempt = this.reflector.getAllAndOverride<boolean>(BILLING_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as Request & { user?: JwtPayload }).user;
    // No authenticated tenant context → nothing to meter (JwtAuthGuard has
    // already decided whether the request may proceed at all).
    if (!user?.tenantId) return true;
    if (user.role === 'fam' || user.role === 'super_admin') return true;

    // Reads stay open — the lock is a wall, not a blackout (§8B.5: users can
    // still see their data; exports and billing actions have exemptions).
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }

    const locked = await this.billingState.isLocked(user.tenantId);
    if (!locked) return true;

    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: 'BILLING_REQUIRED',
        message:
          'Your workspace is read-only until billing is set up. An Owner or Admin can subscribe from Settings → Billing & plan.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
