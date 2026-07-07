import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

/** Feedback + NPS (PRD v4 §7). */
@Module({
  imports: [AuditModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
