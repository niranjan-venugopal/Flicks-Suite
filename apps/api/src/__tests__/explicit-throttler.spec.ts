/**
 * ExplicitThrottlerGuard — the refresh-logout fix (founder round 6).
 *
 * The stock ThrottlerGuard as APP_GUARD rate-limited EVERY route with the
 * module defaults (short 10/1s per IP), so a browser refresh's burst of
 * dashboard calls tripped 429s; a 429 on /auth/me read as "signed out" and
 * ejected sessions holding valid 7/180-day cookies. The subclass throttles
 * ONLY routes that explicitly declare @Throttle (OTP brute-force etc.) and
 * skips everything else.
 */
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import {
  Throttle,
  ThrottlerException,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { ExplicitThrottlerGuard } from '../core/common/explicit-throttler.guard';

// Mirrors app.module.ts ThrottlerModule.forRoot
const MODULE_OPTIONS = {
  throttlers: [
    { name: 'short', ttl: 1000, limit: 10 },
    { name: 'medium', ttl: 10000, limit: 50 },
    { name: 'long', ttl: 60000, limit: 200 },
  ],
};

class PlainController {
  list() {
    return [];
  }
}

class ThrottledController {
  @Throttle({ short: { limit: 2, ttl: 60000 } })
  verifyOtp() {
    return true;
  }
}

function contextFor(
  instance: object,
  handler: (...args: unknown[]) => unknown,
): ExecutionContext {
  const req = { ip: '203.0.113.7', headers: {} };
  const res = { header: () => undefined };
  return {
    getHandler: () => handler,
    getClass: () => instance.constructor,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

describe('ExplicitThrottlerGuard', () => {
  let guard: ExplicitThrottlerGuard;
  let storage: ThrottlerStorageService;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    guard = new ExplicitThrottlerGuard(
      MODULE_OPTIONS as never,
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });

  afterEach(() => {
    storage.onApplicationShutdown();
  });

  it('lets a 30-request burst through on a route WITHOUT @Throttle', async () => {
    const ctx = contextFor(new PlainController(), PlainController.prototype.list);
    for (let i = 0; i < 30; i++) {
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
  });

  it('still rate-limits a route WITH an explicit @Throttle', async () => {
    const ctx = contextFor(
      new ThrottledController(),
      ThrottledController.prototype.verifyOtp,
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ThrottlerException);
  });
});
