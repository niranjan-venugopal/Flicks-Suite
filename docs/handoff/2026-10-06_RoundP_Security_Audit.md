# Round P · Security audit — "no leaks, encrypted, nobody from another company can see it"

**Date:** 2026-10-06 · **Type:** security audit + fixes · **Migration:** none · **Ships on top of:** `release/round-p-r5` · **Status:** released 2026-10-06 (API 07:23 UTC, web 07:28 UTC); key hard stop follow-up in §7

Founder's ask: *"Check whether there are no leaks with the asset management. Everything should be encrypted and saved and another user cannot view it from another company. Everything should be secure."*

## 1. The answer in one paragraph

**No company can see or change another company's data** — assets, asset photos, policies, policy PDFs, projects, employees, grants. That was proven three ways: a live attack run (two fresh companies, every role of one attacking every route of the other — 200 requests, zero leaks, the victim's rows byte-identical afterwards), a direct database probe as the app's own login (row-level security returns nothing across companies and refuses cross-company writes), and two independent code reviews. **"Encrypted" is narrower than "everything":** PAN, passport and bank-account numbers, admin 2FA secrets and the Razorpay / webhook secrets are encrypted by the application; everything else (names, asset serials and prices, policy text…) is stored readable *inside* the protected database, which the hosting providers encrypt on disk. Files sit in a private bucket behind links that expire in 15 minutes. The audit found **no cross-company leak** and **nine weaknesses**, all fixed below; four larger items need a decision from you (§5).

## 2. How it was tested

| Check | What | Result |
|---|---|---|
| Live attack harness | Two new companies (A = victim with a photo-tagged asset, a PDF and a rich-text policy, a project with an image, canary text in every field). Every role of B (owner, HR admin, manager, employee, guest) tried 40 routes against A's ids: read, edit, upload, delete, assign, return, acknowledge, publish, remind, CSV, project icon/image, the offline-sync door, employee records, module grants. | **200 requests, 0 leaks**, A's assets / assignments / policies / acknowledgements / projects / employees / grants **byte-identical** after the run |
| Existence oracle | The same route with A's id and with a random id must answer identically. | identical for assets, policies, acknowledge, projects, by-employee, assign |
| Mass assignment | Smuggling `tenant_id`, `deleted_at`, `photo_key`, `file_key`, `logo_key`, status `assigned` in bodies (REST and sync door). | refused (400) or ignored; nothing lands in A |
| Database directly | As the RLS-bound app login: with B's context, without a context, with a bogus context — counts of A's rows in assets, asset_assignments, company_policies, policy_acknowledgements, pm_projects, employees; INSERT / UPDATE into A. | 0 rows every time; writes refused; the four new tables have RLS **enabled and forced** |
| Roles inside a company | Employee on admin routes, second employee acknowledging the first one's laptop, manager without the policies grant, manager granting themselves, guest seat. | all 403 / empty |
| One person in two companies | Switching company shows only that company's equipment and policies; acting on the other company's asset from the wrong company fails. | held |
| Signed links | Asset photo and policy PDF links are signed and expire in **15 minutes**; keys are company-prefixed with random UUIDs. Project images and avatars: 24-hour links (see §5). | held |
| Code review (isolation) | Every query of the asset, policy and project-icon code; guards; validation pipe; storage keys; email escaping; CSVs. | no cross-company path |
| Code review (encryption, storage, transport, browser) | Field encryption, R2, cookies, CSP/HSTS, CORS, logs, Sentry, exports, IndexedDB, localStorage. | see §3 and §5 |

Scripts: session scratchpad `audit/cross-tenant.mjs` (live attack; **85 checks** in the final run incl. §3 items 1 and 9) and `audit/logout-wipe.mjs` (browser).

## 3. What was found and fixed in this release

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | A **removed or demoted HR admin kept every admin page** (asset register + CSV export, employee records, settings…) for up to 15 minutes, because the role check read the role baked into the sign-in token. | major | The role check now reads the **live membership** on every request (the policies / projects / invoicing guards already did). Deactivated, expired, removed or demoted → refused on the very next click. |
| 2 | The **company data export** wrote people's names and other free text to CSV without the spreadsheet-formula protection; a member could plant a formula that runs when the Owner opens the file. | major | Every cell is neutralised (`= + - @` tab CR get a leading apostrophe; plain numbers keep their sign). |
| 3 | The **company data export carried live secrets** — Razorpay tokens, the webhook secret, customer mandate tokens, public invoice-link tokens — and the encrypted PAN / passport / bank columns, behind a 7-day emailed link. | major | Those columns are dropped from the export; storage paths too. Every export query now also carries an explicit company filter, and the **asset register is now included** (it was missing). |
| 4 | **Passport numbers were stored in plain text** inside HR edit requests (PAN and bank number were already encrypted there). | major | Encrypted like PAN; old requests still apply (the cipher reads legacy plain rows). |
| 5 | External **auditor seats could be granted company-policy management** with one click. | minor | Refused by the grant writers and by the access resolver (auditors and guests never get policies, whatever a grant row says). |
| 6 | **Employee-document links were permanent public URLs** with a made-up expiry (no documents exist yet, so nothing was exposed). | minor (latent) | Real 15-minute signed links; never the public bucket URL. |
| 7 | **Offline project data stayed in the browser after sign-out** — on a shared office PC the next person could read issue titles and names through the browser's developer tools. | minor | Sign-out deletes every offline Projects database in that browser (this seat and any stale one) before going to the login page. |
| 8 | The **offline-sync door echoed raw database errors** — re-using another company's project id answered `duplicate key … pm_projects_pkey`, confirming the id exists. | minor | Database errors answer "Already exists" / "Something went wrong"; the detail stays in the server log. |
| 9 | Smaller: `/assets/me` sent the purchase price to the employee; a project could store another company's deal id (nothing read it yet); two admin-only grant reads lacked the company filter; the web advertised its framework (`X-Powered-By`). | minor | Price stripped from the self-service view; deal ids checked inside the company's transaction; filters added; header removed. |

Plus a **loud startup error** in production when an encryption key is missing — since §7 a **hard stop**: the API refuses to start without the keys.

## 4. Tests

- `founder-roundP-security-audit.spec.ts` (new): live-seat role check (deactivated / demoted / expired / restored / promoted / foreign membership), export CSV cells and secret stripping, auditor / guest policy exclusion on every writer and the resolver, passport encryption through an HR edit request end to end, signed document links.
- `founder-roundP-r5-project-icons.spec.ts`: sync door answers a generic `E409` with no driver text (proven to fail before the fix); deal-id check on both doors.
- `assets.spec.ts`: `/assets/me` never carries the purchase price.

## 5. Needs your decision / action (not changed in code)

1. ~~**Check the encryption keys on Railway today.**~~ **Done 2026-10-06** — the founder confirmed all three are set (and the first boot of this release logged no warning); the warning is now a hard stop (§7). Background: if `EMPLOYEE_DATA_ENC_KEY` is missing, PAN / passport / bank numbers are stored *without* encryption, silently; if `TOTP_SECRET` is missing, platform-admin 2FA is off; `INVOICING_SECRET_ENC_KEY` protects the Razorpay tokens. Each should be at least 32 characters (`openssl rand -hex 32`). The audit release logged `SECURITY: encryption key(s) missing…` at boot if one was absent; since §7 the API refuses to start instead. **Do not change an existing key** — data already encrypted with it would become unreadable (key rotation needs a planned migration).
2. **Sign-in tokens are also returned in the JSON body** of sign-in / refresh responses (they are already in secure httpOnly cookies, which is what the web uses). A cross-site-scripting bug, if one ever existed, could copy them. Fixing it touches every sign-in path, so it should be its own release with its own test pass. Recommended next.
3. **Company export download link lasts 7 days** and is emailed to every owner and admin. Recommended: serve it through a signed-in download page with a 15-minute link. Also decide whether the export should include decrypted PAN / bank numbers for owners (today: neither, after this release).
4. **Project images and avatars use 24-hour signed links** (assets and policies use 15 minutes). Shortening them is safe but makes images re-load more often; low risk as is.

Lower-priority hardening noted for later: a dedicated salt for IP hashes (today the sign-in signing key is reused, and CRM form IP hashes are unsalted); `unsafe-eval` in the web CSP; PostHog receives the user's email; asset photos may stay in the browser cache for 24 hours; check in Cloudflare that the uploads bucket has no public domain or `r2.dev` access.

## 6. Gate and live verification

**Gate (all green):** API typecheck · nest build · **Jest 90 suites / 1 377 tests** (one cross-suite timing race in `platform-evolution`'s outbox count — 35 vs 33 events published by suites running in parallel; it passes alone 18/18 and the dispatcher code is untouched) · module boundaries (358 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0`.

**Live (production web build, real API + Postgres, S3-compatible mock):**

| Run | Result |
|---|---|
| Cross-company attack harness `audit/cross-tenant.mjs` (fixed code) | **93 pass / 0 fail**, 200 cross-company requests, 0 leaks, victim rows byte-identical; a deactivated HR admin is refused on the very next request in the same session (register, CSV, asset detail, create, employees), a demoted one too, restoring the seat restores access; the sync door answers `E409:Already exists` with no database text |
| Browser sign-out wipe `audit/logout-wipe.mjs` | **6 / 6**: the Projects engine's database and a planted stale one are both gone after "Sign out"; the page lands on /login |
| Regression: R4 asset harness | 51 / 51 |
| Regression: R1 go-live harness | 68 / 68 (one numbering check first failed on local test data — the R2 run had left the seed company's series in Continuous mode with no separator; after restoring the local setting it passes) |
| Web headers | `X-Powered-By` gone |

The first run of the attack harness (before the fixes) was also clean on isolation — 76 / 76 — and surfaced the raw database error on the sync door (§3 item 8); the code reviews surfaced the rest.

## 7. Follow-up (same day): encryption-key hard stop + paste-friendly PDF frame setting

- **API** (`apps/api/src/main.ts`, `core/config/encryption-keys.ts`): in production the API now **refuses to start** when `EMPLOYEE_DATA_ENC_KEY`, `TOTP_SECRET` or `INVOICING_SECRET_ENC_KEY` is missing or shorter than 32 characters (names logged, never values; `process.exit(1)` rather than a throw, because Sentry's unhandled-rejection listener would keep a non-listening process alive). The check is byte-for-byte the predicate the boot warning used when the keys were confirmed, so the running keys keep passing. Railway's `/healthz` health check means a deployment that refuses to start never takes traffic — the previous one keeps serving and the deploy shows as failed. **Never change a key that is already in use** (data encrypted with it becomes unreadable).
- **Web** (`apps/web/next.config.ts`): `NEXT_PUBLIC_FILES_FRAME_SRC` accepts a full URL — e.g. the API's `R2_ENDPOINT` pasted as-is, path or trailing slash included — and keeps only its origin; anything that is not a plain `https://host[:port]` after that (`;`, spaces, wildcards, other schemes) is still dropped. Signed PDF links are served from the `R2_ENDPOINT` host (path-style), so that is the right value. Unset → CSP unchanged.
- **Tests:** `encryption-keys.spec.ts` (6: the three names, 31/32 boundary, blank/missing, no trimming, names only). Full gate green: API typecheck · nest build · **Jest 91 suites / 1 383 tests** · boundaries (359 modules, 0 violations) · web typecheck · web build · RLS `leak_with_bogus_context = 0`.
- **Live:** the built API booted with `NODE_ENV=production` the way the Docker image runs it — all three keys blank → exit 1 naming all three; `TOTP_SECRET` at 31 characters → exit 1 naming only it; all three set → starts, `/healthz` 200. Web production build with `NEXT_PUBLIC_FILES_FRAME_SRC=https://<account>.r2.cloudflarestorage.com/<bucket>/` → `frame-src … https://<account>.r2.cloudflarestorage.com`; without it → `frame-src` identical to before. 14 parsing cases (paths, signed-URL query, ports, `;` injection, wildcard, `ftp:`/`javascript:`, bare host) behave as intended.
