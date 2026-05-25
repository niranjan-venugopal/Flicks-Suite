import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

// Global so any feature service can inject AnalyticsService without
// re-importing the module. ConfigModule is already global.
@Global()
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
