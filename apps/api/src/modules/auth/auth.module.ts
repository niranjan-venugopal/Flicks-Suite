import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TotpController } from './totp.controller';
import { TotpService } from './totp.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { ConsentModule } from '../consent/consent.module';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [NotificationsModule, AuditModule, ConsentModule, MediaModule],
  controllers: [AuthController, TotpController],
  providers: [AuthService, TotpService],
  exports: [AuthService],
})
export class AuthModule {}
