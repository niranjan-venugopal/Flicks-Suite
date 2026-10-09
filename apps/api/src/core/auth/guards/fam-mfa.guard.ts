import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { JwtPayload } from '@flicks/shared/types';

/**
 * Round R R2 — the FAM console insists on a finished second factor.
 *
 * Login already challenges an enrolled platform admin for a TOTP code, but
 * an admin who had not enrolled yet received a full session and every /fam
 * route accepted it. The session now carries `mfa: true` only after the
 * TOTP challenge (or enrolment confirmation) succeeded; when enforcement is
 * on (TOTP_SECRET configured — the same switch TotpService.isEnforced reads)
 * a platform-admin session without it is refused here with a code the web
 * shell turns into "finish setting up two-factor".
 *
 * Applied at class level on the FAM controllers; the /auth/totp/* routes stay
 * reachable so enrolment itself still works.
 */
@Injectable()
export class FamMfaGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const enforced = !!this.config.get<string>('TOTP_SECRET');
    if (!enforced) return true;
    const req = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = req.user;
    if (!user?.isPlatformAdmin) return true;
    if (user.mfa === true) return true;
    throw new ForbiddenException({
      code: 'TOTP_REQUIRED',
      message: 'Finish two-factor sign-in to use the FAM console.',
    });
  }
}
