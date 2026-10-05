# Round P · R2 — Invoice numbering: Financial-year vs Continuous series, editor defaults, quote wording

**Date:** 2026-10-05 · **Type:** feature · **Migration:** 0066 (`docs/handoff/apply-0066.sql`) · **Status:** see §6

Founder's ask: *"They should be able to add the prefix or other numbers and separators as per their series or it can be added continuously. Like LB2400001 or they can add like how we have built it LB24/26-27/0017. It can be both, they can select."*

## 1. What the customer gets

Invoicing → Settings → Numbering, per document type (Invoices, Quotes, Credit notes, Debit notes):

- **Financial-year series** (today's behaviour): `PREFIX / FY / NNNN`, the counter restarts every April 1 (or the workspace's financial-year start). Example `LB24/26-27/0017`.
- **Continuous series**: `PREFIX NNNNN`, one running counter that never resets. Example `LB2400001` (prefix `LB24`, no separator, 5 digits).
- Prefix is free text, the separator can be **none**, `/` or `-`, digits 1–8, starting number ≥ 1. The live preview shows exactly what the next number will be. The GST rule (16 characters max, letters, digits, `/` and `-`) is enforced before saving, and a non-blocking note warns when the series would outgrow 16 characters within the next 9,999 (FY) / 99,999 (continuous) numbers.
- Switching modes is safe: the other series keeps its own counter, and the save tells you where the series resumes ("Continuous series resumes at N (not at your starting number)"). A deleted or cancelled draft still consumes its number (unchanged, GST requires consecutive series).
- The dead "Auto-reset on April 1" toggle and the gap-detection sentence are gone (neither did anything).

Also in this release:
- **Editor defaults finally apply.** A new invoice's due date is the invoice date + the "default payment terms" days from Settings (was hard-coded 30); a new line's GST rate uses the item's rate, else the Settings default (was hard-coded 18 %); default notes / terms prefill a new document. Editing an existing document never overwrites what was saved.
- **Quotes read as quotes.** The preview/PDF title says **QUOTE**, and the "sent" email for a quote says "Quote <number> from <company>", "valid until <date>", with a "View quote" button — no "due" or "payment" wording. Invoice emails are byte-for-byte unchanged.

## 2. How it works

- `invoice_sequences.series_mode` (`'fiscal_year'` default · `'continuous'`). The **current-FY row** holds the configuration (prefix, separator, padding, starting number, mode) and FY rollover copies it forward, so a continuous series survives April 1 with no special case. The continuous counter lives in one sentinel row per document type: `fy_label = 'ALL'`, `fy_end_date = 9999-12-31`. The existing unique index guarantees a single such row.
- `reserveNext()` (first number of a FY already advisory-locked since R1) locks and increments the ALL row in continuous mode and prints with that row's prefix/separator/padding; `invoices.fy_label` still records the document's own financial year, so GSTR-1 period grouping is unchanged in either mode.
- A mode switch applies to **every** FY row of that document type (past rows take the mode only — an old series is never renumbered; future-dated rows take the whole configuration), so a back-dated document follows the chosen mode too.
- A configuration whose next number already exists (invoices, credit or debit notes) is refused on save: "The next number X is already used".
- Validation lives in `numbering.util.ts` (`SEPARATORS`, `FY_FORMATS`, `SERIES_HORIZON`, `validateNumberFormat` with `warnings[]`) and the web preview mirrors it exactly, including the horizon rule.

## 3. API

| Endpoint | Change |
|---|---|
| `GET /invoice-sequences` | rows add `series_mode`, `continuous_current_number` (ALL counter when continuous, else null); `next_number_preview` honours the mode |
| `PUT /invoice-sequences` | body adds `series_mode`; `separator` ∈ `''`, `/`, `-`; `fy_format` ∈ the four tokens; `zero_padding` 1–8; `starting_number` ≥ 1; `warning` may concatenate the mid-FY GST note, the "resumes at N" note and the horizon note; 400 when the next number is already used |
| `POST /invoice-sequences/preview` | accepts `series_mode`; returns `warnings[]` |
| `invoice-sent` email | new params `documentType`, `validUntil`; `send()` passes them |

## 4. Founder action — release order

1. Run **`docs/handoff/apply-0066.sql`** in the Supabase SQL editor (service role; idempotent, safe to re-run).
2. Push `production` (API), then `main` (web). The web tolerates an older API (a missing `series_mode` reads as financial-year), but the API needs the column before it deploys.

## 5. Tests

- `founder-roundP-r2-numbering.spec.ts` (18+ cases: continuous across 31 Mar → 1 Apr with no reset while `fy_label` differs; switching both ways resumes the right counter with the right warning; 8 parallel reserves on the ALL row; QUOTE stays FY while INVOICE is continuous; list/preview shapes; DTO rules through a real ValidationPipe; rollover inherits the mode; back-dated documents follow the chosen mode; "next number already used" refusal), `numbering.util.spec.ts` (empty separator, no FY token, `LB2400001`, 16-char boundary, horizon), `founder-roundP-r2-quote-email.spec.ts` (12: quote variant content, invoice variant golden-identical, `send()` end to end).

## 6. Gate and live verification

**Build process.** Three implementers (API numbering + migration · web numbering tab, editor defaults, quote title · API quote email), three adversarial review lenses each, one fix pass each: 14 agents. The reviews caught two things worth recording: the series mode was first honoured per FY row (a back-dated document could still take the old series) — now a mode switch propagates to every FY row and continuous numbers print with the counter row's own configuration; and the tab's compliance banner keyed on the wrong counter when switching series — now it keys on the series that was in use, and the real continuous counter is fetched through `/preview` before a switch.

**Gate (all green):** API typecheck · nest build · **Jest 84 suites / 1 256 tests, all passing** · module boundaries (345 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0`. Migration 0066 applied locally twice (second run a no-op) and once through `apply-0066.sql`.

**Live verification** (`scratchpad/verify-roundP-r2.mjs`, production web build, real API and database): **29 pass / 0 fail / 0 skip** across 4 scenarios.

| # | Scenario | Result |
|---|---|---|
| 1 | Switch Invoices to Continuous (`LB24`, no separator, 5 digits) → list shows the mode and counter, preview `LB2400001`; two drafts `LB2400001`, `LB2400002` with their own `fy_label`; a draft dated in the **next** financial year continues at `LB2400003` with the next FY label; exactly one `ALL` counter row; a quote stays `QT/26-27/000N`; switching back warns "Financial-year series resumes at LB24/26-27/000N" and the next draft takes that; switching to continuous again warns "resumes at LB2400004" and the next draft is `LB2400004`; separator `.` and pad 9 are rejected | pass |
| 2 | Numbering tab: both mode cards, "None" separator, no Auto-reset card, no gap-detection copy, the deleted-drafts note, live preview updates when the mode is switched | pass |
| 3 | Settings default payment terms 15 / GST 5 % / notes → a new invoice opens with due date +15, a 5 % line and the notes prefilled | pass |
| 4 | A quote's preview is titled **QUOTE**, never INVOICE; sending it succeeds | pass |

Screenshots in the session scratchpad: `rp2-numbering-continuous`, `rp2-numbering-fy`, `rp2-editor-defaults`, `rp2-quote-preview`.

Harness note: the seed tenant's Invoices series is left in continuous mode (`LB24…`) after the run; the quote email variant is pinned by its spec (no email provider locally).

## 7. Follow-ups
- `reserveNext` does not hard-stop a 17-character number when a padded FY series is exhausted (the horizon warning is the guard); a hard stop needs a product decision on what to do instead.
- The `invoice-sent` template does not HTML-escape names/numbers in either branch (pre-existing); escape both together.
- The editor breadcrumb still says "Create Invoice" in quote mode.
- Every app page POSTs `/api/v1/events` and gets a 403 for the seed owner locally (consent-gated analytics) — check whether that is expected in production.
