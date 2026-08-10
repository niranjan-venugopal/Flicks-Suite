# ─────────────────────────────────────────────────────────────────────────────
# Flicks Suite API — production image (Railway deploys this file).
# Build context = REPO ROOT:  docker build -f apps/api/Dockerfile .
#
# Notes that keep this image honest:
# • pnpm node_modules are SYMLINK FORESTS into the root store — the runner must
#   copy the whole workspace shape (root node_modules + each package dir), not
#   just apps/api/node_modules, or every link dangles.
# • `nest build` emits a ROOTED dist (tsconfig paths map into ../../packages),
#   so the entry is dist/apps/api/src/main.js and compiled workspace packages
#   live at dist/packages/*. The @flicks/* specifiers in the compiled JS are
#   resolved at runtime by tsconfig-paths/register + tsconfig.runtime.json.
# • Puppeteer's bundled Chromium is glibc — it cannot run on Alpine/musl. We
#   skip the download entirely and use distro Chromium via
#   PUPPETEER_EXECUTABLE_PATH (invoice-pdf.service reads it). Fonts included
#   so invoices render ₹ and non-Latin glyphs.
#   If PDF rendering ever misbehaves from Chromium-version skew, the escape
#   hatch is a node:22-bookworm-slim runner + puppeteer's own Chrome.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS base
RUN corepack enable pnpm
# No stage needs puppeteer's ~170MB Chrome download — prod uses distro Chromium.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# ── deps: full install (dev deps included — needed to build) ────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter @flicks/api...

# ── prod-deps: production-only install for the runner ───────────────────────
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @flicks/api...

# ── builder ─────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
# Root package.json (packageManager pin — keeps corepack on OUR pnpm, not
# latest) + workspace file (so pnpm sees the real monorepo layout).
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
WORKDIR /app/apps/api
RUN pnpm build

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
# Distro Chromium + fonts for invoice PDFs (puppeteer's glibc build can't run
# on musl). font-noto covers ₹ / Devanagari; ttf-freefont the Latin base.
RUN apk add --no-cache \
      chromium nss freetype harfbuzz ca-certificates fontconfig \
      ttf-freefont font-noto font-noto-emoji
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    TS_NODE_PROJECT=/app/apps/api/tsconfig.runtime.json

# Whole workspace shape so pnpm's relative symlinks resolve.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/packages/db/package.json ./packages/db/package.json
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/tsconfig.runtime.json ./apps/api/tsconfig.runtime.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist

WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "-r", "tsconfig-paths/register", "dist/apps/api/src/main.js"]
