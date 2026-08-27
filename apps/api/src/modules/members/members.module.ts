import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MembersService } from './members.service';
import { MembersPublicService } from './public';
import { MeCompaniesController, MembersController } from './members.controller';

/**
 * Auditor role module (Sprint 8, PRD §3/§4.4): invite + grants + seats under
 * /settings/members, and the cross-tenant GET /me/companies self listing.
 * Company switching itself lives in AuthModule (POST /auth/switch-company).
 */
@Module({
  imports: [AuditModule, AuthModule, MediaModule, NotificationsModule],
  controllers: [MembersController, MeCompaniesController],
  providers: [MembersService, MembersPublicService],
  exports: [MembersService, MembersPublicService],
})
export class MembersModule {}
