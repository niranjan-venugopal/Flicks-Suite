import 'dotenv/config';
// Sentry init MUST run before any other module is imported so its
// auto-instrumentation can patch them. No-op when SENTRY_DSN is unset.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './core/common/filters/http-exception.filter';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // rawBody: true preserves the unparsed request buffer on req.rawBody (while
  // still JSON-parsing for normal routes) so the Razorpay webhook can verify the
  // HMAC over the exact bytes Razorpay signed — re-serialized JSON would not match.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);
  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const isProd = nodeEnv === 'production';

  // Fail fast on dangerous CORS in production: a wildcard with credentials
  // would let any site make authenticated cross-origin calls.
  if (isProd) {
    if (corsOrigins.some((o) => o.includes('*'))) {
      throw new Error('CORS_ORIGINS must not contain a wildcard in production');
    }
    const bad = corsOrigins.filter((o) => !/^https?:\/\/.+/i.test(o));
    if (bad.length) {
      throw new Error(`CORS_ORIGINS has invalid origin(s): ${bad.join(', ')}`);
    }
    // Nudge operators toward a strong signing key (HMAC-SHA256 wants 256 bits).
    const jwtSecret = configService.get<string>('JWT_SECRET') ?? '';
    if (jwtSecret.length < 48) {
      logger.warn(
        'JWT_SECRET is shorter than 48 chars — rotate to a stronger key: `openssl rand -base64 48`',
      );
    }
  }

  // Security headers. The API serves only JSON + Swagger UI (no app HTML), so
  // the prod CSP allows inline script/style (Swagger needs it) while locking
  // down object/base/frame. The real app CSP lives in apps/web/next.config.ts.
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
    }),
  );

  // CORS
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
  });

  // Cookie parser
  app.use(cookieParser());

  // Global prefix — /healthz and /readyz stay at the root so monitor/probe URLs
  // are clean (e.g. https://api.flickssuite.com/healthz). The public API
  // (PRD v5 §11) carries its own '/api/public/v1' path on its controllers, so
  // it is excluded here rather than double-prefixed.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
      { path: 'api/public/{*splat}', method: RequestMethod.ALL },
    ],
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global guards (ThrottlerGuard → JwtAuthGuard → RolesGuard) are registered
  // as APP_GUARD providers in AppModule so they participate in DI. Order there
  // matters: rate-limit, then authenticate (populate req.user), then enforce
  // @Roles. RolesGuard allows when a route has no @Roles metadata, and
  // JwtAuthGuard lets @Public routes through.

  // Swagger — dev-only by default; prod exposes it only with SWAGGER_ENABLED=1
  // (the docs enumerate every internal route, so they stay off the public
  // internet). The API routes themselves are unaffected either way.
  const swaggerEnabled =
    !isProd || configService.get<string>('SWAGGER_ENABLED') === '1';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Flicks Suite HRMS API')
      .setDescription(
        'Production-grade multi-tenant HRMS SaaS API for Indian startups',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      .addCookieAuth('access_token')
      .addTag('Auth', 'Authentication & session management')
      .addTag('Onboarding', 'Tenant onboarding flows')
      .addTag('Employees', 'Employee management')
      .addTag('Attendance', 'Attendance tracking & punch management')
      .addTag('Leave', 'Leave management')
      .addTag('Timesheet', 'Timesheet tracking')
      .addTag('Notifications', 'In-app notifications')
      .addTag('Settings', 'Tenant settings & configuration')
      .addTag('Audit', 'Audit log')
      .addTag('FAM', 'Fleet Administration & Monitoring (platform admins only)')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
      },
    });

    // Public API docs (PRD v5 §11) — customer-facing OpenAPI, scoped to the
    // public-api module only so internal app routes never leak into it.
    const { PublicApiModule } = await import('./modules/public-api/public-api.module');
    const publicConfig = new DocumentBuilder()
      .setTitle('Flicks Suite Public API')
      .setDescription(
        'Key-authenticated REST API. Authenticate with `Authorization: Bearer flk_live_…`. Rate limit: 120 requests/minute per key.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'api-key')
      .build();
    const publicDoc = SwaggerModule.createDocument(app, publicConfig, {
      include: [PublicApiModule],
    });
    SwaggerModule.setup('api/public/docs', app, publicDoc, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Shutdown hooks
  app.enableShutdownHooks();

  // Worker split (PRD v5 §2.5): WORKER_MODE=true runs the SAME app image as a
  // queue consumer — BullMQ processors + the outbox dispatcher activate (see
  // isWorkerMode() gates) and it listens on WORKER_PORT only for health
  // probes. The API process keeps the request path free of background work.
  const workerMode = process.env.WORKER_MODE === 'true';
  const listenPort = workerMode
    ? configService.get<number>('WORKER_PORT', 4001)
    : port;
  await app.listen(listenPort);
  logger.log(
    `${workerMode ? 'WORKER' : 'API'} process running on port ${listenPort} [${nodeEnv}]`,
  );
  if (!workerMode && swaggerEnabled)
    logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
