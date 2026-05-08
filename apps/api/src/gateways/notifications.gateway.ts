import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '@flicks/shared/types';

interface NotificationCreatedPayload {
  userId: string;
  tenantId?: string;
  type: string;
  message: string;
  linkUrl?: string;
  createdAt: Date | string;
}

@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Authenticates the socket on connection using a JWT supplied via
   * `auth.token` (preferred) or the `Authorization: Bearer <token>` header,
   * then joins the user-specific room `user:<userId>`.
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`Socket ${client.id} connected without token — disconnecting`);
        client.disconnect(true);
        return;
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
        issuer: this.configService.get<string>('JWT_ISSUER'),
        audience: this.configService.get<string>('JWT_AUDIENCE'),
      });

      // Stash the payload for later lookups
      (client.data as { user?: JwtPayload }).user = payload;

      const room = `user:${payload.sub}`;
      await client.join(room);

      if (payload.tenantId) {
        await client.join(`tenant:${payload.tenantId}`);
      }

      this.logger.log(
        `Socket ${client.id} authed as user=${payload.sub} joined ${room}`,
      );
    } catch (err) {
      this.logger.warn(
        `Socket ${client.id} JWT verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const user = (client.data as { user?: JwtPayload }).user;
    this.logger.debug(
      `Socket ${client.id} disconnected (user=${user?.sub ?? 'anonymous'})`,
    );
  }

  /**
   * Listens for `notification.created` events emitted by NotificationsService
   * and pushes them to the recipient's room over the WebSocket.
   */
  @OnEvent('notification.created')
  handleNotificationCreated(payload: NotificationCreatedPayload): void {
    if (!payload?.userId) {
      this.logger.warn('Received notification.created without userId — skipping');
      return;
    }

    const room = `user:${payload.userId}`;
    this.server.to(room).emit('notification', {
      type: payload.type,
      message: payload.message,
      linkUrl: payload.linkUrl,
      createdAt: payload.createdAt,
    });

    this.logger.debug(`Pushed notification to ${room} (type=${payload.type})`);
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private extractToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as { token?: string } | undefined)?.token;
    if (authToken) {
      return authToken;
    }

    const header =
      client.handshake.headers.authorization ??
      (client.handshake.headers.Authorization as string | undefined);

    if (header && typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }

    return null;
  }
}
