import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../core/redis/redis.module';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, and, gt, isNull, lt, desc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { Response } from 'express';
import {
  authOtps,
  refreshTokens,
  trustedDevices,
  authEvents,
  users,
  memberships,
  tenants,
  impersonationSessions,
  accountDeletionRequests,
  employees,
  emergencyContacts,
  dataConsents,
  leaveRequests,
  timesheetPeriods,
} from '@flicks/db/schema';
import { DB_SERVICE_ROLE } from '../../core/database/database.module';
import type { DbAdmin } from '@flicks/db';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { ConsentService, type ConsentInput } from '../consent/consent.service';
import { TotpService } from './totp.service';
import { resolveSwitchMembership } from './switch-membership.util';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

// TOTP brute-force lockout (Sprint 13 §E).
const MAX_TOTP_ATTEMPTS = 5;
const TOTP_LOCK_MS = 15 * 60 * 1000;

/** Normalise a backup code (strip separators/case) before hashing/comparing. */
const normaliseBackupCode = (code: string) =>
  sha256(code.replace(/[^a-z0-9]/gi, '').toLowerCase());

/** Generate `n` single-use backup codes — plaintext (shown once) + stored hashes. */
function generateBackupCodes(n = 10): {
  plain: string[];
  stored: Array<{ h: string; u: string | null }>;
} {
  const plain: string[] = [];
  const stored: Array<{ h: string; u: string | null }> = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    plain.push(code);
    stored.push({ h: normaliseBackupCode(code), u: null });
  }
  return { plain, stored };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Auth is a platform-level / cross-tenant concern: it looks up users by
  // email before any tenant exists (OTP), enumerates the tenants a user
  // belongs to (memberships) to build the tenant picker, issues/rotates
  // session + refresh tokens, and manages trusted devices + impersonation.
  // None of that fits a single-tenant RLS context, so it runs entirely on the
  // service-role (BYPASSRLS) connection. `db` and `dbAdmin` point at the same
  // connection — kept as two fields only to avoid churning ~50 call sites.
  constructor(
    @Inject(DB_SERVICE_ROLE) private readonly db: DbAdmin,
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly totpService: TotpService,
    private readonly consentService: ConsentService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Per-EMAIL OTP limiter. The route's ThrottlerGuard keys on IP, which does
   * nothing against a rotating-IP attacker targeting one address: they could
   * both bomb the victim's mailbox and — because each request consumes the
   * previous OTP — keep the victim permanently unable to finish sign-in.
   * Redis-backed; a Redis outage degrades to the IP limiter (logged).
   */
  private async assertEmailOtpQuota(email: string): Promise<void> {
    if (!this.redis) return;
    const burst = `auth:otp:burst:${sha256(email)}`;
    const hourly = `auth:otp:hr:${sha256(email)}`;
    try {
      const [b, h] = await Promise.all([this.redis.incr(burst), this.redis.incr(hourly)]);
      if (b === 1) await this.redis.expire(burst, 60);
      if (h === 1) await this.redis.expire(hourly, 3600);
      if (b > 1 || h > 5) {
        throw new BadRequestException(
          'A sign-in code was just sent to this address. Check your inbox, or try again in a minute.',
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`OTP email quota check degraded (redis): ${(err as Error).message}`);
    }
  }

  async requestOtp(
    email: string,
    ip?: string,
    userAgent?: string,
    intent: 'signin' | 'signup' = 'signin',
  ): Promise<{ success: true; message: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    // crypto.randomInt, never Math.random: V8's PRNG state is recoverable from
    // a run of outputs, and signup intent lets anyone harvest their own codes.
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const otpHash = sha256(otpCode);
    const magicLinkRawToken = generateSecureToken();
    const magicLinkHash = sha256(magicLinkRawToken);

    const expiryMinutes = this.configService.get<number>(
      'OTP_EXPIRY_MINUTES',
      10,
    );
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Registration check. Revealing registration status is ACCEPTED product
    // behavior (Slack/Notion-style: unregistered sign-ins are pushed to
    // signup with the email prefilled) — a deliberate reversal of the old
    // anti-enumeration stance. Probing is still bounded by the 5/hr/IP
    // throttle on the route. "Registered" = a users row exists: invite
    // flows pre-create users (invited memberships flip active on verify),
    // and an abandoned-signup row can still complete via verify+consents.
    const existingUser = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (intent !== 'signup' && !existingUser[0]) {
      await this.writeAuthEvent({
        email: normalizedEmail,
        eventType: 'login_failed',
        ip,
        userAgent,
      });
      throw new NotFoundException({
        message: 'This email is not registered. Create a workspace to get started.',
        code: 'NOT_REGISTERED',
      });
    }

    // Quota BEFORE any invalidation/send — otherwise a rejected request would
    // still have killed the victim's outstanding (valid) code.
    await this.assertEmailOtpQuota(normalizedEmail);

    // Invalidate any prior unconsumed SHORT-LIVED OTPs / magic links for
    // this email so only the freshly-issued code is valid. Without this
    // guard, repeated requestOtp calls leave a trail of valid rows and the
    // verify step can match the wrong one.
    //
    // The expires_at < now + 1 day filter explicitly EXCLUDES long-lived
    // invite tokens (7-day expiry, issued via issueInviteMagicLink). If we
    // wiped those too, an invitee who casually visits /login while waiting
    // for their email to arrive would silently nuke their invite link.
    const shortLivedCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 day
    await this.db
      .update(authOtps)
      .set({ consumed_at: new Date() })
      .where(
        and(
          eq(authOtps.email, normalizedEmail),
          isNull(authOtps.consumed_at),
          lt(authOtps.expires_at, shortLivedCutoff),
        ),
      );

    await this.db.insert(authOtps).values({
      email: normalizedEmail,
      user_id: existingUser[0]?.id ?? null,
      otp_hash: otpHash,
      magic_link_token: magicLinkHash,
      attempt_count: 0,
      ip_address: ip,
      user_agent: userAgent,
      expires_at: expiresAt,
    });

    const magicLinkBaseUrl = this.configService.get<string>(
      'MAGIC_LINK_BASE_URL',
      'http://localhost:3000/verify',
    );
    const magicLinkUrl = `${magicLinkBaseUrl}?token=${magicLinkRawToken}`;

    // Send email
    await this.notificationsService.sendEmail('login-otp', normalizedEmail, {
      otpCode,
      magicLinkUrl,
      expiryMinutes,
    });

    await this.writeAuthEvent({
      email: normalizedEmail,
      userId: existingUser[0]?.id,
      eventType: 'otp_requested',
      ip,
      userAgent,
    });

    this.logger.log(`OTP requested for: ${normalizedEmail}`);

    // DEV ONLY: surface plaintext OTP + magic link in server logs so a
    // developer can complete the login flow without an email account.
    // This must NOT run in production — guard on NODE_ENV.
    if (this.configService.get<string>('NODE_ENV') !== 'production') {
      this.logger.warn(
        `[DEV] OTP for ${normalizedEmail}: ${otpCode}  |  Magic link: ${magicLinkUrl}`,
      );
    }

    return {
      success: true,
      message: 'We sent a sign-in code and magic link to your email.',
    };
  }

  async verifyOtp(
    email: string,
    code: string,
    deviceId?: string,
    ip?: string,
    userAgent?: string,
    consents?: ConsentInput[],
    regionCode?: string,
  ) {
    const normalizedEmail = email.toLowerCase().trim();
    const codeHash = sha256(code);

    // Select the NEWEST unconsumed unexpired OTP. Sorting ascending here would
    // return the oldest row, so a user who re-requests an OTP would see their
    // freshly-mailed code mis-compared against an earlier row's hash → 401.
    const otpRecord = await this.db
      .select()
      .from(authOtps)
      .where(
        and(
          eq(authOtps.email, normalizedEmail),
          isNull(authOtps.consumed_at),
          gt(authOtps.expires_at, new Date()),
        ),
      )
      .orderBy(desc(authOtps.created_at))
      .limit(1);

    if (!otpRecord[0]) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    const otp = otpRecord[0];
    const maxAttempts = this.configService.get<number>('MAX_OTP_ATTEMPTS', 5);

    // Check attempt count
    if (otp.attempt_count >= maxAttempts) {
      throw new UnauthorizedException(
        'OTP has been invalidated due to too many failed attempts',
      );
    }

    // Verify hash
    if (otp.otp_hash !== codeHash) {
      // Increment attempt counter
      await this.db
        .update(authOtps)
        .set({ attempt_count: otp.attempt_count + 1 })
        .where(eq(authOtps.id, otp.id));

      await this.writeAuthEvent({
        email: normalizedEmail,
        eventType: 'otp_failed',
        ip,
        userAgent,
      });

      throw new UnauthorizedException('Invalid OTP code');
    }

    // Mark OTP as consumed
    await this.db
      .update(authOtps)
      .set({ consumed_at: new Date() })
      .where(eq(authOtps.id, otp.id));

    return this.handleSuccessfulAuth(normalizedEmail, deviceId, ip, userAgent, {
      consents,
      regionCode,
    });
  }

  async verifyMagicLink(token: string, deviceId?: string, ip?: string, userAgent?: string) {
    const tokenHash = sha256(token);

    // React Strict Mode (and aggressive prefetchers / browser previews)
    // routinely fire the verify GET twice in quick succession. The first
    // call consumes the token, the second sees consumed_at set and 401s.
    // To survive that, look up the row regardless of consumed status and
    // treat anything consumed within the last 60s as still valid — same
    // user, same click, same outcome.
    const idempotencyWindow = new Date(Date.now() - 60 * 1000);
    // Look up by token hash WITHOUT the expiry filter first, then check expiry
    // explicitly. This lets us tell "no such token" apart from "expired" in the
    // logs — the two used to collapse into one opaque 401, which made invite
    // magic-link issues (e.g. a token that doesn't exist in the DB the API is
    // pointed at) impossible to diagnose from the response alone.
    const candidates = await this.db
      .select()
      .from(authOtps)
      .where(eq(authOtps.magic_link_token, tokenHash))
      .orderBy(desc(authOtps.created_at))
      .limit(1);

    const otp = candidates[0];

    if (!otp) {
      this.logger.warn(
        `Magic link rejected: no auth_otps row for token hash ${tokenHash.slice(0, 12)}… ` +
          `(token not present in this database)`,
      );
      throw new UnauthorizedException('Invalid or expired magic link');
    }

    if (otp.expires_at.getTime() <= Date.now()) {
      this.logger.warn(
        `Magic link rejected: token for ${otp.email} expired at ${otp.expires_at.toISOString()}`,
      );
      throw new UnauthorizedException('Invalid or expired magic link');
    }

    if (otp.consumed_at && otp.consumed_at < idempotencyWindow) {
      throw new UnauthorizedException('Magic link has already been used');
    }

    // First time through (or within the idempotency window) — mark it
    // consumed. The UPDATE is a no-op when consumed_at is already set.
    if (!otp.consumed_at) {
      await this.db
        .update(authOtps)
        .set({ consumed_at: new Date() })
        .where(eq(authOtps.id, otp.id));
    }

    await this.writeAuthEvent({
      email: otp.email,
      eventType: 'magic_link_consumed',
      ip,
      userAgent,
    });

    return this.handleSuccessfulAuth(otp.email, deviceId, ip, userAgent);
  }

  private async handleSuccessfulAuth(
    email: string,
    deviceId?: string,
    ip?: string,
    userAgent?: string,
    signup?: { consents?: ConsentInput[]; regionCode?: string },
  ) {
    // Find or create user
    let user = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user[0]) {
      // NEW account → the §3.4 clickwrap is mandatory. Signup is rejected
      // without an affirmative terms_privacy consent; the accepted set is
      // ledgered right after creation (source='signup', tenant not yet known).
      // Existing users and invited/magic-link users are covered by the
      // re-acceptance interstitial instead (no ledger row → prompted once).
      const acceptedTerms = signup?.consents?.some(
        (c) => c.type === 'terms_privacy' && c.granted === true,
      );
      if (!acceptedTerms) {
        throw new BadRequestException(
          'Please accept the Terms of Service and Privacy Policy to create your account.',
        );
      }
      const inserted = await this.db
        .insert(users)
        .values({
          email,
          full_name: email.split('@')[0],
          email_verified_at: new Date(),
        })
        .returning();
      user = inserted;
      await this.consentService.record(inserted[0].id, signup!.consents!, {
        source: 'signup',
        regionCode: signup?.regionCode,
        ip,
        userAgent,
      });
    } else {
      // Update last login and verify email
      await this.db
        .update(users)
        .set({
          last_login_at: new Date(),
          email_verified_at: user[0].email_verified_at ?? new Date(),
        })
        .where(eq(users.id, user[0].id));
    }

    const currentUser = user[0];

    // ─── Activate any pending invites ────────────────────────────────────
    // When an admin invites someone, the membership is created with
    // status='invited' (see EmployeesService.inviteEmployee). Successfully
    // hitting either /verify-otp or /magic-link proves they own the email
    // address — flip those memberships to 'active' so the subsequent
    // membership lookup actually returns them.
    const activated = await this.dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(
        and(
          eq(memberships.user_id, currentUser.id),
          eq(memberships.status, 'invited'),
        ),
      )
      .returning({ tenant_id: memberships.tenant_id });

    // PRD v4 §6 — funnel/engagement events via the analytics.track sink
    // (fire-and-forget; the listener dedupes first_login_day per day).
    for (const m of activated) {
      this.eventEmitter.emit('analytics.track', {
        event: 'member_accepted',
        tenantId: m.tenant_id,
        userId: currentUser.id,
      });
    }
    this.eventEmitter.emit('analytics.track', {
      event: 'first_login_day',
      userId: currentUser.id,
      dedupePerDay: true,
    });

    // Get memberships across all tenants (uses admin client — RLS would
    // hide them all since no tenant context is set yet at login time).
    const userMemberships = await this.dbAdmin
      .select({
        id: memberships.id,
        tenantId: memberships.tenant_id,
        role: memberships.role,
        status: memberships.status,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        tenantLogoUrl: tenants.logo_url,
        tenantStatus: tenants.status,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenant_id, tenants.id))
      .where(
        and(
          eq(memberships.user_id, currentUser.id),
          eq(memberships.status, 'active'),
        ),
      );

    // If user has trusted device and exactly one active membership, auto-select
    let activeMembership = userMemberships[0];
    let requiresTenantSelection = false;

    if (userMemberships.length === 0) {
      // New user, no tenants
      requiresTenantSelection = false;
    } else if (userMemberships.length === 1) {
      activeMembership = userMemberships[0];
    } else {
      // Multiple tenants - require selection
      requiresTenantSelection = true;
    }

    // Write trusted device if deviceId provided
    if (deviceId) {
      await this.upsertTrustedDevice(
        currentUser.id,
        deviceId,
        ip,
        userAgent,
      );
    }

    await this.writeAuthEvent({
      email,
      userId: currentUser.id,
      eventType: 'login_success',
      ip,
      userAgent,
      deviceId,
    });

    if (requiresTenantSelection) {
      return {
        requiresTenantSelection: true,
        tenants: userMemberships.map((m) => ({
          id: m.tenantId,
          name: m.tenantName,
          slug: m.tenantSlug,
          logoUrl: m.tenantLogoUrl,
          role: m.role,
          status: m.tenantStatus,
        })),
        user: {
          id: currentUser.id,
          email: currentUser.email,
          fullName: currentUser.full_name,
          avatarUrl: currentUser.avatar_url,
        },
      };
    }

    if (!activeMembership) {
      // No tenant yet — return partial auth for onboarding
      const { accessToken, refreshToken } = await this.issueTokenPair(
        currentUser,
        null,
        null,
        null,
        deviceId,
        ip,
        userAgent,
      );

      return {
        requiresTenantSelection: false,
        needsOnboarding: true,
        accessToken,
        refreshToken,
        user: {
          id: currentUser.id,
          email: currentUser.email,
          fullName: currentUser.full_name,
          avatarUrl: currentUser.avatar_url,
        },
      };
    }

    // ─── FAM second factor (PRD §11.6) ───────────────────────────────────
    // Platform admins must clear a TOTP step after the email factor. Only
    // enforced when TOTP_SECRET is configured (production).
    if (currentUser.is_platform_admin && this.totpService.isEnforced()) {
      if (!currentUser.totp_enrolled_at) {
        // Not enrolled yet — let them in so they can enrol, but flag it so
        // the FAM shell routes them to /totp-setup.
        const tokens = await this.issueTokenPair(
          currentUser,
          activeMembership.tenantId,
          activeMembership.id,
          activeMembership.role as UserRole,
          deviceId,
          ip,
          userAgent,
        );
        return {
          requiresTenantSelection: false,
          requiresTotpEnrollment: true,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: 900,
          user: {
            id: currentUser.id,
            email: currentUser.email,
            fullName: currentUser.full_name,
            avatarUrl: currentUser.avatar_url,
          },
        };
      }

      // Enrolled — issue a short-lived challenge token instead of a session.
      // The client posts it with a TOTP code to /auth/totp/verify to finish.
      const challengeToken = this.jwtService.sign(
        {
          sub: currentUser.id,
          scope: 'totp_challenge',
          tenantId: activeMembership.tenantId,
          membershipId: activeMembership.id,
          role: activeMembership.role,
          deviceId: deviceId ?? '',
        },
        { expiresIn: '5m' },
      );
      return {
        requiresTenantSelection: false,
        requiresTotp: true,
        challengeToken,
        user: {
          id: currentUser.id,
          email: currentUser.email,
          fullName: currentUser.full_name,
          avatarUrl: currentUser.avatar_url,
        },
      };
    }

    const { accessToken, refreshToken } = await this.issueTokenPair(
      currentUser,
      activeMembership.tenantId,
      activeMembership.id,
      activeMembership.role as UserRole,
      deviceId,
      ip,
      userAgent,
    );

    return {
      requiresTenantSelection: false,
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes in seconds
      user: {
        id: currentUser.id,
        email: currentUser.email,
        fullName: currentUser.full_name,
        avatarUrl: currentUser.avatar_url,
      },
    };
  }

  async refreshToken(
    oldRefreshToken: string,
    deviceId?: string,
    ip?: string,
    userAgent?: string,
  ) {
    const tokenHash = sha256(oldRefreshToken);

    const existing = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token_hash, tokenHash))
      .limit(1);

    if (!existing[0]) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const token = existing[0];

    // Check if already revoked (token reuse attack)
    if (token.revoked_at) {
      // Revoke all tokens for this user (security breach)
      this.logger.warn(
        `Refresh token reuse detected for user ${token.user_id}. Revoking all tokens.`,
      );
      await this.db
        .update(refreshTokens)
        .set({ revoked_at: new Date() })
        .where(eq(refreshTokens.user_id, token.user_id));

      await this.writeAuthEvent({
        userId: token.user_id,
        eventType: 'token_revoked',
        ip,
        userAgent,
        metadata: { reason: 'token_reuse_detected' },
      });

      throw new UnauthorizedException(
        'Security alert: Token reuse detected. All sessions have been invalidated.',
      );
    }

    // Check expiry
    if (token.expires_at < new Date()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Impersonation refresh: validate the session is still active.
    // Without this, a leaked impersonation refresh-token could mint
    // clean access tokens (no impersonatorUserId) past the session end.
    if (token.impersonator_user_id) {
      const [activeSession] = await this.dbAdmin.execute<{ id: string }>(sql`
        SELECT id
        FROM impersonation_sessions
        WHERE impersonator_user_id = ${token.impersonator_user_id}
          AND target_user_id        = ${token.user_id}
          AND ended_at IS NULL
          AND ends_at > now()
        ORDER BY started_at DESC
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
      if (!activeSession) {
        throw new UnauthorizedException(
          'Impersonation session has ended or expired',
        );
      }
    }

    const user = await this.db
      .select()
      .from(users)
      .where(eq(users.id, token.user_id))
      .limit(1);

    if (!user[0] || user[0].status !== 'active') {
      throw new UnauthorizedException('User account is not active');
    }

    // Get current membership info from the token's tenant
    let membershipInfo = null;
    if (token.tenant_id) {
      const membershipResult = await this.dbAdmin
        .select({ id: memberships.id, role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, token.user_id),
            eq(memberships.tenant_id, token.tenant_id),
            eq(memberships.status, 'active'),
          ),
        )
        .limit(1);
      membershipInfo = membershipResult[0];
    }

    // Revoke old token
    await this.db
      .update(refreshTokens)
      .set({ revoked_at: new Date() })
      .where(eq(refreshTokens.id, token.id));

    // Issue new pair — preserve the impersonator marker so the next
    // access token still surfaces the banner and audit trail.
    const { accessToken, refreshToken: newRefreshToken } =
      await this.issueTokenPair(
        user[0],
        token.tenant_id,
        membershipInfo?.id ?? null,
        (membershipInfo?.role ?? null) as UserRole | null,
        deviceId ?? token.device_id ?? undefined,
        ip,
        userAgent,
        token.impersonator_user_id ?? undefined,
      );

    await this.writeAuthEvent({
      userId: token.user_id,
      eventType: 'token_refreshed',
      ip,
      userAgent,
      deviceId: deviceId ?? token.device_id ?? undefined,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
    };
  }

  async logout(refreshTokenValue: string): Promise<void> {
    const tokenHash = sha256(refreshTokenValue);
    await this.db
      .update(refreshTokens)
      .set({ revoked_at: new Date() })
      .where(eq(refreshTokens.token_hash, tokenHash));
  }

  async logoutAll(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(refreshTokens.user_id, userId),
          isNull(refreshTokens.revoked_at),
        ),
      );

    await this.writeAuthEvent({
      userId,
      eventType: 'logout',
      metadata: { all_sessions: true },
    });
  }

  async selectTenant(userId: string, tenantId: string) {
    // Server-side re-verification (PRD §3.5): membership must exist, must not
    // be revoked or past its access window; pending invites are accepted on
    // switch. Shared with POST /auth/switch-company.
    const { membership, activated } = await resolveSwitchMembership(
      this.dbAdmin,
      userId,
      tenantId,
    );

    const user = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user[0]) {
      throw new UnauthorizedException('User not found');
    }

    const { accessToken, refreshToken } = await this.issueTokenPair(
      user[0],
      tenantId,
      membership.id,
      membership.role as UserRole,
    );

    await this.writeAuthEvent({
      userId,
      eventType: 'tenant_selected',
      metadata: { tenantId, ...(activated ? { invite_accepted: true } : {}) },
    });

    return { accessToken, refreshToken, expiresIn: 900 };
  }

  /**
   * Active impersonation session for an (impersonator, target) pair, or
   * null. Used by /me so the banner can render a real countdown from
   * impersonation_sessions.ends_at instead of the hard-coded "15 min".
   */
  async getActiveImpersonationSession(
    impersonatorUserId: string,
    targetUserId: string,
  ) {
    const [row] = await this.dbAdmin
      .select({
        id: impersonationSessions.id,
        startedAt: impersonationSessions.started_at,
        endsAt: impersonationSessions.ends_at,
      })
      .from(impersonationSessions)
      .where(
        and(
          eq(impersonationSessions.impersonator_user_id, impersonatorUserId),
          eq(impersonationSessions.target_user_id, targetUserId),
          isNull(impersonationSessions.ended_at),
          sql`${impersonationSessions.ends_at} > now()`,
        ),
      )
      .orderBy(desc(impersonationSessions.started_at))
      .limit(1);

    if (!row) return null;

    const [imp] = await this.dbAdmin
      .select({ email: users.email, fullName: users.full_name })
      .from(users)
      .where(eq(users.id, impersonatorUserId))
      .limit(1);

    return {
      sessionId: row.id,
      startedAt: row.startedAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      impersonatorEmail: imp?.email ?? null,
      impersonatorName: imp?.fullName ?? null,
    };
  }

  // ─── DPDP: right to access (data export) ──────────────────────────────────

  /**
   * Collects the principal's personal data across tables into a single
   * JSON document for download. DPDP "right to access". Scoped to the
   * caller's own user_id + their current tenant.
   */
  async exportMyData(userId: string, tenantId: string) {
    const [user] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const userMemberships = await this.dbAdmin
      .select({
        tenantId: memberships.tenant_id,
        role: memberships.role,
        status: memberships.status,
        invitedAt: memberships.invited_at,
        acceptedAt: memberships.accepted_at,
      })
      .from(memberships)
      .where(eq(memberships.user_id, userId));

    const [employee] = await this.dbAdmin
      .select()
      .from(employees)
      .where(and(eq(employees.user_id, userId), eq(employees.tenant_id, tenantId)))
      .limit(1);

    const contacts = employee
      ? await this.dbAdmin
          .select()
          .from(emergencyContacts)
          .where(eq(emergencyContacts.employee_id, employee.id))
      : [];

    const leaves = employee
      ? await this.dbAdmin
          .select()
          .from(leaveRequests)
          .where(eq(leaveRequests.employee_id, employee.id))
      : [];

    const timesheets = employee
      ? await this.dbAdmin
          .select()
          .from(timesheetPeriods)
          .where(eq(timesheetPeriods.employee_id, employee.id))
      : [];

    const consents = await this.dbAdmin
      .select()
      .from(dataConsents)
      .where(eq(dataConsents.user_id, userId));

    // Mask sensitive fields even in the principal's own export — the raw
    // values were collected for statutory use, not casual re-download.
    const maskedEmployee = employee
      ? {
          ...employee,
          pan_encrypted: employee.pan_encrypted
            ? `••••••${String(employee.pan_encrypted).slice(-4)}`
            : null,
          bank_account_number_encrypted: employee.bank_account_number_encrypted
            ? `••••${String(employee.bank_account_number_encrypted).slice(-4)}`
            : null,
        }
      : null;

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'user.data_exported',
      resourceType: 'user',
      resourceId: userId,
    });

    return {
      exportedAt: new Date().toISOString(),
      consentVersion: '2026-05-v1',
      user: user
        ? {
            id: user.id,
            email: user.email,
            fullName: user.full_name,
            status: user.status,
            createdAt: user.created_at?.toISOString?.() ?? null,
          }
        : null,
      memberships: userMemberships.map((m) => ({
        ...m,
        invitedAt: m.invitedAt?.toISOString() ?? null,
        acceptedAt: m.acceptedAt?.toISOString() ?? null,
      })),
      employee: maskedEmployee,
      emergencyContacts: contacts,
      leaveRequests: leaves,
      timesheets,
      consents: consents.map((c) => ({
        type: c.consent_type,
        granted: c.granted,
        purpose: c.purpose,
        version: c.consent_version,
        grantedAt: c.granted_at?.toISOString() ?? null,
        withdrawnAt: c.withdrawn_at?.toISOString() ?? null,
      })),
    };
  }

  // ─── DPDP: right to erasure (account deletion with cool-off) ──────────────

  async getDeletionRequest(userId: string) {
    const [req] = await this.dbAdmin
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.user_id, userId),
          eq(accountDeletionRequests.status, 'pending'),
        ),
      )
      .orderBy(desc(accountDeletionRequests.requested_at))
      .limit(1);
    if (!req) return null;
    return {
      id: req.id,
      status: req.status,
      requestedAt: req.requested_at.toISOString(),
      scheduledFor: req.scheduled_for.toISOString(),
      reason: req.reason,
    };
  }

  async requestAccountDeletion(
    userId: string,
    tenantId: string,
    reason: string | undefined,
    ctx?: { ip?: string; userAgent?: string },
  ) {
    const existing = await this.getDeletionRequest(userId);
    if (existing) {
      throw new BadRequestException(
        'A deletion request is already pending. Cancel it first to change it.',
      );
    }
    const scheduledFor = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [row] = await this.dbAdmin
      .insert(accountDeletionRequests)
      .values({
        tenant_id: tenantId,
        user_id: userId,
        reason: reason ?? null,
        status: 'pending',
        scheduled_for: scheduledFor,
        ip_address: ctx?.ip ?? null,
        user_agent: ctx?.userAgent ?? null,
      })
      .returning({ id: accountDeletionRequests.id });

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'user.deletion_requested',
      resourceType: 'user',
      resourceId: userId,
      metadata: { scheduledFor: scheduledFor.toISOString(), reason },
    });

    const [u] = await this.dbAdmin
      .select({ email: users.email, fullName: users.full_name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (u?.email) {
      const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      await this.notificationsService
        .sendEmail('account-deletion-confirmation', u.email, {
          userName: u.fullName ?? u.email,
          scheduledFor: scheduledFor.toUTCString(),
          cancelUrl: `${appUrl}/profile`,
        })
        .catch(() => undefined);
    }

    return {
      id: row.id,
      status: 'pending' as const,
      scheduledFor: scheduledFor.toISOString(),
    };
  }

  async cancelAccountDeletion(userId: string, tenantId: string) {
    const result = await this.dbAdmin
      .update(accountDeletionRequests)
      .set({ status: 'cancelled', processed_at: new Date() })
      .where(
        and(
          eq(accountDeletionRequests.user_id, userId),
          eq(accountDeletionRequests.status, 'pending'),
        ),
      )
      .returning({ id: accountDeletionRequests.id });

    if (result.length === 0) {
      throw new BadRequestException('No pending deletion request to cancel');
    }

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      action: 'user.deletion_cancelled',
      resourceType: 'user',
      resourceId: userId,
    });

    return { ok: true };
  }

  async getMe(userId: string, tenantId?: string) {
    const user = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user[0]) {
      throw new UnauthorizedException('User not found');
    }

    const userMemberships = await this.dbAdmin
      .select({
        id: memberships.id,
        tenantId: memberships.tenant_id,
        role: memberships.role,
        status: memberships.status,
        employeeId: memberships.employee_id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        tenantStatus: tenants.status,
        tenantLogoKey: tenants.logo_key,
        tenantLogoUrl: tenants.logo_url,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenant_id, tenants.id))
      .where(eq(memberships.user_id, userId));

    const currentMembership = tenantId
      ? userMemberships.find((m) => m.tenantId === tenantId)
      : userMemberships[0];

    // §3.2 — policy-bump re-acceptance flag (also true for pre-ledger users).
    const requiresReacceptance =
      await this.consentService.requiresReacceptance(userId);

    return {
      id: user[0].id,
      email: user[0].email,
      fullName: user[0].full_name,
      avatarUrl: user[0].avatar_url,
      // §4 media pipeline: the controller swaps these keys for short-lived
      // signed URLs (serialization-level; never exposed raw to the client).
      avatarKey: user[0].avatar_key,
      phone: user[0].phone,
      isPlatformAdmin: user[0].is_platform_admin,
      status: user[0].status,
      locale: user[0].locale,
      timezone: user[0].timezone,
      requiresReacceptance,
      currentMembership: currentMembership
        ? {
            id: currentMembership.id,
            tenantId: currentMembership.tenantId,
            tenantName: currentMembership.tenantName,
            tenantSlug: currentMembership.tenantSlug,
            tenantStatus: currentMembership.tenantStatus,
            role: currentMembership.role,
            status: currentMembership.status,
            employeeId: currentMembership.employeeId,
            tenantLogoKey: currentMembership.tenantLogoKey,
            tenantLogoUrl: currentMembership.tenantLogoUrl,
          }
        : null,
      memberships: userMemberships.map((m) => ({
        id: m.id,
        tenantId: m.tenantId,
        tenantName: m.tenantName,
        tenantSlug: m.tenantSlug,
        role: m.role,
        status: m.status,
      })),
    };
  }

  async getSessions(userId: string) {
    const sessions = await this.db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.user_id, userId),
          isNull(refreshTokens.revoked_at),
          gt(refreshTokens.expires_at, new Date()),
        ),
      )
      .orderBy(refreshTokens.created_at);

    return sessions.map((s) => ({
      id: s.id,
      deviceId: s.device_id,
      ipAddress: s.ip_address,
      userAgent: s.user_agent,
      lastUsedAt: s.last_used_at,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
    }));
  }

  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const result = await this.db
      .update(refreshTokens)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(refreshTokens.id, sessionId),
          eq(refreshTokens.user_id, userId),
        ),
      )
      .returning({ id: refreshTokens.id });

    if (!result[0]) {
      throw new BadRequestException('Session not found or already revoked');
    }
  }

  setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ): void {
    const isProd =
      this.configService.get<string>('NODE_ENV') === 'production';
    const accessExpiry = 15 * 60 * 1000; // 15 minutes
    const refreshExpiry = 7 * 24 * 60 * 60 * 1000; // 7 days

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'strict' : 'lax',
      maxAge: accessExpiry,
      path: '/',
    });

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'strict' : 'lax',
      maxAge: refreshExpiry,
      path: '/api/v1/auth',
    });
  }

  clearAuthCookies(res: Response): void {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/api/v1/auth' });
  }

  /**
   * Issue a long-lived (7 days) magic link as part of the invite flow. The
   * employee receives this URL in their welcome email; clicking it goes
   * straight through verifyMagicLink → handleSuccessfulAuth → tenant
   * context — no OTP entry required, no separate accept step.
   *
   * Unlike the magic link issued during requestOtp (10-min expiry), this
   * one is intentionally durable so the invitee can take a few days to
   * accept and isn't held to the speed of an OTP flow.
   */
  async issueInviteMagicLink(
    userId: string,
    email: string,
  ): Promise<string> {
    const normalizedEmail = email.toLowerCase().trim();
    const magicLinkRawToken = generateSecureToken();
    const magicLinkHash = sha256(magicLinkRawToken);
    const dummyOtpHash = sha256(generateSecureToken()); // never used; required NOT NULL

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.db.insert(authOtps).values({
      email: normalizedEmail,
      user_id: userId,
      otp_hash: dummyOtpHash,
      magic_link_token: magicLinkHash,
      attempt_count: 0,
      expires_at: expiresAt,
    });

    const magicLinkBaseUrl = this.configService.get<string>(
      'MAGIC_LINK_BASE_URL',
      'http://localhost:3000/verify',
    );
    const url = `${magicLinkBaseUrl}?token=${magicLinkRawToken}`;

    if (this.configService.get<string>('NODE_ENV') !== 'production') {
      this.logger.warn(`[DEV] Invite magic link for ${normalizedEmail}: ${url}`);
    }

    return url;
  }

  /**
   * Mint a fresh token pair for a user whose membership set has changed and
   * set them as cookies on the response. Used by the onboarding flow after
   * createTenant — the JWT from verify-otp had no tenant_id, and every
   * tenant-scoped query was 500-ing with 'invalid uuid'.
   *
   * Picks the user's first active membership (sufficient for the post-signup
   * single-tenant case). For multi-tenant flips, the caller should use
   * /auth/select-tenant instead.
   */
  async refreshAuthForUser(
    userId: string,
    res: Response,
  ): Promise<{ tenantId: string | null; role: string | null }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const [activeMembership] = await this.dbAdmin
      .select({
        id: memberships.id,
        tenantId: memberships.tenant_id,
        role: memberships.role,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);

    const { accessToken, refreshToken } = await this.issueTokenPair(
      user,
      activeMembership?.tenantId ?? null,
      activeMembership?.id ?? null,
      (activeMembership?.role as UserRole | undefined) ?? null,
    );

    this.setAuthCookies(res, accessToken, refreshToken);

    return {
      tenantId: activeMembership?.tenantId ?? null,
      role: activeMembership?.role ?? null,
    };
  }

  async issueTokenPair(
    user: { id: string; email: string; is_platform_admin: boolean },
    tenantId: string | null,
    membershipId: string | null,
    role: UserRole | null,
    deviceId?: string,
    ip?: string,
    userAgent?: string,
    impersonatorUserId?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // iss/aud are set globally by JwtModule.registerAsync in app.module.ts —
    // including them in the payload conflicts with sign() options.
    const payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud'> = {
      sub: user.id,
      email: user.email,
      tenantId: tenantId ?? '',
      membershipId: membershipId ?? '',
      role: role ?? 'employee',
      isPlatformAdmin: user.is_platform_admin,
      deviceId: deviceId ?? '',
      ...(impersonatorUserId ? { impersonatorUserId } : {}),
    };

    const accessToken = this.jwtService.sign(payload);

    const rawRefreshToken = generateSecureToken(48);
    const refreshTokenHash = sha256(rawRefreshToken);
    // Impersonation refreshes are short-lived (15 min cap matches the
    // access token); normal sessions get the standard 7-day window.
    const refreshExpiry = impersonatorUserId
      ? new Date(Date.now() + 15 * 60 * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.db.insert(refreshTokens).values({
      user_id: user.id,
      tenant_id: tenantId,
      token_hash: refreshTokenHash,
      device_id: deviceId,
      ip_address: ip,
      user_agent: userAgent,
      expires_at: refreshExpiry,
      last_used_at: new Date(),
      impersonator_user_id: impersonatorUserId ?? null,
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  // ─── FAM TOTP enrolment + challenge (PRD §11.6) ───────────────────────────

  /** Generate (and store, pending confirmation) a TOTP secret for a FAM user. */
  async enrollTotp(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const [user] = await this.dbAdmin
      .select({ email: users.email, isPlatformAdmin: users.is_platform_admin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (!user.isPlatformAdmin) {
      throw new ForbiddenException('TOTP enrolment is for platform admins only');
    }

    const secret = this.totpService.generateSecret();
    // Store encrypted, but leave totp_enrolled_at null until a code is verified.
    await this.dbAdmin
      .update(users)
      .set({ totp_secret: this.totpService.encrypt(secret), updated_at: new Date() })
      .where(eq(users.id, userId));

    return { secret, otpauthUrl: this.totpService.keyUri(user.email, secret) };
  }

  /**
   * Confirm enrolment by verifying the first code. Sets totp_enrolled_at and
   * issues 10 single-use backup codes (returned in plaintext exactly once).
   */
  async confirmTotpEnrollment(
    userId: string,
    code: string,
  ): Promise<{ ok: true; backupCodes: string[] }> {
    const [user] = await this.dbAdmin
      .select({ secret: users.totp_secret })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user?.secret) {
      throw new BadRequestException('Start enrolment first (no pending secret).');
    }
    const secret = this.totpService.decrypt(user.secret);
    if (!this.totpService.verify(code, secret)) {
      throw new UnauthorizedException('Invalid code. Check your authenticator and try again.');
    }
    const { plain, stored } = generateBackupCodes();
    await this.dbAdmin
      .update(users)
      .set({
        totp_enrolled_at: new Date(),
        totp_backup_codes: stored,
        totp_failed_attempts: 0,
        totp_locked_until: null,
        updated_at: new Date(),
      })
      .where(eq(users.id, userId));
    return { ok: true, backupCodes: plain };
  }

  /**
   * Consume a single-use backup code as a TOTP fallback. Marks it used and
   * returns true on success; false when no unused code matches.
   */
  private async consumeBackupCode(
    userId: string,
    code: string,
    stored: Array<{ h: string; u: string | null }> | null | undefined,
  ): Promise<boolean> {
    if (!stored?.length) return false;
    const target = normaliseBackupCode(code);
    const idx = stored.findIndex((c) => c.h === target && !c.u);
    if (idx === -1) return false;
    const updated = stored.map((c, i) =>
      i === idx ? { ...c, u: new Date().toISOString() } : c,
    );
    await this.dbAdmin
      .update(users)
      .set({ totp_backup_codes: updated, updated_at: new Date() })
      .where(eq(users.id, userId));
    return true;
  }

  /** Complete a login challenge: verify the TOTP code and issue the session. */
  async completeTotpChallenge(
    challengeToken: string,
    code: string,
    deviceId?: string,
    ip?: string,
    userAgent?: string,
  ) {
    let payload: {
      sub: string;
      scope: string;
      tenantId: string;
      membershipId: string;
      role: string;
      deviceId?: string;
    };
    try {
      payload = this.jwtService.verify(challengeToken);
    } catch {
      throw new UnauthorizedException('Challenge expired. Sign in again.');
    }
    if (payload.scope !== 'totp_challenge') {
      throw new UnauthorizedException('Invalid challenge.');
    }

    const [user] = await this.dbAdmin
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user?.totp_secret || !user.totp_enrolled_at) {
      throw new UnauthorizedException('TOTP is not set up for this account.');
    }

    // Lockout gate: too many recent failures temporarily blocks all attempts.
    if (user.totp_locked_until && user.totp_locked_until.getTime() > Date.now()) {
      throw new UnauthorizedException(
        'Too many failed attempts. Try again in a few minutes.',
      );
    }

    // Accept a valid TOTP code OR a single-use backup code.
    const totpOk = this.totpService.verify(
      code,
      this.totpService.decrypt(user.totp_secret),
    );
    const backupOk = totpOk
      ? false
      : await this.consumeBackupCode(user.id, code, user.totp_backup_codes);

    if (!totpOk && !backupOk) {
      const attempts = (user.totp_failed_attempts ?? 0) + 1;
      const locked = attempts >= MAX_TOTP_ATTEMPTS;
      await this.dbAdmin
        .update(users)
        .set({
          totp_failed_attempts: locked ? 0 : attempts,
          totp_locked_until: locked
            ? new Date(Date.now() + TOTP_LOCK_MS)
            : user.totp_locked_until,
          updated_at: new Date(),
        })
        .where(eq(users.id, user.id));
      await this.writeAuthEvent({
        email: user.email,
        userId: user.id,
        eventType: 'login_failed',
        ip,
        userAgent,
        deviceId,
      });
      throw new UnauthorizedException(
        locked
          ? 'Too many failed attempts. Your account is locked for 15 minutes.'
          : 'Invalid authentication code.',
      );
    }

    // Success — clear any accumulated failure state.
    if ((user.totp_failed_attempts ?? 0) > 0 || user.totp_locked_until) {
      await this.dbAdmin
        .update(users)
        .set({ totp_failed_attempts: 0, totp_locked_until: null, updated_at: new Date() })
        .where(eq(users.id, user.id));
    }

    const { accessToken, refreshToken } = await this.issueTokenPair(
      user,
      payload.tenantId || null,
      payload.membershipId || null,
      (payload.role as UserRole) ?? null,
      deviceId ?? payload.deviceId,
      ip,
      userAgent,
    );

    await this.writeAuthEvent({
      email: user.email,
      userId: user.id,
      eventType: 'login_success',
      ip,
      userAgent,
      deviceId,
    });

    return {
      requiresTenantSelection: false,
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        avatarUrl: user.avatar_url,
      },
    };
  }

  private async upsertTrustedDevice(
    userId: string,
    deviceId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const expiryDays = this.configService.get<number>(
      'TRUSTED_DEVICE_EXPIRY_DAYS',
      30,
    );
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    await this.db
      .insert(trustedDevices)
      .values({
        user_id: userId,
        device_id: deviceId,
        ip_address: ip,
        user_agent: userAgent,
        last_used_at: new Date(),
        expires_at: expiresAt,
      })
      .onConflictDoUpdate({
        target: [trustedDevices.user_id, trustedDevices.device_id],
        set: {
          last_used_at: new Date(),
          ip_address: ip,
          user_agent: userAgent,
          expires_at: expiresAt,
        },
      });
  }

  private async writeAuthEvent(params: {
    email?: string;
    userId?: string;
    eventType: string;
    ip?: string;
    userAgent?: string;
    deviceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db.insert(authEvents).values({
        email: params.email,
        user_id: params.userId,
        event_type: params.eventType as typeof authEvents.$inferInsert['event_type'],
        ip_address: params.ip,
        user_agent: params.userAgent,
        device_id: params.deviceId,
        metadata: params.metadata ?? null,
      });
    } catch (err) {
      this.logger.warn('Failed to write auth event:', err);
    }
  }
}
