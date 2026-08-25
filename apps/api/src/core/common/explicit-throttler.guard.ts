import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';

/**
 * Rate-limit ONLY the routes that explicitly opt in with @Throttle(...).
 *
 * The stock ThrottlerGuard as APP_GUARD applies the module's default named
 * throttlers (short 10/1s · medium 50/10s · long 200/60s, keyed per IP) to
 * EVERY route. That broke real sessions: a browser refresh of the dashboard
 * fires 10-15 API calls in the same second, so the burst tripped 429s — and
 * a 429 on /auth/me (or on /auth/refresh mid silent-refresh) read as "not
 * signed in" and bounced the user to /login with a perfectly valid 7/180-day
 * cookie. Behind Railway's proxy it was worse still: without trust proxy,
 * req.ip was the proxy address, so every user shared one bucket.
 *
 * The point of wiring the guard was brute-force protection on the auth +
 * public endpoints that declare @Throttle — so enforce exactly those and
 * skip the rest. (A sensible Redis-backed default for the whole surface can
 * return later; see the handoff doc.)
 */
@Injectable()
export class ExplicitThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const classRef = context.getClass();
    // v6 stores per-name metadata: `THROTTLER:LIMIT<name>` (e.g. "…LIMITshort").
    const hasExplicitThrottle = this.throttlers.some(
      (t) =>
        this.reflector.getAllAndOverride(THROTTLER_LIMIT + (t.name ?? ''), [
          handler,
          classRef,
        ]) !== undefined,
    );
    return !hasExplicitThrottle;
  }
}
