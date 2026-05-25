import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TotpController } from './totp.controller';
import { TotpService } from './totp.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [NotificationsModule, AuditModule],
  controllers: [AuthController, TotpController],
  providers: [AuthService, TotpService],
  exports: [AuthService],
})
export class AuthModule {}
