import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaModule } from '../media/public';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

/**
 * Company asset register (Round P R4) — equipment rows, photo (MediaService
 * pipeline), assign / return / acknowledge, My assets, CSV export. Database
 * and config come from the global core modules. The employees module reaches
 * this module's data only through the plain tx helpers in ./public.ts.
 */
@Module({
  imports: [AuditModule, NotificationsModule, MediaModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
