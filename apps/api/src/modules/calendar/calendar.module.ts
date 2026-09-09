import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { MeetingLinksService } from './meeting-links.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaModule } from '../media/media.module';
import { CrmModule } from '../crm/crm.module';

/**
 * Round J — DatabaseModule, DomainEventsModule, ModuleAccessModule and
 * ConfigModule are global; CRM is reached only through its public facade.
 */
@Module({
  imports: [AuditModule, NotificationsModule, MediaModule, CrmModule],
  controllers: [CalendarController],
  providers: [CalendarService, MeetingLinksService],
  exports: [CalendarService, MeetingLinksService],
})
export class CalendarModule {}
