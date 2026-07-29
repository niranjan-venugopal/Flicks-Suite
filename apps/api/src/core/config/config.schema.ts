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

  // Redis. REDIS_URL wins when set (managed providers hand out a URL —
  // Railway/Upstash; rediss:// enables TLS via ioredis). Host/port/password
  // remain the local-dev path. Railway private networking is IPv6-only:
  // append ?family=0 so ioredis resolves *.railway.internal.
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).allow('').optional(),
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
  // Full URL INCLUDING the path — the mailer appends ?token=…. The web route
  // is /verify (apps/web/app/(auth)/verify); prod: https://app.<domain>/verify
  MAGIC_LINK_BASE_URL: Joi.string()
    .uri()
    .default('http://localhost:3000/verify'),

  // R2 (or any S3-compatible storage — PRD v4 §10 exit ramp). All allow('')
  // so a blank `R2_ACCOUNT_ID=` line (the documented "no storage" setup in
  // .env.example) validates — Joi's optional() alone only covers ABSENT keys.
  R2_ACCOUNT_ID: Joi.string().allow('').optional(),
  R2_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  R2_BUCKET_NAME: Joi.string().default('flicks-suite-uploads'),
  R2_PUBLIC_URL: Joi.string().uri().allow('').optional(),
  // Endpoint override for S3-compatible backends (Supabase Storage, MinIO).
  // When set, path-style addressing is used and R2_ACCOUNT_ID is not needed.
  R2_ENDPOINT: Joi.string().uri().allow('').optional(),
  R2_REGION: Joi.string().default('auto'),

  // FAM second factor (TOTP). Application-level key used to encrypt per-user
  // TOTP secrets at rest. Optional in dev — FAM TOTP enforcement no-ops when
  // unset so local FAM logins still work.
  TOTP_SECRET: Joi.string().allow('').optional(),

  // Chromium binary for invoice PDFs. Unset in dev (puppeteer's own cached
  // Chrome); the production image sets /usr/bin/chromium-browser.
  PUPPETEER_EXECUTABLE_PATH: Joi.string().allow('').optional(),

  // Swagger is OFF in production unless explicitly enabled.
  SWAGGER_ENABLED: Joi.string().valid('0', '1').optional(),

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

  // ─── Platform billing (PRD v4 §8B — Specflicks' OWN Razorpay merchant) ─────
  // Distinct from the partner-OAuth keys below: these charge tenants for
  // Flicks Suite seats. Blank in dev → billing endpoints 503 cleanly and the
  // trial/paywall logic still runs (it's date-driven, not Razorpay-driven).
  RAZORPAY_PLATFORM_KEY_ID: Joi.string().allow('').optional(),
  RAZORPAY_PLATFORM_KEY_SECRET: Joi.string().allow('').optional(),
  RAZORPAY_PLATFORM_WEBHOOK_SECRET: Joi.string().allow('').optional(),

  // ─── Invoicing (v3) external integrations ──────────────────────────────────
  // All optional and stubbed: the corresponding service no-ops safely when the
  // key is absent (mirrors the R2 placeholder pattern), so local dev + CI run
  // without live credentials. Per-tenant Razorpay keys live encrypted in
  // invoicing_settings; these are the platform-level fallbacks/feature flags.
  RAZORPAY_KEY_ID: Joi.string().allow('').optional(),
  RAZORPAY_KEY_SECRET: Joi.string().allow('').optional(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().allow('').optional(),
  // GitHub App (PRD v6 §12). Optional — fixture tests + CI never need live
  // credentials; live API calls (install verify, bot comments) no-op without
  // them. Private key is the PEM with literal \n escapes (single-line .env).
  GITHUB_APP_ID: Joi.string().allow('').optional(),
  GITHUB_APP_PRIVATE_KEY: Joi.string().allow('').optional(),
  GITHUB_WEBHOOK_SECRET: Joi.string().allow('').optional(),
  GITHUB_APP_SLUG: Joi.string().allow('').optional(),
  // Razorpay OAuth Connect (Sprint 15). Partner app credentials — sellers
  // connect their own Razorpay account; orders are created on the sub-merchant
  // with a Bearer access token. Optional → connect/order endpoints return a
  // clear 400 until the partner app is provisioned. The redirect URI must match
  // the one registered in the Razorpay partner dashboard.
  RAZORPAY_OAUTH_CLIENT_ID: Joi.string().allow('').optional(),
  RAZORPAY_OAUTH_CLIENT_SECRET: Joi.string().allow('').optional(),
  RAZORPAY_OAUTH_REDIRECT_URI: Joi.string().uri().allow('').optional(),
  // App-level key (AES-256-GCM) for encrypting per-tenant Razorpay OAuth tokens
  // at rest. Optional in dev — InvoicingCryptoService passes through plaintext
  // when unset (mirrors TOTP_SECRET), so local/CI run without it.
  INVOICING_SECRET_ENC_KEY: Joi.string().allow('').optional(),
  // FX rates (openexchangerates.org) for multi-currency snapshots.
  FX_RATE_SOURCE: Joi.string().default('openexchangerates'),
  OPENEXCHANGERATES_APP_ID: Joi.string().allow('').optional(),
  // R2 bucket for generated invoice/credit-note PDFs + GSTR-1 exports.
  R2_INVOICING_BUCKET: Joi.string().default('flicks-suite-invoicing'),
  // Tenant-branded public invoice base, e.g. https://{slug}.flickssuite.com.
  PUBLIC_INVOICE_BASE_URL: Joi.string().uri().default('http://localhost:3000'),

  // ─── PRD v5 (CRM + architecture evolution) ─────────────────────────────────
  // Worker split (§2.5): WORKER_MODE=true turns this image into the queue
  // consumer (outbox dispatcher + BullMQ processors) listening on WORKER_PORT.
  WORKER_MODE: Joi.string().valid('true', 'false').default('false'),
  WORKER_PORT: Joi.number().default(4001),
  // Per-purpose AES-256-GCM keys (§13). Optional in dev — AppCryptoService
  // passes through plaintext when unset (mirrors INVOICING_SECRET_ENC_KEY).
  WEBHOOK_SECRET_ENC_KEY: Joi.string().allow('').optional(),
  EMAIL_TOKEN_KEY: Joi.string().allow('').optional(),
});
