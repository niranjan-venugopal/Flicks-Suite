import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '@flicks/shared/types';
import {
  PresenceService,
  type LiveActivity,
} from '../modules/presence/presence.service';

/**
 * Presence gateway (PRD v4 §5) — socket.io namespace /presence.
 *
 * The web is cookie-authenticated, so unlike the notifications gateway this
 * one ALSO accepts the httpOnly access_token cookie on the handshake (socket
 * handshakes carry cookies with withCredentials). Live activity is an
 * in-memory map (single-instance beta; a Redis exit-ramp is documented in the
 * tracker) — connected sockets + heartbeat pings ARE the liveness signal.
 *
 * Broadcasts `status_changed` to the tenant room on: connect/disconnect,
 * manual status change (via the `presence.changed` app event), and a timer
 * scheduled at each manual status' expires_at so auto-revert lands without a
 * reload (§5 acceptance).
 */
@WebSocketGateway({
  namespace: '/presence',
  cors: { origin: true, credentials: true },
})
export class PresenceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PresenceGateway.name);

  @WebSocketServer()
  server!: Server;

  /** tenantId → userId → activity. */
  private readonly live = new Map<string, Map<string, LiveActivity>>();
  /** Scheduled expiry re-broadcasts: `${tenantId}:${userId}` → timer. */
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly presence: PresenceService,
  ) {}

  /** The live-activity map for one tenant (resolution input). */
  activityFor(tenantId: string): Map<string, LiveActivity> {
    return this.live.get(tenantId) ?? new Map();
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.disconnect(true);
        return;
      }
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
        issuer: this.configService.get<string>('JWT_ISSUER'),
        audience: this.configService.get<string>('JWT_AUDIENCE'),
      });
      if (!payload.tenantId) {
        client.disconnect(true);
        return;
      }
      (client.data as { user?: JwtPayload }).user = payload;
      await client.join(`tenant:${payload.tenantId}`);
      this.touch(payload.tenantId, payload.sub, true);
      await this.broadcast(payload.tenantId, payload.sub);
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const user = (client.data as { user?: JwtPayload }).user;
    if (!user?.tenantId) return;
    // Only mark disconnected when no other socket of this user remains.
    const stillConnected = [...(await this.server.in(`tenant:${user.tenantId}`).fetchSockets())]
      .some((s) => (s.data as { user?: JwtPayload }).user?.sub === user.sub);
    if (!stillConnected) {
      const tenant = this.live.get(user.tenantId);
      const entry = tenant?.get(user.sub);
      if (entry) entry.connected = false;
      await this.broadcast(user.tenantId, user.sub);
    }
  }

  /** Client activity ping (60s cadence + on interaction bursts). */
  @SubscribeMessage('heartbeat')
  onHeartbeat(client: Socket): void {
    const user = (client.data as { user?: JwtPayload }).user;
    if (!user?.tenantId) return;
    const wasIdle = this.isIdle(user.tenantId, user.sub);
    this.touch(user.tenantId, user.sub, true);
    // Coming back from idle flips away → available org-wide.
    if (wasIdle) void this.broadcast(user.tenantId, user.sub);
  }

  /**
   * App-level presence changes (manual set/clear, punches, leave approval)
   * emit `presence.changed` — re-resolve + broadcast, and (re)schedule the
   * expiry re-broadcast for manual statuses.
   */
  @OnEvent('presence.changed')
  async onPresenceChanged(payload: {
    tenantId: string;
    userId?: string;
    employeeId?: string;
    expiresAt?: string | Date | null;
  }): Promise<void> {
    let userId = payload.userId ?? null;
    if (!userId && payload.employeeId) {
      userId = await this.presence.userIdForEmployee(
        payload.tenantId,
        payload.employeeId,
      );
    }
    if (!userId) return;
    const resolvedUserId = userId;
    await this.broadcast(payload.tenantId, resolvedUserId);
    const key = `${payload.tenantId}:${resolvedUserId}`;
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    if (payload.expiresAt) {
      const delay = new Date(payload.expiresAt).getTime() - Date.now();
      if (delay > 0 && delay < 2 ** 31) {
        const t = setTimeout(() => {
          this.expiryTimers.delete(key);
          void this.broadcast(payload.tenantId, resolvedUserId);
        }, delay + 500);
        this.expiryTimers.set(key, t);
      }
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private touch(tenantId: string, userId: string, connected: boolean): void {
    let tenant = this.live.get(tenantId);
    if (!tenant) {
      tenant = new Map();
      this.live.set(tenantId, tenant);
    }
    tenant.set(userId, { connected, lastActivityAt: Date.now() });
  }

  private isIdle(tenantId: string, userId: string): boolean {
    const entry = this.live.get(tenantId)?.get(userId);
    if (!entry?.lastActivityAt) return true;
    return Date.now() - entry.lastActivityAt > 10 * 60 * 1000;
  }

  /** Resolve one user and push `status_changed` to the tenant room. */
  private async broadcast(tenantId: string, userId: string): Promise<void> {
    try {
      const [resolved] = await this.presence.resolve(
        tenantId,
        [userId],
        this.activityFor(tenantId),
      );
      if (resolved) {
        this.server.to(`tenant:${tenantId}`).emit('status_changed', resolved);
      }
    } catch (err) {
      this.logger.warn(
        `presence broadcast failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private extractToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as { token?: string } | undefined)
      ?.token;
    if (authToken) return authToken;
    const header =
      client.handshake.headers.authorization ??
      (client.handshake.headers.Authorization as string | undefined);
    if (header && typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }
    // Cookie-auth web app: parse the httpOnly access_token from the handshake.
    const cookies = client.handshake.headers.cookie;
    if (cookies) {
      const m = cookies.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  }
}
