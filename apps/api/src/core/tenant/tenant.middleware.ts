import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ClsService } from 'nestjs-cls';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { JwtPayload } from '@flicks/shared/types';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly cls: ClsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    try {
      const token =
        req.cookies?.['access_token'] ||
        req.headers.authorization?.replace('Bearer ', '');

      if (token) {
        const payload = this.jwtService.verify<JwtPayload>(token, {
          secret: this.configService.get<string>('JWT_SECRET'),
        });

        if (payload.tenantId) {
          this.cls.set('tenantId', payload.tenantId);
        }
        if (payload.sub) {
          this.cls.set('userId', payload.sub);
        }
        if (payload.role) {
          this.cls.set('userRole', payload.role);
        }
        if (payload.impersonatorUserId) {
          this.cls.set('impersonatorUserId', payload.impersonatorUserId);
        }
      }
    } catch {
      // Token invalid or missing - that's fine, guards will handle auth
    }

    next();
  }
}
