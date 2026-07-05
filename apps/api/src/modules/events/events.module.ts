import { Module } from '@nestjs/common';
import { ConsentModule } from '../consent/consent.module';
import { EventsController } from './events.controller';

/** Client analytics ingestion (PRD v4 §6). */
@Module({
  imports: [ConsentModule],
  controllers: [EventsController],
})
export class EventsModule {}
