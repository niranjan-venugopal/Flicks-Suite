import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsListener } from './analytics.listener';

// Global so any feature service can inject AnalyticsService without
// re-importing the module. ConfigModule is already global. The listener sinks
// `analytics.track` EventEmitter2 events (PRD v4 §6) so emit-sites need no DI.
@Global()
@Module({
  providers: [AnalyticsService, AnalyticsListener],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
