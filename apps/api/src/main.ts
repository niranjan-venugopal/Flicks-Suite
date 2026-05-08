import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './core/common/filters/http-exception.filter';
import { JwtAuthGuard } from './core/auth/guards/jwt-auth.guard';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);
  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim());
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // Security headers
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy:
        nodeEnv === 'production'
          ? undefined
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

  // Global prefix
  app.setGlobalPrefix('api/v1');

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

  // Global guards
  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector));

  // Swagger
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

  // Shutdown hooks
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Application running on port ${port} [${nodeEnv}]`);
  logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
