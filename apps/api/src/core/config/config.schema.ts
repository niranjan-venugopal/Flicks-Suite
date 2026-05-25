import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // Server
  PORT: Joi.number().default(4000),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  // Database
  DATABASE_URL: Joi.string().required(),
  DATABASE_SERVICE_ROLE_URL: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRY: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRY: Joi.string().default('7d'),
  JWT_ISSUER: Joi.string().default('flicks-suite'),
  JWT_AUDIENCE: Joi.string().default('flicks-suite-api'),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),

  // Email
  RESEND_API_KEY: Joi.string().required(),
  EMAIL_FROM: Joi.string().email().default('noreply@flicks.app'),
  EMAIL_FROM_NAME: Joi.string().default('Flicks Suite'),

  // App URLs
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  API_URL: Joi.string().uri().default('http://localhost:4000'),
  MAGIC_LINK_BASE_URL: Joi.string()
    .uri()
    .default('http://localhost:3000/auth/magic'),

  // R2
  R2_ACCOUNT_ID: Joi.string().optional(),
  R2_ACCESS_KEY_ID: Joi.string().optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().optional(),
  R2_BUCKET_NAME: Joi.string().default('flicks-suite-uploads'),
  R2_PUBLIC_URL: Joi.string().uri().optional(),

  // Observability
  SENTRY_DSN: Joi.string().allow('').optional(),
  POSTHOG_KEY: Joi.string().allow('').optional(),
  POSTHOG_HOST: Joi.string().uri().default('https://app.posthog.com'),

  // Security
  OTP_EXPIRY_MINUTES: Joi.number().default(10),
  MAGIC_LINK_EXPIRY_MINUTES: Joi.number().default(30),
  MAX_OTP_ATTEMPTS: Joi.number().default(5),
  MAX_OTP_PER_HOUR: Joi.number().default(5),
  TRUSTED_DEVICE_EXPIRY_DAYS: Joi.number().default(30),
});
