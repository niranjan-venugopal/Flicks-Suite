import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // MediaModule: report rows render faces, and the photo lives in
  // users.avatar_key — it needs signing before it reaches the client.
  imports: [MediaModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
