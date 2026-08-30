# Round 18 handoff — owner-only HR approval · client address & country · export invoices · delete/cancel

**Date:** 2026-08-30 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** **`0055_invoice_soft_delete_export_lut.sql`** (idempotent, additive).
**Gate at handoff:** api typecheck ✓ · boundaries ✓ · web typecheck ✓ · web build ✓ ·
full jest ✓ · RLS `leak_with_bogus_context = 0` ✓ · live Chromium pass ✓

Read after `2026-08-29_Round17_Employment_Terms_Owner_Onboarding_Handoff.md`.

## The four founder items

1. Lock approval of HR staff to Owners only (the gap flagged at the end of 17.1).
2. Client creation asks for no **address** and no **country**.
3. A USD/foreign client is still asked for a **GSTIN** — "completely wrong".
4. No way to **delete** a client or an invoice.

## Item 1 — owner-only approval of HR staff

`getOnboardingQueue` now LEFT JOINs `memberships` **on `employee_id`** (an invited
employee has `user_id NULL`) with **no status filter** — a pending HR admin's seat
is still `'invited'`, so filtering on active would hide every admin from everyone.
When the caller is not an owner, rows whose membership role is `owner`/`admin` are
excluded; `role IS NULL` (an ordinary joiner) stays visible.
`approveOnboarding`/`rejectOnboarding` gained the matching guard, deriving both the
target's and the caller's role inside the tenant transaction (never from the
client), and `dashboard.service`'s duplicate bucket mirrors it as a SQL EXISTS
subquery in the `notOwnRequest` style — deliberately **not** a new `getAdminOverview`
option, which would have broken five call sites in `founder-round8.spec.ts`.

**Deliberate exception:** a workspace with **no active owner** still lets admins
approve. Without it a pending admin would be stranded with nobody able to act —
house rule 8. The notification fan-out keeps the matching fallback so the people
who *can* act are the people who get told.

Web: an "Owner approval" pill on those rows, role-aware empty-state copy, and the
deep-linkable review dialog now hides Approve/Send-back (it is reachable by URL)
when the row is not in the viewer's queue.

## Items 2 + 3 — client address, country, and real export handling

### What was actually broken (worse than reported)

- Nothing in the UI could set `customers.country_code` (default `'IN'`), so
  `deriveTaxTreatment` — which checks country **first** — never returned `EXPORT`.
  A US client was stored `INTER_STATE`, and GSTR-1 buckets on `tax_treatment` first,
  so **foreign invoices were filed into B2B/B2CL instead of EXP**. They only escaped
  GST because the user happened to pick USD, which flips a *separate* currency gate.
- `<Address>` in `InvoiceRenderer` returns `null` when every line is empty, and no
  form ever collected an address — so **every** invoice PDF printed a Bill-To block
  containing only the client's name. Rule 46(e) makes the recipient's name, address
  and state mandatory for unregistered recipients at ≥ ₹50,000.
- The in-app preview (`(public)/invoicing/[id]/preview`) hardcoded the five billing
  address fields to `null`, so it would have stayed blank even after the fix.

### What shipped

One client form (`CustomerModal`) for both entry points — the invoice editor's
separate 4-field quick-add is gone, so a client created mid-invoice can no longer
be born stateless (that one produced IGST-forever clients). **Country drives the
form**: India ⇒ GST state dropdown + GSTIN + PAN; anywhere else ⇒ free-text state
and **VAT/Tax ID**, with no GSTIN field at all. Billing address (line 1/2, city,
state, postal code) is always asked. `country_code` is the single source of truth
and writes `billing_country` in step.

API: GSTIN/PAN now validate against the shared `GSTIN_REGEX`/`PAN_REGEX` (`''`
still means "clear it"), a GSTIN sent with a non-IN country is a 400, and the six
`shipping_*` fields were added to the DTO — they existed in the DB and were being
silently dropped. Moving an existing Indian client abroad is a legitimate edit: the
stale GSTIN is **cleared**, not thrown back at the user.

### Export of services (the research, encoded)

A supply to a client outside India is zero-rated under s.16 IGST. So:

- **Place of supply is `'96'`** — the statutory "Other Country" code. Deliberately
  not the ISO country code: `NL` is both Nagaland and the Netherlands, and
  `stateName('NL')` resolves to Nagaland.
- The invoice prints the **Rule 46 endorsement**, chosen by route:
  `SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF
  INTEGRATED TAX` (LUT, the default) or `…ON PAYMENT OF INTEGRATED TAX`. The route
  and LUT number are **snapshotted onto the invoice** at creation — an LUT is
  annual, and a document must stay true to its date of supply — while the sentence
  itself is derived at render time so it can never go stale.
- The recipient **GSTIN row is omitted** on an export invoice, and GSTR-1's EXP
  rows report `customer_gstin: 'URP'` with `place_of_supply: '96'`.
- Settings → Invoicing → Compliance gained an **Exports** card (route, LUT number,
  validity).
- `computeInvoice` zero-rates only under LUT; `WITH_IGST` charges the line rate.
  The default reproduces previous behaviour byte-for-byte, and the existing
  `isDomestic` gate is untouched so genuine foreign-VAT invoices don't get zeroed.

Also fixed: the editor's client-side treatment memo could never return
`INTRA_STATE` (it had no access to the tenant's state), so the pre-save totals card
showed one IGST line where the server saved CGST + SGST.

**Deferred, stated plainly:** `fx_rate_to_inr` is still NULL for non-INR invoices.
Rule 34 wants an INR equivalent and GSTR-1's EXP table needs INR values, so **the
GSTR-1 figures for foreign invoices remain incomplete until an FX rate exists**.
This round fixes the *bucketing*; the conversion needs either an FX source or a
manual rate field and is a separate piece of work.

## Item 4 — delete and cancel

Researched against what the founder named: **Zoho Books** makes you delete recorded
payments before deleting an invoice and never reuses a cancelled number;
**Refrens** blocks deletion once a payment exists and keeps deleted invoices in a
**Deleted tab with Restore**. Both are matched.

- `DELETE /invoices/:id` → **soft** delete. Hard is impossible: `invoice_payments`
  and `razorpay_orders` CASCADE off `invoices.id`, so a real DELETE would destroy
  money records. `POST /invoices/:id/restore` undoes it.
- **409 when a payment exists** ("Remove the recorded payment first…") and when a
  credit note references the invoice.
- **The number is never released or reused** — `invoices_tenant_number_unique` stays
  non-partial on purpose. GST wants a consecutive series and the customer may hold a
  copy.
- **Cancel finally has a UI.** It was fully implemented, audited and tested
  server-side since Sprint 3 and exposed nowhere. It is now the recommended action
  for an issued invoice, on the list row and behind a ConfirmDialog with a reason.
- Deleted invoices are filtered out of **every** read: the `fetch()` chokepoint
  (which covers get/update/duplicate/cancel/void/write-off/send/record-payment),
  list, all reports **and GSTR-1**, the hosted/public payload, the CRM deal
  Documents card, subscriptions, credit notes, the members overdue pills, and — the
  highest-consequence one — the **reminder job**, which would otherwise email
  customers about invoices their supplier deleted.
- Clients: `DELETE /customers/:id` deletes outright when nothing references the
  client, and soft-deletes otherwise (`invoices.customer_id` is NOT NULL + RESTRICT,
  so a billed client must keep resolving on its past documents). The response says
  which happened and the UI explains it.
- **`nextCode` had to be fixed first**: it was `count(*) + 1`, so deleting the 3rd
  of 5 clients would hand out an existing code and 409 the very next "Add client".
  It now derives from the highest existing suffix, including soft-deleted rows.

Stale copy corrected: cancel's "auto credit note arrives in Sprint 6" was untrue —
credit notes shipped long ago and cancel does not raise one.

## Tests

New `founder-round18.spec.ts` (17 cases): the queue/approve/reject rule for both
roles plus the no-owner escape hatch and the dashboard mirror; a US client with a
full address and no GSTIN; GSTIN-with-foreign-country rejected; an Indian client
moved abroad has its GSTIN cleared; `EXPORT` + POS `'96'` + zero GST; `WITH_IGST`
charging tax; the GSTR-1 **EXP** bucket reporting `URP`/`96`; soft delete → hidden →
restore with the number never reissued; delete refused with a payment; unbilled
client hard-deleted with no code collision; billed client archived; a deleted
invoice dropping out of the money totals.

Two regressions the suite caught during development, both now covered: the
`nextCode` regex written in a template literal (`\d` compiles to `d`, so it matched
nothing and every client collided on `CUST-0001`), and the country-flip rule
rejecting a legitimate edit instead of clearing the stale GSTIN.

## Deploy checklist

1. **Apply `0055_invoice_soft_delete_export_lut.sql` in Supabase** (still pending
   from round 13: `0054`).
2. Deploy API + web.
3. **Set the country on any existing foreign client** — the migration deliberately
   doesn't guess. Their *past* invoices keep the treatment they were issued with
   (issued documents are never rewritten); new invoices then file correctly.
4. Set the LUT number in Settings → Invoicing → Compliance if exporting under LUT.

## Known follow-ups

- `fx_rate_to_inr` / INR equivalent on export invoices (above) — needed for a
  complete GSTR-1 EXP filing.
- SEZ supplies (domestic but zero-rated) are still unsupported — a separate
  treatment, bucket and route pair.
- Auto credit note on cancel is still not implemented (issue one from
  Invoicing → Credit notes).
- Shipping-address UI (the DTO fields now exist; billing is the statutory one).
- Presence resolves "today" in UTC while attendance stores IST dates, so between
  midnight and 05:30 IST a clocked-in employee shows offline (`attendance-selfheal`
  flakes for the same reason).
