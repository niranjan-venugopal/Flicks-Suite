# Round 10 handoff — onboarding UX: invisible options, full state names, India-only statutory fields, the stuck terms gate

**Date:** 2026-08-26 (same day as rounds 8–9) · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none (the `passport_number_encrypted` and `aadhaar_last4` columns already existed — they were just never written).
**Gate at handoff:** api typecheck ✓ · api build ✓ · **jest 574/574 (50 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → 0 leaks ✓ · live Chromium pass over every item (both an IN
and an AE workspace, wizard driven end-to-end) ✓

Read after `2026-08-26_Round9_Cleanup_Coupons_Handoff.md`. All four items came
from real onboarding testers (Chrome, Edge AND Firefox on a 14" Windows
machine — the cross-browser reproduction is what pinned item 1).

## 1. Dropdown options invisible until hover  *(tester item 1)*

**Diagnosis.** No stylesheet had an `option` rule. The app's white text color
inherits into every `<option>`, but the popup surface is OS-drawn — light on
Windows/Linux (`color-scheme: dark` styles UA chrome but cannot beat an author
color). White-on-white; the hovered row was readable only because the OS
paints its own highlight. macOS renders the popup dark, which is why earlier
rounds missed it.

**Fix (`apps/web/app/globals.css`).** One bare-element rule:
`option, optgroup { background-color: var(--bg-2); color: var(--text) }` plus
a faint disabled state. `--bg-2` on purpose — it is **opaque**; the `--surf-*`
tokens are translucent white and would still composite light on the OS popup.
Covers all 115 native selects, including the 10 invoicing ones that use inline
styles instead of `.input`. Verified live: computed option background is
`rgb(10, 10, 24)`, text white.

## 2. The 2-letter State field  *(tester item 2)*

The wizard's address State input was the only `maxLength={2}` in the app
(hence "TA"); the DB stores free display text. Now:

- **Wizard step 1**: India → a `<select className="input">` of all 36
  `INDIAN_STATES` full names (value = full name — `current_address.state` is
  display text, not a GST code). Non-India → free text `maxLength={40}`
  placeholder "State / Province / Emirate". PIN placeholder follows suit
  ("PIN" vs "Postal / ZIP").
- **EditDetailsDialog** (HR edit): same dropdown for India; a legacy
  free-typed value ("TA") stays selectable as an extra option so an untouched
  save round-trips identically. No migration — old 2-letter values simply
  show until re-edited.
- `INDIAN_STATES` (`packages/shared/src/constants`) finally has consumers —
  it was dead code since v1.
- GST/tax **code** fields elsewhere (org settings, locations, invoicing) are
  genuinely 2-letter codes and were left alone.

## 3. Location-aware statutory fields  *(tester item 3)*

**The honest answer on PF auto-fetch:** there is **no public EPFO API** — the
"auto-fetched if UAN provided" PF input was decorative (disabled, never
wired) and could never fetch anything. The UAN *is* the linking key: HR
completes PF setup on the employer portal and the PF number shows up on the
employee's payslip/EPFO passbook. The wizard now says exactly that under the
UAN field, and the fake input is deleted.

**Country resolution** (client): `employee.locationCountryCode ??
organization.countryCode ?? 'IN'`. The API's `getEmployee` select now
includes the assigned location's `country_code` (serves `/employees/me` for
the wizard and `/employees/:id` for the HR dialog); new
`useMyEmployeeRecord()` hook reads it.

**India** — unchanged fields, plus the wizard finally *persists* Aadhaar
last-4: the client truncates to the last 4 digits before sending (the full
number never leaves the browser), a new `aadhaarLast4` DTO field validates
`/^\d{4}$/`, and the writer sets `employees.aadhaar_last4` — the "masked
storage" help text is now true.

**Non-India** (verified live on an AE workspace):
- Identity step: PAN + Aadhaar hidden; **Passport / national ID number**
  instead → new optional `passportNumber` (`@MaxLength(20)`), encrypted with
  the existing `FieldCipher` exactly like PAN, written to the
  already-existing `passport_number_encrypted`. Surfaces only as
  `hasPassport`.
- Bank step: the whole Statutory card (UAN) hidden; `pfUan` never sent.
- Documents list swaps PAN/Aadhaar cards for passport/ID + bank proof; the
  review summary, step subtitles and consent copy follow the country.
- **EditDetailsDialog**: PAN/Aadhaar-last-4/UAN rows only for India; a
  Passport row for everyone (it's a universal document, write-only like
  PAN); passport + aadhaar rows added to the change-request summary.

**Known limitations (deliberate, this round was UAN/PF/PAN):** the bank
sub-step still assumes Indian banking (bank list + IFSC) — SWIFT/IBAN is its
own round; the Nationality default is still "Indian" and the phone
placeholders show +91 even on foreign workspaces.

## 4. The stuck terms checkbox  *(tester item 4 — the real bug)*

**Root cause.** `(app)/layout.tsx` mounts `ReacceptanceGate` (plain div,
z-990) and `TrustDevicePrompt` (Radix Dialog) together. An invited employee
with no consent-ledger row on an untrusted device — exactly the state right
after submitting for HR review — opened both at once. The Radix dialog sets
`document.body.style.pointerEvents = 'none'` and re-enables it only for
Radix layers; the gate painted **above** the washed-out dialog but inherited
`pointer-events: none`, so every click on the checkbox died before React saw
it. (This is also why the round-7 Playwright harness could never click it —
that was misread as a selector quirk at the time.)

**Fixes:**
1. `TrustDevicePrompt` now waits behind the terms gate: it renders nothing
   until the consents query resolves with `requires_reacceptance: false`
   (same query key as the gate — one network call). Accepting the terms
   invalidates that query, so the trust prompt appears next in sequence.
2. `ReacceptanceGate` root sets `pointerEvents: 'auto'` — no future
   body-level pointer-events kill can deaden it again. On failure it now
   keeps the gate up with a destructive toast instead of silently
   dismissing without a ledger row.
3. `ToastViewport` (z-2000, bottom-center) got the `pointer-events-none` it
   was missing — it was eating clicks in that strip (individual toasts keep
   `pointer-events-auto`).
4. The post-submit cache ping-pong is gone at the source: when a submit
   returns `allStepsComplete`, the mutation now *writes*
   `submittedForReview: true` into the onboarding-status cache instead of
   invalidating it, so the `(app)` layout can never read a stale `false`
   and bounce the user back into the wizard.

**Verified live, the exact broken sequence:** invited employee (no ledger
row) completes the wizard → submits → lands on `/dashboard` and stays →
terms gate appears with NO trust prompt underneath → **checkbox and
"Continue to workspace" clicked in the real UI** → ledger row written →
trust prompt appears → "Not now".

## Tests

`founder-round10.spec.ts` (6 specs, real Postgres): passport encrypts at rest
(`iv:tag:cipher` shape, never in the detail payload) and flips `hasPassport`;
`aadhaarLast4` persists; identity DTO accepts/rejects the right shapes;
`getEmployee` exposes `locationCountryCode`; `requiresReacceptance` true for
a ledger-less user → false after acceptance → true again on a version bump
(the missing assertions that let the dead gate ship). Existing nets
(`employee-details-admin`, `founder-round3`, `consent`) stay green — 574/574.

## Deploy checklist

1. No migration, no data op, no new env vars. Deploy API + web.
2. Confirm `EMPLOYEE_DATA_ENC_KEY` is set in production API env (it is per
   the go-live runbook) — without it FieldCipher is a plaintext passthrough
   (fine locally, never in prod).
3. Smoke: any dropdown on Windows shows dark, readable options; wizard
   Step 1 State is a full-name dropdown; Step 3 has no "PF account" box; a
   fresh invited employee can tick and submit the terms interstitial.

## Open follow-ups from this round

1. Bank sub-step country gating (SWIFT/IBAN vs IFSC) — next international
   round, together with the +91 placeholders and the Nationality default.
2. The web production build sends a CSP (`connect-src 'self' https: wss:`)
   that blocks a plain-HTTP API origin — irrelevant in production (API is
   HTTPS behind the same domain) but local harnesses must drive `next dev`.
3. `buildChangeSummary` lists every submitted field, including unchanged
   ones, in the employee-confirmation summary — harmless noise, worth an
   equality skip someday.
