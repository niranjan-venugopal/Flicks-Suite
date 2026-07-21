import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { JwtPayload } from '@flicks/shared/types';
import { PM_MUTATE_RATE_PER_MIN } from '@flicks/shared/pm';
import { REDIS_CLIENT } from '../../../core/redis/redis.module';

/**
 * Per-user mutate throttle (PRD v6 §16.2): 120 mutation ITEMS per minute per
 * user — counted per item, not per request, so batching can't dodge it. The
 * first per-user limiter in the codebase (the global ThrottlerGuard is
 * IP-based). Redis INCR/EXPIRE keeps it atomic across processes; when Redis
 * is unreachable it falls back to an in-process window rather than failing
 * open silently forever or blocking writes.
 */
@Injectable()
export class PmSyncThrottleGuard implements CanActivate {
  private readonly logger = new Logger(PmSyncThrottleGuard.name);
  /** In-memory fallback window: userKey → { count, resetAt }. */
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      user?: JwtPayload;
      body?: { items?: unknown[] };
    }>();
    const user = req.user;
    if (!user?.tenantId) return true; // auth guard rejects independently
    const n = Array.isArray(req.body?.items) ? req.body!.items!.length : 1;
    const key = `pm:mut:${user.tenantId}:${user.sub}`;

    let count: number | null = null;
    try {
      count = await this.redis.incrby(key, n);
      if (count === n) await this.redis.expire(key, 60);
    } catch {
      // Redis down → in-process fallback (single-instance dev/beta reality).
      const now = Date.now();
      const slot = this.local.get(key);
      if (!slot || slot.resetAt < now) {
        this.local.set(key, { count: n, resetAt: now + 60_000 });
        count = n;
      } else {
        slot.count += n;
        count = slot.count;
      }
    }

    if (count !== null && count > PM_MUTATE_RATE_PER_MIN) {
      this.logger.warn(`pm mutate throttled user=${user.sub} count=${count}`);
      throw new HttpException(
        { code: 'RATE_LIMITED', message: `Mutation rate limit: ${PM_MUTATE_RATE_PER_MIN} ops/min` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
