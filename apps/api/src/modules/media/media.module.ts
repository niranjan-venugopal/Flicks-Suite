import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

/** Media pipeline (PRD v4 §4). MediaService is exported for signed-URL serialization. */
@Module({
  imports: [AuditModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
