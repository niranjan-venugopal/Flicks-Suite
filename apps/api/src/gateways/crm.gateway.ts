import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { and, eq } from 'drizzle-orm';
import { memberships, tenantModuleToggles } from '@flicks/db/schema';
import type { JwtPayload } from '@flicks/shared/types';
import { DatabaseService } from '../core/database/database.service';
import { wsCors } from '../core/common/ws-cors';

interface BoardChangedPayload {
  tenantId: string;
  pipelineId: string;
  dealId: string;
  stageId: string;
}

/**
 * CRM realtime gateway (PRD v5 §4.1) — pushes live board updates to the tenant
 * room so a drag-drop by one rep appears on every open board within the tenant.
 * Same JWT-handshake pattern as the presence/notifications gateways.
 */
@WebSocketGateway({ namespace: '/crm', cors: wsCors() })
export class CrmGateway implements OnGatewayConnection {
  private readonly logger = new Logger(CrmGateway.name);

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
      // Re-check live access at connect time so a disabled CRM module or a
      // revoked/deactivated membership can't keep receiving board pushes on the
      // strength of a still-valid JWT (mirrors ModuleGrantGuard.loadAccessContext).
      if (!payload.isPlatformAdmin && !(await this.hasLiveCrmAccess(payload))) {
        client.disconnect(true);
        return;
      }
      (client.data as { user?: JwtPayload }).user = payload;
      await client.join(`tenant:${payload.tenantId}`);
    } catch {
      client.disconnect(true);
    }
  }

  /** CRM module enabled for the tenant AND the membership still live. */
  private async hasLiveCrmAccess(user: JwtPayload): Promise<boolean> {
    return this.db.withTenant(
      user.tenantId,
      async (tx) => {
        const toggle = await tx
          .select({ enabled: tenantModuleToggles.enabled })
          .from(tenantModuleToggles)
          .where(
            and(
              eq(tenantModuleToggles.tenant_id, user.tenantId),
              eq(tenantModuleToggles.module, 'crm'),
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

  @OnEvent('crm.board.changed')
  onBoardChanged(payload: BoardChangedPayload): void {
    if (!payload?.tenantId) return;
    this.server.to(`tenant:${payload.tenantId}`).emit('board_changed', {
      pipelineId: payload.pipelineId,
      dealId: payload.dealId,
      stageId: payload.stageId,
    });
  }

  private extractToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (authToken) return authToken;
    const header =
      client.handshake.headers.authorization ??
      (client.handshake.headers.Authorization as string | undefined);
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    const cookies = client.handshake.headers.cookie;
    if (cookies) {
      const m = cookies.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (m) return decodeURIComponent(m[1]!);
    }
    return null;
  }
}
