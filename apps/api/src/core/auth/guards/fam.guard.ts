import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { JwtPayload } from '@flicks/shared/types';

@Injectable()
export class FamGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest() as {
      user: JwtPayload;
    };

    if (!user || !user.isPlatformAdmin) {
      throw new ForbiddenException(
        'Access denied: Platform Admin privileges required',
      );
    }

    return true;
  }
}
