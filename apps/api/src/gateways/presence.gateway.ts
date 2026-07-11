import { Inject, Logger } from '@nestjs/common';
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
import type Redis from 'ioredis';
import type { JwtPayload } from '@flicks/shared/types';
import { REDIS_CLIENT } from '../core/redis/redis.module';
import {
  PresenceService,
  type LiveActivity,
} from '../modules/presence/presence.service';

/**
 * Presence gateway (PRD v4 §5) — socket.io namespace /presence.
 *
 * The web is cookie-authenticated, so unlike the notifications gateway this
 * one ALSO accepts the httpOnly access_token cookie on the handshake (socket
 * handshakes carry cookies with withCredentials). Live activity lives in
 * Redis (§5.2: SETEX presence:last:<tenant>:<user> 1800) so any API instance
 * sees the same liveness and a restart doesn't zero everyone — connected
 * sockets + heartbeat pings ARE the liveness signal. On a clean last-socket
 * disconnect the key is DELETED (immediate offline); on an unclean drop it
 * lingers, so the §5.1 away(10m)→offline(30m TTL) gradient still applies.
 *
 * Broadcasts `status_changed` to the tenant room on: connect/disconnect,
 * manual status change (via the `presence.changed` app event), and a timer
 * scheduled at each manual status' expires_at so auto-revert lands without a
 * reload (§5 acceptance).
 */
const LIVE_TTL_SECONDS = 1800; // §5.2 — matches the 30-min offline threshold
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

  /** Scheduled expiry re-broadcasts: `${tenantId}:${userId}` → timer. */
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly presence: PresenceService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private liveKey(tenantId: string, userId: string): string {
    return `presence:last:${tenantId}:${userId}`;
  }

  /**
   * Live-activity snapshot for the requested users (resolution input). MGETs
   * the per-user liveness keys — O(ids), no SCAN. A missing key means no
   * connection/heartbeat within the TTL → not connected. Degrades to an empty
   * map (everyone offline) if Redis is unreachable rather than failing reads.
   */
  async buildActivity(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, LiveActivity>> {
    const map = new Map<string, LiveActivity>();
    if (userIds.length === 0) return map;
    try {
      const values = await this.redis.mget(
        userIds.map((id) => this.liveKey(tenantId, id)),
      );
      userIds.forEach((id, i) => {
        const v = values[i];
        if (v != null) {
          map.set(id, { connected: true, lastActivityAt: Number(v) || null });
        }
      });
    } catch (err) {
      this.logger.warn(
        `presence liveness read failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return map;
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
      await this.touch(payload.tenantId, payload.sub);
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
      // Clean last-socket disconnect → drop the liveness key (immediate
      // offline). Unclean drops skip this path and age out via the TTL.
      try {
        await this.redis.del(this.liveKey(user.tenantId, user.sub));
      } catch (err) {
        this.logger.warn(
          `presence liveness del failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      await this.broadcast(user.tenantId, user.sub);
    }
  }

  /** Client activity ping (60s cadence + on interaction bursts). */
  @SubscribeMessage('heartbeat')
  async onHeartbeat(client: Socket): Promise<void> {
    const user = (client.data as { user?: JwtPayload }).user;
    if (!user?.tenantId) return;
    const wasIdle = await this.isIdle(user.tenantId, user.sub);
    await this.touch(user.tenantId, user.sub);
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

  /** §5.2 — SETEX presence:last:<tenant>:<user> 1800 with the activity time. */
  private async touch(tenantId: string, userId: string): Promise<void> {
    try {
      await this.redis.set(
        this.liveKey(tenantId, userId),
        String(Date.now()),
        'EX',
        LIVE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `presence liveness write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async isIdle(tenantId: string, userId: string): Promise<boolean> {
    try {
      const v = await this.redis.get(this.liveKey(tenantId, userId));
      if (v == null) return true;
      return Date.now() - Number(v) > 10 * 60 * 1000;
    } catch {
      return true;
    }
  }

  /** Resolve one user and push `status_changed` to the tenant room. */
  private async broadcast(tenantId: string, userId: string): Promise<void> {
    try {
      const [resolved] = await this.presence.resolve(
        tenantId,
        [userId],
        await this.buildActivity(tenantId, [userId]),
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
