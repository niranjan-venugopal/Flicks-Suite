import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
  Inject,
} from '@nestjs/common';
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
} from '@flicks/db/schema';
import {
  DB_TENANT,
  DB_SERVICE_ROLE,
} from '../../core/database/database.module';
import type { Db, DbAdmin } from '@flicks/db';
import type { JwtPayload, UserRole } from '@flicks/shared/types';
import { NotificationsService } from '../notifications/notifications.service';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB_TENANT) private readonly db: Db,
    // Auth is a platform-level concern: it discovers a user's tenants by
    // querying memberships before any tenant context is established. The
    // service-role client bypasses RLS, which is required for that lookup.
    @Inject(DB_SERVICE_ROLE) private readonly dbAdmin: DbAdmin,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly notificationsService: NotificationsService,
  ) {}

  async requestOtp(
    email: string,
    ip?: string,
    userAgent?: string,
  ): Promise<{ success: true; message: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = sha256(otpCode);
    const magicLinkRawToken = generateSecureToken();
    const magicLinkHash = sha256(magicLinkRawToken);

    const expiryMinutes = this.configService.get<number>(
      'OTP_EXPIRY_MINUTES',
      10,
    );
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Find existing user (don't reveal if user exists)
    const existingUser = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

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
      'http://localhost:3000/auth/magic',
    );
    const magicLinkUrl = `${magicLinkBaseUrl}?token=${magicLinkRawToken}`;

    // Send email
    await this.notificationsService.sendEmail('otp-login', normalizedEmail, {
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

    // Always return generic success (never reveal if email exists)
    return {
      success: true,
      message:
        'If this email is registered, you will receive an OTP and magic link shortly.',
    };
  }

  async verifyOtp(
    email: string,
    code: string,
    deviceId?: string,
    ip?: string,
    userAgent?: string,
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

    return this.handleSuccessfulAuth(normalizedEmail, deviceId, ip, userAgent);
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
    const candidates = await this.db
      .select()
      .from(authOtps)
      .where(
        and(
          eq(authOtps.magic_link_token, tokenHash),
          gt(authOtps.expires_at, new Date()),
        ),
      )
      .orderBy(desc(authOtps.created_at))
      .limit(1);

    const otp = candidates[0];

    if (!otp) {
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
  ) {
    // Find or create user
    let user = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user[0]) {
      const inserted = await this.db
        .insert(users)
        .values({
          email,
          full_name: email.split('@')[0],
          email_verified_at: new Date(),
        })
        .returning();
      user = inserted;
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
    await this.dbAdmin
      .update(memberships)
      .set({ status: 'active', accepted_at: new Date() })
      .where(
        and(
          eq(memberships.user_id, currentUser.id),
          eq(memberships.status, 'invited'),
        ),
      );

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
    const membershipResult = await this.dbAdmin
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, userId),
          eq(memberships.tenant_id, tenantId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);

    if (!membershipResult[0]) {
      throw new BadRequestException('No active membership found for this tenant');
    }

    const membership = membershipResult[0];

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
      metadata: { tenantId },
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
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenant_id, tenants.id))
      .where(eq(memberships.user_id, userId));

    const currentMembership = tenantId
      ? userMemberships.find((m) => m.tenantId === tenantId)
      : userMemberships[0];

    return {
      id: user[0].id,
      email: user[0].email,
      fullName: user[0].full_name,
      avatarUrl: user[0].avatar_url,
      phone: user[0].phone,
      isPlatformAdmin: user[0].is_platform_admin,
      status: user[0].status,
      locale: user[0].locale,
      timezone: user[0].timezone,
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
