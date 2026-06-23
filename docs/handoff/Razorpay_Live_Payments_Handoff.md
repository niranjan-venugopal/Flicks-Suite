# Razorpay Live Payments — Go-Live Handoff

**Status:** Code-complete, tested, and merged (Sprint 15, commits `9c0f5c5` + `f8610f7`).
**Blocked on:** Razorpay **Technology-Partner** approval (external, non-code).
**Scope:** One-off invoice payments via **OAuth Connect**. Subscription auto-debit
mandate is a separate, deferred effort.

When this is enabled, a customer on the hosted invoice page clicks **Pay with
Razorpay** → Razorpay Checkout → the `payment.captured` webhook records the payment
automatically against the invoice. Until enabled, the button stays disabled and UPI +
manual payments work normally — nothing is broken.

---

## 1. What's already built (no further coding expected)

| Piece | Location |
|-------|----------|
| OAuth connect / callback / disconnect | `apps/api/src/modules/invoicing/inv-settings.controller.ts`, `razorpay-oauth.controller.ts`, `inv-settings.service.ts` |
| Razorpay REST client (token exchange/refresh/revoke, order create) | `apps/api/src/modules/invoicing/razorpay.service.ts` |
| Token encryption at rest (AES-256-GCM) | `apps/api/src/modules/invoicing/invoicing-crypto.service.ts` |
| Public order endpoint + order→invoice mapping | `public-invoice.service.ts` / `public-invoice.controller.ts`, table `razorpay_orders` |
| Hardened webhook (raw-body HMAC, account/order routing) | `razorpay-webhook.controller.ts` (+ `main.ts` `rawBody: true`) |
| Schema/migration | `packages/db/drizzle/0021_razorpay_oauth.sql` |
| Web: Connect/Disconnect + hosted Checkout | `apps/web/app/(app)/invoicing/settings/page.tsx`, `apps/web/app/(public)/inv/[token]/page.tsx` |

Automated tests mock the OAuth token exchange and exercise the **real raw-body HMAC**
verification, payment recording via the order mapping, and `razorpay_orders` tenant
isolation.

---

## 2. The external blocker — partner program

The integration needs the **Technology Partner** capability, which issues OAuth
applications (`client_id` / `client_secret`). A **Reseller / Affiliate** partner account
(refer-and-earn) does **not** expose OAuth app creation.

**Action:** Obtain Technology-Partner access (apply via Razorpay's "Become a Technology
Partner" flow, or contact `partners@razorpay.com` / dashboard Help & Support), then
create an OAuth application at **Dashboard → Partners → Applications → Create New
Application**. Razorpay issues a **development** and a **production** client, each with
its own `client_id` + `client_secret`.

---

## 3. Configure the OAuth application

When creating the application, set:

| Field | Value |
|-------|-------|
| Application Name | Flicks Suite |
| Website URL | your web app URL (e.g. `https://app.flickssuite.com`) |
| **Callback / Redirect URL** | `https://<API_DOMAIN>/api/v1/invoicing/razorpay/callback` |

This **must exactly match** `RAZORPAY_OAUTH_REDIRECT_URI`. The callback/webhook URLs
must be publicly reachable HTTPS — for local testing, front the API with a tunnel
(e.g. ngrok) and use that HTTPS URL.

---

## 4. Add the partner webhook

In the partner dashboard webhook settings:

| Field | Value |
|-------|-------|
| URL | `https://<API_DOMAIN>/api/v1/webhooks/razorpay` |
| Secret | a strong random string (reused as `RAZORPAY_WEBHOOK_SECRET`) |
| Events | at minimum `payment.captured` |

The webhook handler routes each event to its tenant via the `X-Razorpay-Account-Id`
header and to its invoice via the `razorpay_orders.order_id` mapping, then records the
payment only when the HMAC (over the raw body) verifies.

---

## 5. Environment variables

Set on the API (see `apps/api/.env.example`):

```bash
RAZORPAY_OAUTH_CLIENT_ID=<development client_id>      # production client when going live
RAZORPAY_OAUTH_CLIENT_SECRET=<development client_secret>
RAZORPAY_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/api/v1/invoicing/razorpay/callback
RAZORPAY_WEBHOOK_SECRET=<webhook secret from step 4>
INVOICING_SECRET_ENC_KEY=<openssl rand -hex 32>       # encrypts stored OAuth tokens
```

No rebuild or migration is required — `0021` is already applied.

---

## 6. Test in Test Mode

1. Toggle **Test Mode** in the Razorpay partner dashboard; use the **development** client.
2. In the app: **Invoicing → Settings → Payments → Connect with Razorpay** → authorize a
   test sub-merchant account. The Pill should flip to **Connected**.
3. Open a SENT invoice's hosted link → **Pay with Razorpay** → pay with a
   [Razorpay test card / UPI](https://razorpay.com/docs/payments/payments/test-card-details/).
4. Confirm the `payment.captured` webhook records the payment and the invoice moves to
   **PAID** (`razorpay_orders` row → `paid`).

---

## 7. One verification caveat before go-live

Two details were behind Razorpay's login-gated partner docs and should be confirmed
against the **live** dashboard/docs when credentials are available:

1. **Checkout `key`** — the public order endpoint returns the OAuth `public_token` as the
   client-side Checkout `key`. Verify this is the field Razorpay expects for OAuth-mode
   Checkout; adjust `public-invoice.service.ts` `createRazorpayOrder` if needed.
2. **Webhook payload shape** — confirm `payment.captured` carries `entity.order_id` (used
   for invoice mapping) and that `X-Razorpay-Account-Id` is sent on partner webhooks.

These are tweak-and-test items, not a rebuild.

---

## 8. Going live

1. Complete Razorpay KYC / app review for the **production** client.
2. Swap the env vars to the **production** `client_id` / `client_secret`.
3. Point the Redirect + Webhook URLs at the production API domain.
4. Re-run the Test-Mode flow once against production with a small real payment.
