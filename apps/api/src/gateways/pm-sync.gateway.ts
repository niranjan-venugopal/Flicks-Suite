import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { and, eq } from 'drizzle-orm';
import { memberships, tenantModuleToggles } from '@flicks/db/schema';
import type { JwtPayload } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';

/**
 * FSE realtime gateway (PRD v6 §3.6) — socket.io namespace /sync, room per
 * tenant, payload `{seq}` ONLY (never data → zero leakage risk; permission
 * filtering happens exclusively at delta pull). The mutate path calls
 * emitSeq() directly post-commit (<1s propagation budget); a client compares
 * seq to its cursor and pulls the delta. Same JWT-handshake + live-access
 * re-check pattern as the CRM gateway.
 */
@WebSocketGateway({ namespace: '/sync', cors: { origin: true, credentials: true } })
export class PmSyncGateway implements OnGatewayConnection {
  private readonly logger = new Logger(PmSyncGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly db: DatabaseService,
  ) {}

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
      // Live-access re-check: a disabled pm module or dead membership can't
      // keep receiving seq pings on the strength of a still-valid JWT.
      if (!payload.isPlatformAdmin && !(await this.hasLivePmAccess(payload))) {
        client.disconnect(true);
        return;
      }
      (client.data as { user?: JwtPayload }).user = payload;
      await client.join(`tenant:${payload.tenantId}`);
    } catch {
      client.disconnect(true);
    }
  }

  /** Called by the mutation executor directly after commit. */
  emitSeq(tenantId: string, seq: number): void {
    try {
      this.server?.to(`tenant:${tenantId}`).emit('seq', { seq });
    } catch (err) {
      this.logger.warn(`seq ping failed for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async hasLivePmAccess(user: JwtPayload): Promise<boolean> {
    return this.db.withTenant(
      user.tenantId,
      async (tx) => {
        const toggle = await tx
          .select({ enabled: tenantModuleToggles.enabled })
          .from(tenantModuleToggles)
          .where(
            and(
              eq(tenantModuleToggles.tenant_id, user.tenantId),
              eq(tenantModuleToggles.module, 'pm'),
            ),
          )
          .limit(1);
        const moduleEnabled = toggle.length === 0 ? true : toggle[0]!.enabled;
        if (!moduleEnabled) return false;

        if (!user.membershipId) return false;
        const memRows = await tx
          .select({ status: memberships.status, expires: memberships.access_expires_at })
          .from(memberships)
          .where(and(eq(memberships.id, user.membershipId), eq(memberships.tenant_id, user.tenantId)))
          .limit(1);
        const m = memRows[0];
        return !!m && m.status === 'active' && (!m.expires || m.expires.getTime() > Date.now());
      },
      user.sub,
    );
  }

  private extractToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (authToken) return authToken;
    const header =
      client.handshake.headers.authorization ??
      (client.handshake.headers.Authorization as string | undefined);
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    // Cookie-auth web app (httpOnly access_token; handshake carries cookies
    // because the client connects withCredentials).
    const cookies = client.handshake.headers.cookie;
    if (cookies) {
      const m = cookies.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (m) return decodeURIComponent(m[1]!);
    }
    return null;
  }
}
