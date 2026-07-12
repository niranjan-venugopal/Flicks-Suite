# CRM (PRD v5) — Day-1 External Actions · USER CHECKLIST

These are the actions ONLY YOU can do, and several are the **long poles** of the
whole beta timeline. Submit the two OAuth verifications **today** — they take
weeks and nothing in the code can accelerate them. Everything here is safe to
do while the CRM sprints are still building.

## 1. Google OAuth verification + CASA (the longest pole)
Phase B email sync (Gmail two-way) needs Google's restricted-scope verification
INCLUDING an annual CASA security assessment.
- [ ] Google Cloud Console → create/select the production project.
- [ ] OAuth consent screen → External → fill app details (name, domains,
      privacy policy URL — use https://app.flickssuite.com/privacy).
- [ ] Add scopes IN ONE APPLICATION (adding later forces re-verification):
      `gmail.readonly`, `gmail.send`, `gmail.modify` (restricted) **and**
      `calendar.events` + `calendar.readonly` (calendar sync ships v1.5 but the
      scopes must ride this same review).
- [ ] Submit for verification; start the CASA process when Google directs
      (tier/cost depends on current program rules — capture what they quote).
- [ ] Record the OAuth client id/secret → they become `GOOGLE_OAUTH_CLIENT_ID/SECRET`.

## 2. Microsoft publisher verification (lighter, still weeks)
- [ ] Microsoft Entra admin center → App registrations → new app.
- [ ] Add Graph scopes together: `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`,
      `Calendars.ReadWrite`, `offline_access`.
- [ ] Complete publisher verification (needs a Microsoft Partner Network ID).
- [ ] Record client id/secret → `MS_OAUTH_CLIENT_ID/SECRET`.

## 3. DNS — the locked domain map (PRD v5 §1)
At your DNS provider for flickssuite.com:
- [ ] `app.flickssuite.com`   → Vercel (product app)
- [ ] `admin.flickssuite.com` → Vercel (FAM console — already works via middleware)
- [ ] `api.flickssuite.com`   → Railway (API)
- [ ] `*.flickssuite.com`     → Vercel wildcard (tenant public pages /inv /q /sub /f)
- [ ] `mail.flickssuite.com`  → Resend SENDING domain: add the SPF/DKIM/DMARC
      records Resend shows when you add the domain.
- [ ] `in.flickssuite.com`    → Resend RECEIVING domain: **MX records → Resend
      Inbound** (no website here).

## 4. Resend dashboard
- [ ] Verify `mail.flickssuite.com` as a sending domain.
- [ ] Add `in.flickssuite.com` as a receiving (inbound) domain; enable
      catch-all delivery.
- [ ] Create/confirm the webhook endpoint pointing at
      `https://api.flickssuite.com/api/v1/webhooks/resend` and subscribe:
      `email.received`, `email.bounced`, `email.complained`, `email.delivered`
      (the endpoint ships in Sprint 29 — configuring early is harmless; note
      the signing secret → `RESEND_WEBHOOK_SECRET`).
- [ ] Check with Resend support whether received emails count against the
      plan's email quota (PRD §7.1 open question) — note the answer.

## 5. FX rates
- [ ] Create a free API key at openexchangerates.org →
      `OPENEXCHANGERATES_APP_ID` in the API env (needed from Sprint 26 for
      any-currency deals).

## 6. Railway — worker service (when Sprint 24 deploys)
- [ ] Duplicate the API service from the same image/repo; set `WORKER_MODE=true`
      (+ `WORKER_PORT=4001`); point its health check at `/readyz`.
- [ ] Set `WEBHOOK_SECRET_ENC_KEY` (openssl rand -hex 32) on BOTH services.

## 7. Carry-overs still open from v4 (launch gate)
- [ ] Razorpay Technology-Partner approval (+ ₹1 live smoke after).
- [ ] Sentry EU org + DSNs + staged-alert test.
- [ ] Object storage (R2/Supabase) + `RESEND_API_KEY` in prod.
- [ ] `APP_URL` / `PUBLIC_INVOICE_BASE_URL` → real domains in prod env.
- [ ] Legal counsel sign-off (ToS/Privacy).
- [ ] **Rotate the GitHub PAT used during development.**

Keep this file updated as items complete — it feeds the beta-launch gate.
