import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HttpException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Request } from 'express';
import { REDIS_CLIENT } from '../../core/redis/redis.module';
import { ApiKeysService, type ApiKeyContext } from './api-keys.service';

/**
 * Public-API auth (PRD v5 §11): Bearer flk_live_… key → tenant context +
 * scope check + Redis fixed-window rate limit (120 req/min/key). Handlers
 * read the resolved context from request.apiKey and MUST run all data access
 * inside the standard tenant transaction (withTenant) — the key only ever
 * yields its own tenant, which the cross-tenant isolation suite asserts.
 */
export const API_SCOPES_KEY = 'flicks:api_scopes';
export const ApiScopes = (...scopes: string[]) => SetMetadata(API_SCOPES_KEY, scopes);

export const RATE_LIMIT_PER_MIN = 120;

export interface PublicApiRequest extends Request {
  apiKey?: ApiKeyContext;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeysService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PublicApiRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Provide an API key: Authorization: Bearer flk_live_…');
    }
    const ctx = await this.apiKeys.verify(header.slice('Bearer '.length).trim());
    if (!ctx) throw new UnauthorizedException('Invalid or revoked API key');

    // Fixed-window per-key limit. Redis failure = fail-open (availability
    // beats a hard outage for read APIs; the JWT app API is unaffected).
    try {
      const windowKey = `apirl:${ctx.keyId}:${Math.floor(Date.now() / 60_000)}`;
      const count = await this.redis.incr(windowKey);
      if (count === 1) await this.redis.expire(windowKey, 60);
      if (count > RATE_LIMIT_PER_MIN) {
        throw new HttpException('API rate limit exceeded (120 requests/minute)', 429);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
    }

    const required =
      this.reflector.getAllAndOverride<string[]>(API_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const held = new Set<string>(ctx.scopes);
    const missing = required.filter((s) => !held.has(s));
    if (missing.length) {
      throw new ForbiddenException(`API key missing scope(s): ${missing.join(', ')}`);
    }

    req.apiKey = ctx;
    return true;
  }
}
