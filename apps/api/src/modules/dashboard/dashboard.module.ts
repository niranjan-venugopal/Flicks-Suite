import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  // MediaModule: approval rows in the Inbox render faces, and the photo lives
  // in users.avatar_key — it needs signing before it reaches the client.
  // ApprovalsModule (Round L): the routed approval queue predicate.
  imports: [MediaModule, ApprovalsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
