import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          const userId = this.cls.get<string>('userId');
          const tenantId = this.cls.get<string>('tenantId');

          // Log write operations for audit trail
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
            this.logger.log({
              method: request.method,
              url: request.url,
              userId,
              tenantId,
              duration,
              ip: request.ip,
            });
          }
        },
        error: (err: unknown) => {
          const duration = Date.now() - startTime;
          const userId = this.cls.get<string>('userId');
          const tenantId = this.cls.get<string>('tenantId');
          const errorMessage =
            err instanceof Error ? err.message : 'Unknown error';

          this.logger.warn({
            method: request.method,
            url: request.url,
            userId,
            tenantId,
            duration,
            error: errorMessage,
          });
        },
      }),
    );
  }
}
