import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { configValidationSchema } from './core/config/config.schema';
import { DatabaseModule } from './core/database/database.module';
import { TenantMiddleware } from './core/tenant/tenant.middleware';
import { JwtStrategy } from './core/auth/strategies/jwt.strategy';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { LeaveModule } from './modules/leave/leave.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { TimesheetModule } from './modules/timesheet/timesheet.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { FamModule } from './modules/fam/fam.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AuditModule } from './modules/audit/audit.module';

// Gateways
import { NotificationsGateway } from './gateways/notifications.gateway';

// Jobs
import { DailySnapshotsJob } from './jobs/daily-snapshots.job';
import { LeaveAccrualJob } from './jobs/leave-accrual.job';
import { TrialExpiryJob } from './jobs/trial-expiry.job';

@Module({
  imports: [
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

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          { name: 'short', ttl: 1000, limit: 10 },
          { name: 'medium', ttl: 10000, limit: 50 },
          { name: 'long', ttl: 60000, limit: 200 },
        ],
        storage: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
        } as unknown as undefined,
      }),
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

    // Feature modules
    AuthModule,
    OnboardingModule,
    EmployeesModule,
    AttendanceModule,
    LeaveModule,
    CalendarModule,
    TimesheetModule,
    NotificationsModule,
    FamModule,
    SettingsModule,
    AuditModule,
  ],
  providers: [
    JwtStrategy,
    NotificationsGateway,
    DailySnapshotsJob,
    LeaveAccrualJob,
    TrialExpiryJob,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
