import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
// Round N: MediaService signs the author's avatar key on the FAM inbox rows.
import { MediaModule } from '../media/media.module';

/** Feedback + NPS (PRD v4 §7). */
@Module({
  imports: [AuditModule, MediaModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
