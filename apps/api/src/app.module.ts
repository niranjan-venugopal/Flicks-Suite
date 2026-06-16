import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { configValidationSchema } from './core/config/config.schema';
import { DatabaseModule } from './core/database/database.module';
import { AnalyticsModule } from './core/analytics/analytics.module';
import { HealthController } from './health.controller';
import { TenantMiddleware } from './core/tenant/tenant.middleware';
import { JwtStrategy } from './core/auth/strategies/jwt.strategy';
import { JwtAuthGuard } from './core/auth/guards/jwt-auth.guard';
import { RolesGuard } from './core/auth/guards/roles.guard';
import { RequestIdInterceptor } from './core/common/interceptors/request-id.interceptor';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { LeaveModule } from './modules/leave/leave.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { TimesheetModule } from './modules/timesheet/timesheet.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { FamModule } from './modules/fam/fam.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AuditModule } from './modules/audit/audit.module';
import { InvoicingModule } from './modules/invoicing/invoicing.module';
import { OrgFinancialModule } from './modules/org-financial/org-financial.module';
import { MembersModule } from './modules/members/members.module';

// Gateways
import { NotificationsGateway } from './gateways/notifications.gateway';

// Jobs
import { DailySnapshotsJob } from './jobs/daily-snapshots.job';
import { LeaveAccrualJob } from './jobs/leave-accrual.job';
import { TrialExpiryJob } from './jobs/trial-expiry.job';
import { InvoicingJobs } from './jobs/invoicing.jobs';

@Module({
  imports: [
    // Sentry root — wires the NestJS error/perf instrumentation. The SDK
    // itself is initialised in instrument.ts (imported first in main.ts).
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // JWT globally so guards can use it
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          // The jsonwebtoken types narrow expiresIn to a templated string literal;
          // config-driven values are validated at startup so casting is safe.
          expiresIn: config.get<string>(
            'JWT_ACCESS_EXPIRY',
            '15m',
          ) as unknown as number,
          issuer: config.get<string>('JWT_ISSUER', 'flicks-suite'),
          audience: config.get<string>('JWT_AUDIENCE', 'flicks-suite-api'),
        },
      }),
    }),

    PassportModule.register({ defaultStrategy: 'jwt' }),

    // In-memory throttling (single-instance beta). The previous Redis `storage`
    // object was cast to `undefined` and silently ignored — and, more
    // importantly, no ThrottlerGuard was ever registered, so every @Throttle
    // was inert. The guard is now wired as an APP_GUARD below.
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'short', ttl: 1000, limit: 10 },
        { name: 'medium', ttl: 10000, limit: 50 },
        { name: 'long', ttl: 60000, limit: 200 },
      ],
    }),

    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: () => crypto.randomUUID(),
      },
    }),

    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: false,
    }),

    ScheduleModule.forRoot(),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
        },
      }),
    }),

    DatabaseModule,
    AnalyticsModule,

    // Feature modules
    AuthModule,
    OnboardingModule,
    EmployeesModule,
    AttendanceModule,
    LeaveModule,
    CalendarModule,
    DashboardModule,
    TimesheetModule,
    NotificationsModule,
    FamModule,
    SettingsModule,
    ReportsModule,
    AuditModule,
    InvoicingModule,
    OrgFinancialModule,
    MembersModule,
  ],
  controllers: [HealthController],
  providers: [
    // Capture unhandled exceptions into Sentry, then let the existing
    // HttpExceptionFilter (registered in main.ts) format the response.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    // Global guards (execute in registration order): rate-limit first, then
    // authenticate (JWT → req.user), then enforce @Roles. Registered here as
    // APP_GUARD (rather than main.ts useGlobalGuards) so they participate in DI
    // — ThrottlerGuard needs the throttler storage/options, and the auth guards
    // gain DI for audit logging of denials.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Echo the ClsModule request id back as X-Request-ID for log correlation.
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    JwtStrategy,
    NotificationsGateway,
    DailySnapshotsJob,
    LeaveAccrualJob,
    TrialExpiryJob,
    InvoicingJobs,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
