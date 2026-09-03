import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
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
import { eq, and, gt, isNull, lt, asc, desc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { Request, Response } from 'express';
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
  designations,
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

// The Specflicks-internal platform tenant (FAM memberships live here).
// Mirrors the private const in billing.service.ts:30 — keep in sync.
const SPECFLICKS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

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

    // Brand-new accounts get a CODE-ONLY email: a magic link cannot carry the
    // Terms-of-Service acceptance a first signup requires (§3.4 clickwrap), so
    // including one just walks new users into "Link expired or invalid".
    // Existing accounts keep the one-click link.
    const isNewAccount = !existingUser[0];

    // Send email
    await this.notificationsService.sendEmail('login-otp', normalizedEmail, {
      otpCode,
      ...(isNewAccount ? {} : { magicLinkUrl }),
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
      message: isNewAccount
        ? 'We sent a sign-in code to your email.'
        : 'We sent a sign-in code and magic link to your email.',
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

  /**
   * Round H — a NON-consuming look at a magic-link token.
   *
   * The invite email lands on the web /verify page, which used to consume the
   * token the moment it loaded. Corporate mail security (Outlook / Defender
   * Safe Links, Google link scanning) opens links at delivery time, so the
   * single-use token was routinely burned minutes before the invitee clicked —
   * every guest hit "Magic link has already been used" on their FIRST click.
   * The page now peeks first and consumes only on an explicit button press.
   *
   * Returns the row's email for ready/consumed tokens: the 64-hex token is the
   * secret from the recipient's own inbox, so whoever presents it is the
   * recipient — and the recovery path needs the address to send a code to.
   */
  async peekMagicLink(token: string): Promise<{
    status: 'ready' | 'consumed' | 'expired' | 'invalid';
    email?: string;
    /**
     * Founder decision: the explicit "Continue" click is for GUEST invite
     * links only — those are the ones corporate scanners burn, and the
     * invitee is new to the product. Existing licensed users keep the
     * one-click sign-in; if that fails the page falls back to recovery.
     */
    requiresClick?: boolean;
  }> {
    if (!/^[0-9a-f]{64}$/i.test(token ?? '')) return { status: 'invalid' };
    const tokenHash = sha256(token);
    const [otp] = await this.db
      .select()
      .from(authOtps)
      .where(eq(authOtps.magic_link_token, tokenHash))
      .orderBy(desc(authOtps.created_at))
      .limit(1);
    if (!otp) return { status: 'invalid' };

    // An invite link (issueInviteMagicLink) lives 7 days; a sign-in link
    // (requestOtp) minutes. Only an invite link held by a guest seat needs
    // the click.
    const isInviteLink =
      otp.expires_at.getTime() - otp.created_at.getTime() > 24 * 60 * 60 * 1000;
    let requiresClick = false;
    if (isInviteLink && otp.user_id) {
      const [guestSeat] = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.user_id, otp.user_id),
            eq(memberships.role, 'guest'),
            sql`${memberships.status} <> 'deactivated'`,
          ),
        )
        .limit(1);
      requiresClick = !!guestSeat;
    }

    if (otp.expires_at.getTime() <= Date.now()) {
      return { status: 'expired', email: otp.email, requiresClick };
    }
    if (otp.consumed_at && otp.consumed_at.getTime() < Date.now() - 60 * 1000) {
      return { status: 'consumed', email: otp.email, requiresClick };
    }
    return { status: 'ready', email: otp.email, requiresClick };
  }

  /**
   * Round H — never dead-end a burned link (house rule 8). The holder of a
   * consumed/expired magic-link token gets a fresh 6-digit code emailed to the
   * SAME address (full requestOtp semantics: quota, invalidation, auth event),
   * and the address back so the login page can open straight at the code step.
   * Tokens older than 30 days are refused — a link that old is not a login
   * attempt, and the OTP route stays the only way to probe an address.
   */
  async recoverMagicLink(token: string, ip?: string, userAgent?: string): Promise<{ email: string }> {
    if (!/^[0-9a-f]{64}$/i.test(token ?? '')) {
      throw new UnauthorizedException('Invalid or expired magic link');
    }
    const tokenHash = sha256(token);
    const [otp] = await this.db
      .select()
      .from(authOtps)
      .where(
        and(
          eq(authOtps.magic_link_token, tokenHash),
          gt(authOtps.created_at, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(desc(authOtps.created_at))
      .limit(1);
    if (!otp) throw new UnauthorizedException('Invalid or expired magic link');
    await this.requestOtp(otp.email, ip, userAgent, 'signin');
    return { email: otp.email };
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
      )
      .orderBy(asc(memberships.created_at));

    // Deterministic auto-select. The old behavior returned
    // requiresTenantSelection (a token-less response) for >1 membership, but
    // no client surface ever implemented that branch — a platform admin or
    // multi-company user hit a silent dead-end at login. Instead (round 7,
    // founder decision + Linear/ClickUp/Microsoft convention): always land
    // the user in their OWN workspace — non-guest memberships first, the
    // Specflicks platform tenant last, oldest within each class. Guest-only
    // users land in their oldest guest workspace. In-app switching
    // (CompanySwitcher → /auth/switch-company) covers the rest.
    // (stable sort: SQL already ordered oldest-first)
    const sortedMemberships = [...userMemberships].sort(
      (a, b) => this.membershipRank(a) - this.membershipRank(b),
    );
    // Round H — accept lands where you were invited. When THIS login flipped
    // exactly one invited membership to active (i.e. the user just followed an
    // invite link or signed in right after being invited), land in that
    // workspace even if the rank would prefer one they own: a guest who
    // already has their own workspace was otherwise dropped into it and the
    // project they were invited to looked like it had vanished.
    const justAccepted =
      activated.length === 1
        ? sortedMemberships.find((m) => m.tenantId === activated[0]!.tenant_id)
        : undefined;
    const activeMembership = justAccepted ?? sortedMemberships[0];

    // A login from a device the user previously chose to trust auto-issues
    // the long (180-day) session — no re-prompt after a logout/login. Rows
    // are only CREATED via the explicit trust-device consent; here we just
    // check and refresh last-seen metadata.
    const trustedDevice = deviceId
      ? await this.isTrustedDevice(currentUser.id, deviceId)
      : false;
    if (trustedDevice && deviceId) {
      await this.touchTrustedDevice(currentUser.id, deviceId, ip, userAgent);
    }

    await this.writeAuthEvent({
      email,
      userId: currentUser.id,
      eventType: 'login_success',
      ip,
      userAgent,
      deviceId,
    });

    if (!activeMembership) {
      // No tenant yet — return partial auth for onboarding
      const { accessToken, refreshToken, refreshTtlMs } =
        await this.issueTokenPair(
          currentUser,
          null,
          null,
          null,
          deviceId,
          ip,
          userAgent,
          undefined,
          { trusted: trustedDevice },
        );

      return {
        requiresTenantSelection: false,
        needsOnboarding: true,
        accessToken,
        refreshToken,
        refreshTtlMs,
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
          undefined,
          { trusted: trustedDevice },
        );
        return {
          requiresTenantSelection: false,
          requiresTotpEnrollment: true,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          refreshTtlMs: tokens.refreshTtlMs,
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

    const { accessToken, refreshToken, refreshTtlMs } =
      await this.issueTokenPair(
        currentUser,
        activeMembership.tenantId,
        activeMembership.id,
        activeMembership.role as UserRole,
        deviceId,
        ip,
        userAgent,
        undefined,
        { trusted: trustedDevice },
      );

    return {
      requiresTenantSelection: false,
      accessToken,
      refreshToken,
      refreshTtlMs,
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

    // Rotation must not silently downgrade a trusted (180-day) session to
    // the 7-day window — carry the old token's trusted flag forward, but
    // re-validate the device consent first: a revoked or expired
    // trusted_devices row quietly demotes the chain back to 7 days (the
    // future "sign out of this device" hook).
    const rotationDeviceId = deviceId ?? token.device_id ?? undefined;
    let stillTrusted = token.trusted === true;
    if (stillTrusted) {
      stillTrusted = rotationDeviceId
        ? await this.isTrustedDevice(token.user_id, rotationDeviceId)
        : false;
    }

    // Issue new pair — preserve the impersonator marker so the next
    // access token still surfaces the banner and audit trail.
    const { accessToken, refreshToken: newRefreshToken, refreshTtlMs } =
      await this.issueTokenPair(
        user[0],
        token.tenant_id,
        membershipInfo?.id ?? null,
        (membershipInfo?.role ?? null) as UserRole | null,
        rotationDeviceId,
        ip,
        userAgent,
        token.impersonator_user_id ?? undefined,
        { trusted: stillTrusted },
      );

    await this.writeAuthEvent({
      userId: token.user_id,
      eventType: 'token_refreshed',
      ip,
      userAgent,
      deviceId: rotationDeviceId,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      refreshTtlMs,
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

  async selectTenant(userId: string, tenantId: string, deviceId?: string) {
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

    // Workspace switches keep the trusted-device session length.
    const switchTrusted = deviceId
      ? await this.isTrustedDevice(userId, deviceId)
      : false;
    const { accessToken, refreshToken, refreshTtlMs } =
      await this.issueTokenPair(
        user[0],
        tenantId,
        membership.id,
        membership.role as UserRole,
        deviceId,
        undefined,
        undefined,
        undefined,
        { trusted: switchTrusted },
      );

    await this.writeAuthEvent({
      userId,
      eventType: 'tenant_selected',
      metadata: { tenantId, ...(activated ? { invite_accepted: true } : {}) },
    });

    return { accessToken, refreshToken, refreshTtlMs, expiresIn: 900 };
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

  async getMe(userId: string, tenantId?: string, deviceId?: string) {
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

    // The profile chip / dropdown show the person's DESIGNATION (job title),
    // not their workspace role — resolved from their employee record.
    let designationTitle: string | null = null;
    if (currentMembership?.employeeId) {
      const [d] = await this.dbAdmin
        .select({ title: designations.title })
        .from(employees)
        .leftJoin(designations, eq(employees.designation_id, designations.id))
        .where(eq(employees.id, currentMembership.employeeId))
        .limit(1);
      designationTitle = d?.title ?? null;
    }

    // §3.2 — policy-bump re-acceptance flag (also true for pre-ledger users).
    const requiresReacceptance =
      await this.consentService.requiresReacceptance(userId);

    // Drives the post-login "stay signed in for 180 days?" prompt — false
    // until the user consents on this device (or after revocation/expiry).
    const deviceTrusted = deviceId
      ? await this.isTrustedDevice(userId, deviceId)
      : false;

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
      deviceTrusted,
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
            designationTitle,
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

  private cookieBase(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'strict' | 'lax';
  } {
    const isProd =
      this.configService.get<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'strict' : 'lax',
    };
  }

  setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
    // Cookie lifetime must match the refresh token actually minted (7d
    // default, 180d trusted, 15m impersonation) — callers pass the
    // refreshTtlMs from issueTokenPair's result.
    refreshTtlMs: number = 7 * 24 * 60 * 60 * 1000,
  ): void {
    const accessExpiry = 15 * 60 * 1000; // 15 minutes

    res.cookie('access_token', accessToken, {
      ...this.cookieBase(),
      maxAge: accessExpiry,
      path: '/',
    });

    this.setRefreshCookie(res, refreshToken, refreshTtlMs);
  }

  setRefreshCookie(res: Response, refreshToken: string, ttlMs: number): void {
    res.cookie('refresh_token', refreshToken, {
      ...this.cookieBase(),
      maxAge: ttlMs,
      path: '/api/v1/auth',
    });
  }

  /**
   * Stable per-browser device id, minted on first contact and carried as a
   * long-lived httpOnly cookie. This is what trusted-device sessions key on.
   */
  ensureDeviceId(req: Request, res: Response, fallback?: string): string {
    const existing =
      (req.cookies?.['fs_device_id'] as string | undefined) ??
      (req.headers['x-device-id'] as string | undefined) ??
      fallback;
    const deviceId = existing || crypto.randomUUID();
    // (Re)set on every auth touch so the ~400-day window slides.
    res.cookie('fs_device_id', deviceId, {
      ...this.cookieBase(),
      maxAge: 400 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    return deviceId;
  }

  clearAuthCookies(res: Response): void {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/api/v1/auth' });
    // fs_device_id survives logout on purpose — the device stays trusted.
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
    opts: { preferTenantId?: string } = {},
  ): Promise<{ tenantId: string | null; role: string | null }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Fetch ALL active memberships and pick deterministically: the caller's
    // preferred tenant first (e.g. the workspace they just CREATED — the old
    // unordered .limit(1) could re-scope a guest right back into the guest
    // tenant), else the same own-workspace-first rank as login auto-select.
    const activeRows = await this.dbAdmin
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
      .orderBy(asc(memberships.created_at));
    const activeMembership =
      (opts.preferTenantId
        ? activeRows.find((m) => m.tenantId === opts.preferTenantId)
        : undefined) ??
      [...activeRows].sort(
        (a, b) => this.membershipRank(a) - this.membershipRank(b),
      )[0];

    const { accessToken, refreshToken, refreshTtlMs } =
      await this.issueTokenPair(
        user,
        activeMembership?.tenantId ?? null,
        activeMembership?.id ?? null,
        (activeMembership?.role as UserRole | undefined) ?? null,
      );

    this.setAuthCookies(res, accessToken, refreshToken, refreshTtlMs);

    return {
      tenantId: activeMembership?.tenantId ?? null,
      role: activeMembership?.role ?? null,
    };
  }

  /**
   * Auto-select rank (round 7): own (non-guest) workspaces first, the
   * Specflicks platform tenant last within each class; ties keep the
   * caller's oldest-first ordering (stable sort).
   */
  private membershipRank(m: { role: string; tenantId: string }): number {
    return (
      (m.role === 'guest' ? 2 : 0) +
      (m.tenantId === SPECFLICKS_TENANT_ID ? 1 : 0)
    );
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
    opts: { trusted?: boolean } = {},
  ): Promise<{ accessToken: string; refreshToken: string; refreshTtlMs: number }> {
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
    // Refresh lifetime: impersonation is short-lived (15 min cap matches
    // the access token); a session on a TRUSTED device gets the long
    // Zoho-style window (default 180 days); everything else the standard
    // 7-day window.
    const trusted = !impersonatorUserId && opts.trusted === true;
    const refreshTtlMs = impersonatorUserId
      ? 15 * 60 * 1000
      : trusted
        ? this.trustedSessionDays() * 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
    const refreshExpiry = new Date(Date.now() + refreshTtlMs);

    await this.db.insert(refreshTokens).values({
      user_id: user.id,
      tenant_id: tenantId,
      token_hash: refreshTokenHash,
      device_id: deviceId,
      ip_address: ip,
      user_agent: userAgent,
      expires_at: refreshExpiry,
      last_used_at: new Date(),
      trusted,
      impersonator_user_id: impersonatorUserId ?? null,
    });

    return { accessToken, refreshToken: rawRefreshToken, refreshTtlMs };
  }

  /** Configured trusted-session length in days (Zoho-style long session). */
  private trustedSessionDays(): number {
    return Number(
      this.configService.get<string>('TRUSTED_SESSION_EXPIRY_DAYS', '180'),
    );
  }

  // ─── FAM TOTP enrolment + challenge (PRD §11.6) ───────────────────────────

  /**
   * Return the pending TOTP secret for a FAM user, generating one only when
   * needed. IDEMPOTENT by design: the setup page calls this on every mount,
   * and regenerating each time silently invalidated whatever the user had
   * already added to their authenticator app (the prod enrolment loop).
   * `regenerate` is the explicit escape hatch for a stale authenticator
   * entry; an already-enrolled user gets a conflict so the client can route
   * them to the challenge flow instead.
   */
  async enrollTotp(
    userId: string,
    opts?: { regenerate?: boolean },
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const [user] = await this.dbAdmin
      .select({
        email: users.email,
        isPlatformAdmin: users.is_platform_admin,
        secret: users.totp_secret,
        enrolledAt: users.totp_enrolled_at,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (!user.isPlatformAdmin) {
      throw new ForbiddenException('TOTP enrolment is for platform admins only');
    }
    if (user.enrolledAt) {
      throw new ConflictException(
        'Two-factor is already set up — sign in with your authenticator code.',
      );
    }

    if (user.secret && !opts?.regenerate) {
      const secret = this.totpService.decrypt(user.secret);
      return { secret, otpauthUrl: this.totpService.keyUri(user.email, secret) };
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

    const totpDeviceId = deviceId ?? payload.deviceId;
    const totpTrusted = totpDeviceId
      ? await this.isTrustedDevice(user.id, totpDeviceId)
      : false;
    const { accessToken, refreshToken, refreshTtlMs } =
      await this.issueTokenPair(
        user,
        payload.tenantId || null,
        payload.membershipId || null,
        (payload.role as UserRole) ?? null,
        totpDeviceId,
        ip,
        userAgent,
        undefined,
        { trusted: totpTrusted },
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
      refreshTtlMs,
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
    // Device-trust window = trusted-session window (default 180 days).
    const expiryDays = Number(
      this.configService.get<string | number>(
        'TRUSTED_DEVICE_EXPIRY_DAYS',
        this.trustedSessionDays(),
      ),
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
        device_name: this.deviceNameFromUa(userAgent),
      })
      .onConflictDoUpdate({
        target: [trustedDevices.user_id, trustedDevices.device_id],
        set: {
          last_used_at: new Date(),
          ip_address: ip,
          user_agent: userAgent,
          expires_at: expiresAt,
          revoked_at: null,
          device_name: this.deviceNameFromUa(userAgent),
        },
      });
  }

  /** "Chrome · macOS"-style label parsed from the user-agent, for device lists. */
  private deviceNameFromUa(ua?: string): string | null {
    if (!ua) return null;
    const browser = /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua) && /Version\//.test(ua)
            ? 'Safari'
            : /Firefox\//.test(ua)
              ? 'Firefox'
              : 'Browser';
    const os = /Windows/.test(ua)
      ? 'Windows'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad|iOS/.test(ua)
            ? 'iOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown OS';
    return `${browser} · ${os}`;
  }

  /** Live consent check: an unrevoked, unexpired trusted_devices row. */
  async isTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.user_id, userId),
          eq(trustedDevices.device_id, deviceId),
          isNull(trustedDevices.revoked_at),
          gt(trustedDevices.expires_at, new Date()),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Login-time touch: refresh last-seen metadata on an EXISTING device row
   * without ever creating one — a trusted_devices row only comes into
   * existence through the user's explicit "stay signed in" consent
   * (trustDevice below), never as a side effect of logging in.
   */
  private async touchTrustedDevice(
    userId: string,
    deviceId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    await this.db
      .update(trustedDevices)
      .set({ last_used_at: new Date(), ip_address: ip, user_agent: userAgent })
      .where(
        and(
          eq(trustedDevices.user_id, userId),
          eq(trustedDevices.device_id, deviceId),
        ),
      );
  }

  /**
   * The user said "stay signed in on this device for 180 days": record the
   * device consent and upgrade the CURRENT session in place — the active
   * refresh token is marked trusted and its expiry extended, so no re-login
   * is needed and the caller just re-sets the refresh cookie with the long
   * maxAge. Future logins on this device auto-issue trusted sessions.
   */
  async trustDevice(
    userId: string,
    deviceId: string,
    rawRefreshToken: string | undefined,
    ip?: string,
    userAgent?: string,
  ): Promise<{ trusted: true; refreshTtlMs: number; expiresAt: Date }> {
    await this.upsertTrustedDevice(userId, deviceId, ip, userAgent);

    const refreshTtlMs = this.trustedSessionDays() * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + refreshTtlMs);
    if (rawRefreshToken) {
      await this.db
        .update(refreshTokens)
        .set({ trusted: true, expires_at: expiresAt })
        .where(
          and(
            eq(refreshTokens.token_hash, sha256(rawRefreshToken)),
            eq(refreshTokens.user_id, userId),
            isNull(refreshTokens.revoked_at),
          ),
        );
    }

    await this.writeAuthEvent({
      userId,
      eventType: 'login_success',
      ip,
      userAgent,
      deviceId,
      metadata: { trustedDevice: true, days: this.trustedSessionDays() },
    });

    return { trusted: true, refreshTtlMs, expiresAt };
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
