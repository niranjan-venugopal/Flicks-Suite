#!/usr/bin/env bash
# =============================================================================
# prod-smoke.sh — post-deploy smoke test (go-live runbook Phase 6)
# =============================================================================
# Read-only-ish checks against a LIVE production API. The only POST uses a
# guaranteed-unregistered email, which the sign-in gate rejects with 404
# NOT_REGISTERED before creating any rows or sending any email — so this is
# safe to run repeatedly (and dodges the per-email OTP quota).
#
# Usage:
#   API_URL=https://api.example.com APP_ORIGIN=https://app.example.com \
#     bash scripts/prod-smoke.sh
# =============================================================================
set -euo pipefail

API_URL="${API_URL:-}"
APP_ORIGIN="${APP_ORIGIN:-}"
if [[ -z "$API_URL" || -z "$APP_ORIGIN" ]]; then
  echo "Usage: API_URL=https://api.<domain> APP_ORIGIN=https://app.<domain> bash scripts/prod-smoke.sh" >&2
  exit 1
fi
API_URL="${API_URL%/}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1" >&2; }

echo "─── 1. /healthz (liveness — no DB dependency) ───"
HEALTH_CODE=$(curl -s -o /tmp/smoke-health.json -w '%{http_code}' "$API_URL/healthz" || echo 000)
HEALTH_BODY=$(cat /tmp/smoke-health.json 2>/dev/null || true)
if [[ "$HEALTH_CODE" == "200" ]]; then ok "healthz 200"; else bad "healthz returned $HEALTH_CODE"; fi
if grep -q '"status":"ok"' <<<"$HEALTH_BODY"; then ok "process alive"; else bad "unexpected healthz body: $HEALTH_BODY"; fi

echo "─── 2. /readyz ───"
READY_BODY=$(curl -sf "$API_URL/readyz" || true)
if grep -q '"status":"ready"' <<<"$READY_BODY"; then
  LAT=$(sed -n 's/.*"dbLatencyMs":\([0-9]*\).*/\1/p' <<<"$READY_BODY")
  ok "ready (dbLatencyMs=${LAT:-?})"
else
  bad "readyz not ready: $READY_BODY"
fi

echo "─── 3. Sign-in gate (API→DB round trip, zero side effects) ───"
BOGUS="smoke-$(date +%s)@prod-smoke.invalid"
OTP_CODE=$(curl -s -o /tmp/smoke-otp.json -w '%{http_code}' \
  -X POST "$API_URL/api/v1/auth/request-otp" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$BOGUS\",\"intent\":\"signin\"}" || echo 000)
if [[ "$OTP_CODE" == "404" ]] && grep -q 'NOT_REGISTERED' /tmp/smoke-otp.json; then
  ok "unregistered email → 404 NOT_REGISTERED"
else
  bad "expected 404 NOT_REGISTERED, got $OTP_CODE: $(cat /tmp/smoke-otp.json 2>/dev/null)"
fi

echo "─── 4. CORS preflight from $APP_ORIGIN ───"
CORS_HEADERS=$(curl -s -D - -o /dev/null -X OPTIONS "$API_URL/api/v1/auth/request-otp" \
  -H "Origin: $APP_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type')
if grep -qi "access-control-allow-origin: *$APP_ORIGIN" <<<"$CORS_HEADERS"; then
  ok "allow-origin echoes $APP_ORIGIN"
else
  bad "allow-origin missing/mismatched — is CORS_ORIGINS set to $APP_ORIGIN?"
fi
if grep -qi 'access-control-allow-credentials: *true' <<<"$CORS_HEADERS"; then
  ok "allow-credentials true"
else
  bad "allow-credentials missing (cookie auth would break)"
fi

echo "─── 5. Swagger gated in production ───"
DOCS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/docs" || echo 000)
if [[ "$DOCS_CODE" == "404" ]]; then
  ok "/api/docs → 404 (gated)"
else
  bad "/api/docs returned $DOCS_CODE — expected 404 (is SWAGGER_ENABLED set?)"
fi

echo
if [[ $FAIL -eq 0 ]]; then
  echo "✅ Smoke passed ($PASS checks). Continue with the manual Phase 6 items:"
  echo "   real login on prod domains · invoice PDF ₹ glyph · pm-beta-gate drills."
else
  echo "❌ $FAIL check(s) failed ($PASS passed) — fix before continuing." >&2
  exit 1
fi
