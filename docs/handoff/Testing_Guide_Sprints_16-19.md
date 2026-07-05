# PRD v4 — Testing Guide: Sprints 16–19

**Code under test:** `main` @ `acdf8b6` · Sprints 16 (Trust & legal + R2), 17 (Avatars & logos), 18 (Presence & status), 19 (Internal analytics).
**Not included:** Sprint 20+ (Feedback/NPS is parked on branch `wip/sprint-20-feedback-nps`, unreviewed).

---

## 0. One-time setup before testing

### 0.1 Apply the new migrations (`0022–0025`)
Your database needs four new migrations. Same one-command sync as previous sprints:
```bash
pnpm sync:supabase       # applies 0001→0025 idempotently to Supabase
```
(For a local Postgres: `bash scripts/setup-database.sh`.)

### 0.2 Environment variables (API)
| Variable | Needed for | Without it |
|---|---|---|
| Object storage (see 0.2.1 — **Supabase Storage works, no Cloudflare needed**) | **Avatar/logo uploads + data exports** (Sprints 16/17) | Uploads & exports return a clear 503 "storage not configured"; everything else works |
| `RESEND_API_KEY` | Export-ready emails | Export builds but the link email is skipped (logged) |
| `JWT_SECRET` (existing) | Signs unsubscribe tokens + consent ip-hash salt | — |

> ⚠ If your `apps/api/.env` still carries the OLD placeholder values
> (`R2_ACCOUNT_ID=placeholder-account` …), **blank them** — a non-empty
> account id makes the app think storage is live and uploads fail with
> confusing network errors instead of the clean 503.

### 0.2.1 Storage without Cloudflare — use your Supabase project (recommended)
The storage client speaks plain S3, and `R2_ENDPOINT` points it at any
S3-compatible backend. Your existing Supabase project ships one:

1. **Supabase Dashboard → Storage → New bucket** → name `flicks-suite-uploads`, **Private**.
2. **Storage → Settings (S3 Connection)** → note the **Endpoint** + **Region**, then **New access key** → copy the key id + secret.
3. In `apps/api/.env`:
```bash
R2_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
R2_REGION=<region shown, e.g. ap-south-1>
R2_ACCESS_KEY_ID=<S3 access key id>
R2_SECRET_ACCESS_KEY=<S3 secret access key>
R2_BUCKET_NAME=flicks-suite-uploads
# R2_ACCOUNT_ID stays blank — not needed with a custom endpoint
```
4. Restart the API. Avatar/logo uploads, data exports and signed download
   links now run against Supabase Storage — behavior identical to R2.

Alternatives: **Cloudflare R2** free tier (needs a card on file; set
`R2_ACCOUNT_ID` + keys, leave `R2_ENDPOINT` blank) or **local MinIO**
(`docker run -p 9000:9000 minio/minio server /data`, then
`R2_ENDPOINT=http://127.0.0.1:9000`, keys `minioadmin`/`minioadmin`).

### 0.3 Restart both apps
```bash
pnpm -F api dev     # API on :4000
pnpm -F web dev     # Web on :3000
```

### 0.4 Automated gate (fastest smoke)
```bash
# from repo root, with apps/api/.env pointing at a migrated DB
pnpm -F api test          # expect 199/199 across 14 suites
pnpm -F api typecheck && pnpm -F web typecheck
bash scripts/diagnose-rls.sh   # expect leak_with_bogus_context = 0
```

---

## 1. Sprint 16 — Trust & legal (consent, clickwrap, /terms, exports)

### 1.1 Signup clickwrap (D16) — §3.7 "no signup without ToS"
1. Open `/onboarding` in a **fresh incognito window** with a **new email**.
2. ✅ The Terms/Privacy checkbox is **unticked** and **Send OTP is disabled** with the caption "Accept the Terms & Privacy Policy to continue". Links open the real `/terms` and `/privacy`.
3. Tick only the required box (leave marketing unticked) → OTP → verify → workspace step.
4. Verify the ledger (SQL, service role):
```sql
SELECT consent_type, granted, policy_version, source, region_code,
       ip_hash IS NOT NULL AS has_ip_hash
FROM consent_records ORDER BY occurred_at DESC LIMIT 5;
```
✅ Expect a `terms_privacy · true · tos-2026-07-01 · signup` row + a `marketing_email · false` row. `ip_hash` is a hash, never your IP.
5. **Negative test** (API-level): `POST /api/v1/auth/verify-otp` with a fresh email + valid OTP but **no consents** → `400 "Please accept the Terms…"`, and no user row is created.

### 1.2 Re-acceptance interstitial (§3.2)
1. Sign in as a user who existed **before** this sprint (no ledger row).
2. ✅ A one-time modal "We've updated our Terms & Privacy Policy" blocks the workspace; Continue stays disabled until the box is ticked.
3. Accept → it never appears again (new `terms_privacy` row at the current version).

### 1.3 Geo consent banner (D1/D2)
1. Fresh incognito → open the app (any page).
2. ✅ Bottom bar appears with the **India** variant ("I consent / Manage choices") — local dev always resolves region `IN` (the Vercel geo header only exists in production; to see EU/US variants locally, temporarily edit `apps/web/app/api/geo/route.ts` to return `'DE'` or `'US'`).
3. Choose → a `fs_consent` cookie is set → reload → **no re-prompt**.
4. "Manage choices" opens the preferences modal (Essential locked; Analytics + Marketing toggles).
5. Not shown on `/inv/<token>` public invoice pages or print views.

### 1.4 Settings → Privacy & data (D3)
1. `/settings/privacy` (new rail entry "Privacy & data").
2. Toggle Product analytics / Marketing emails → Save → reload → ✅ persisted (new ledger rows — withdrawal is a new row, check SQL above shows 2+ rows per type, never edits).
3. **Download my data** → ✅ "Requested" pill + green note; email arrives with a ZIP link that **expires in 7 days** (needs R2+Resend). Second click within 24h → friendly "one export per day" error.

### 1.5 Org export + legal pages (D17/D4)
1. `/settings/organization` → bottom "Data & legal" card → **Export data** (as Owner/Admin) → ✅ CSV+JSON ZIP link emailed to owners & admins.
2. `/terms` renders Appendix A (16 sections, version `tos-2026-07-01`); `/privacy` shows the new 12-section policy + **sub-processor table** (`/privacy#sub-processors`).

### 1.6 Trial = 7 days
Create a fresh workspace, then:
```sql
SELECT name, status, trial_ends_at, created_at FROM tenants ORDER BY created_at DESC LIMIT 1;
```
✅ `trial_ends_at − created_at ≈ 7 days` (signup copy also says "Free for 7 days").

---

## 2. Sprint 17 — Profile pictures & company logos

### 2.1 Avatar upload (D5/D6) — needs R2
1. `/profile` → "Profile photo" card → **Change photo** → pick a JPG/PNG → ✅ circular crop with zoom/drag → Save → success state.
2. ✅ The avatar updates in the topbar chip, the profile card, and the employees directory (may need a refresh).
3. **Remove** → back to initials on your personal color.
4. **Rejection tests** — try each; expect the exact friendly error:
   - an `.svg` file → "That file type isn't supported… SVG files are not accepted."
   - an image < 128px → "Image is too small…"
   - a file renamed from `.txt` to `.png` → rejected (server judges magic bytes, not the name).
5. Replace the photo twice, then check R2 → ✅ only ONE pair of objects under `users/<your-id>/avatar/` (old ones deleted).

### 2.2 Company logo (D7) — Owner/Admin, needs R2
1. `/settings/organization` → top card → **Change logo** → upload a transparent PNG.
2. ✅ Renders circular in the org header and the company switcher (sidebar).
3. Open a hosted invoice link (`/inv/<token>`) → ✅ the SAME uploaded logo shows on the invoice — **layout unchanged** (one upload feeds both).

---

## 3. Sprint 18 — Presence & status

> Best tested with **two browsers** (or one normal + one incognito) signed in as two different members of the same workspace.

### 3.1 Status picker (D8)
1. Browser A: topbar avatar → menu shows your presence header → **Set a status…**
2. Pick **Busy**, message "Sprint planning till 3", Clear after **30 minutes** → ✅ dot turns red on your chip; the menu header shows "Busy · Sprint planning till 3".
3. ✅ Browser B (other user, `/employees` open): your dot flips red **within ~5s without a reload**; hover shows "Busy · Sprint planning till 3".
4. Set Clear after to **30 minutes** and wait (or set a 1-minute expiry via API) → ✅ auto-reverts to the auto state live.
5. **Reset status** → back to Available (green) while you're active.

### 3.2 Auto states
- **In office:** clock in (attendance) → dot green, tooltip "In office".
- **Available · Remote:** approve a WFH regularization for today, then clock in → green dot, "Available · Remote".
- **Out of office:** approve TODAY's leave for user B → ✅ B's dot turns purple org-wide ≤5s; if B is still online it shows the green-dot-with-purple-ring "Available · Out of office".
- **Away/Offline:** leave a session idle >10 min → yellow "Away"; close the tab entirely → gray hollow "Offline" (≤30 min).

### 3.3 DND behavior
1. Set status **Do not disturb** (red dash dot).
2. Do something that normally toasts (e.g. save Settings) → ✅ **no toast**.
3. Trigger an error (e.g. submit an invalid form) → ✅ error toasts still appear (destructive bypasses DND).
4. ✅ The notification bell still accrues items while in DND.

### 3.4 Write-own security (API)
`PUT /api/v1/me/status` only ever writes YOUR row — verified by the RLS suite (`member_status: tenant-wide read, write-own only`), and there is no endpoint that accepts another user's id.

---

## 4. Sprint 19 — Internal product analytics

### 4.1 Consent-gated client capture
1. With analytics consent **ON** (banner "I consent" or Settings toggle): navigate Dashboard → Invoicing → Reports, then:
```sql
SELECT event_name, properties, source, occurred_at
FROM product_events WHERE event_name = 'module_opened'
ORDER BY occurred_at DESC LIMIT 10;
```
✅ Rows with `{"module":"dashboard"|"invoicing"|"reports"}`, `source='web'`.
2. Withdraw analytics consent (Settings → Privacy & data) and hard-refresh → navigate again → ✅ **no new rows**; `POST /api/v1/events` now returns **403**.

### 4.2 Server funnel events (never gated)
Create + send an invoice, then record a payment. Check:
```sql
SELECT event_name, properties FROM product_events
WHERE event_name IN ('invoice_created','invoice_sent','payment_received')
ORDER BY occurred_at DESC LIMIT 6;
```
✅ Rows exist even for consent-decliners; the FIRST of each per tenant carries `"first": true`.

### 4.3 PII check (§6 acceptance)
```sql
SELECT COUNT(*) FROM product_events WHERE properties::text LIKE '%@%';
```
✅ `0` — properties are ids/enums/numbers only.

### 4.4 FAM funnel (D13)
FAM console → **Signup funnel** → ✅ a second block **"Invoicing activation"** (mono labels `signed_up → org_configured → first_invoice_created → first_invoice_sent → first_payment_received`) below the untouched signup funnel.

---

## 5. Known scope notes (by design, not bugs)
- **Uploads/exports need R2 configured** — without it they 503 with a clear message.
- **Geo variants**: local dev always shows the India banner (region header exists only behind Vercel).
- **Unsubscribe link**: rails are live (`GET /unsubscribe?token=` + List-Unsubscribe support) but no marketing email is sent yet, so there's no real link to click until a campaign exists.
- **Approvals-inbox rows** don't show presence dots yet (the overview payload has no user ids) — directory/team/org-chart do.
- **Presence uses in-memory liveness** (single API instance): an API restart briefly shows everyone Offline until heartbeats resume (~1 min).

## 6. Where things live (if something looks off)
- Consent: `apps/api/src/modules/consent/**`, banner/components `apps/web/components/consent/**`
- Media: `apps/api/src/modules/media/**`, `apps/web/components/media/**`
- Presence: `apps/api/src/modules/presence/**`, gateway `apps/api/src/gateways/presence.gateway.ts`, web `apps/web/lib/presence/**`
- Analytics: `apps/api/src/core/analytics/**`, `apps/api/src/modules/events/**`
- Migrations: `packages/db/drizzle/0022–0025_*.sql`
