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
import type { JwtPayload } from '@flicks/shared/types';

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
@WebSocketGateway({ namespace: '/crm', cors: { origin: true, credentials: true } })
export class CrmGateway implements OnGatewayConnection {
  private readonly logger = new Logger(CrmGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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
      (client.data as { user?: JwtPayload }).user = payload;
      await client.join(`tenant:${payload.tenantId}`);
    } catch {
      client.disconnect(true);
    }
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
