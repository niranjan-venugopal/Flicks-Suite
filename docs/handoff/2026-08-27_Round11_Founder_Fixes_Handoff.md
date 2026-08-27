# Round 11 handoff — styled confirms, review flows that go somewhere, FAM verify/logos, the stuck sidebar

**Date:** 2026-08-27 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** none (no schema changes — link_url/verified_at/logo_key all existed).
**Gate at handoff:** api typecheck ✓ · api build ✓ · **jest 579/579 (51 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → 0 leaks (137/137) ✓ · live Chromium pass over every item
(owner + employee + FAM sessions) ✓

Read after `2026-08-26_Round10_Onboarding_UX_Handoff.md`.

## 1. Styled confirmations everywhere  *(founder item 1)*

All **15** `window.confirm()` call sites are gone — replaced by a shared
`ConfirmDialog` (`components/common/ConfirmDialog.tsx`, rewritten in place: it
existed as orphaned shadcn code with zero importers). It's a proto `Modal`
(width 440) with the house ghost-Cancel / coral-danger-confirm footer (same
shape as the CRM "Mark as lost" dialog); every site keeps its **exact former
message copy**, wires `loading={mutation.isPending}` (dismissal blocked
mid-mutation) and closes on success. Non-destructive confirms (invoice
mark-as-paid, Razorpay disconnect) use the primary button, deletes use danger.
Migrated: CRM contact/company/deal detail + list-bulk deletes, leads (both
statuses), forms, activity purge, FAM coupon delete, PM team delete, holiday
delete, invoice mark-paid, Razorpay disconnect. `profile/page.tsx`'s local
function named `confirm` was a grep false positive — untouched. The live
harness bans native dialogs globally (`page.on('dialog', throw)`) — none fired.

## 2. Web-forms row alignment  *(founder item 2)*

The delete button wrapped because the row is one wrapping flex line whose name
block refused to shrink below 220px inside a 900px page. The action cluster
(submissions pill · Copy link · Preview · Submissions · toggle · delete) now
lives in a single non-shrinking group and the name block floors at 150px —
everything sits on ONE line at desktop widths (verified: name and trash within
11px vertical offset at 1280px); on narrow screens the whole cluster wraps as
a unit instead of orphaning the trash button.

## 3. Delete on the contacts & companies LIST pages  *(founder item 3)*

Both tables get a trailing actions column with the icon-only trash button
(tooltip "Delete — Manager and above", mirroring the API's
`@Roles('owner','admin','manager')`), driving the same styled confirm with the
detail pages' copy. The bulk-select delete flows through it too. Also fixed a
staleness gap: deleting a contact now refreshes company views and vice versa
(`useDeleteContact`/`useDeleteCompany` cross-invalidate).

## 4. The onboarding-approval notification now goes somewhere  *(founder item 4)*

**Root cause:** the in-app notification (and the manager email) carried a
static `/employees/onboarding` link — a bare queue with no data. The click
handler always worked; the destination was empty.

- The notification/email now deep-link to
  `/employees/onboarding?employee=<id>` (grouped per employee, so resubmits
  collapse into one row).
- New **`OnboardingReviewDialog`**: opens from that URL (also from each queue
  row's Review button and the Inbox approval card) and shows everything the
  hire submitted — personal & contact, address, emergency contact, employment,
  and statutory & banking with the same masking as the employee 360° page
  (PAN/passport dots, account `•••• 0000`, Aadhaar last-4) — with
  **Approve** and **Send back (with reason)** right in the footer, using the
  existing mutations. The queue page's old shadcn reject dialog was removed
  (subsumed). Display primitives were extracted to
  `components/employees/detail-kit.tsx` (pure move from the detail page).
- Bell hardening: a notification with no link now lands on `/inbox` instead of
  dying silently. (The Inbox notifications list already renders at `/inbox`,
  so it keeps its behavior — deliberate deviation from symmetry.)
- Verified live: employee submits → owner's bell → click → the modal opens on
  that hire → Approve → hire active, queue empty, URL param cleared.

## 5. FAM: reviewable verification + signup pings  *(founder item "FAM admin also")*

- **New signups now notify every active platform admin** (in-app, type
  `tenant.signup`) with a deep link to `/fam/verify?tenant=<id>`. The insert
  uses `tenant_id NULL` **deliberately** — the notifications `tenantScope`
  keeps NULL rows visible regardless of the admin's JWT tenant, which is what
  makes them show in the FAM shell. Best-effort per house rule 6: a
  notification failure can never fail signup.
- **The verify queue is deep-linkable**: `?tenant=` pre-selects the company
  (selection also writes the URL), and every "Review"/"Queue" entry point
  (FAM overview widget, unverified tenant detail) now carries the tenant id.
- The decision-notes textarea finally goes somewhere: notes ride the
  `tenant.verified` platform-audit row (`metadata.notes`). Reject / Snooze /
  Email-for-clarification remain disabled placeholders — unchanged scope.

## 6. The VERIFIED badge — flow checked, verdict: honest  *(founder item)*

Grep-proven and codified in a spec: **nothing in application code sets
`tenants.verified_at` except the FAM "Mark verified" action**
(`fam.service.ts verifyTenant`); `createTenant` leaves it NULL (asserted in
`founder-round11.spec.ts`). What the founder saw was one of: (a) the demo
seed (`scripts/setup-demo.sh:972`) pre-verifies one tenant "as if verified
during onboarding"; (b) someone clicked Mark verified earlier; (c) the green
ACTIVE **status** pill being read as a verification badge — the tenants list
had *no* verified indicator at all. Fix = disambiguation: `listTenants` now
returns `verifiedAt` and the list shows a distinct **Verified / Unverified**
pill column.

## 7. FAM logos  *(founder item)*

Logos are stored as `tenants.logo_key` (private R2, needs a signed URL);
`logo_url` is a legacy column that is almost always NULL — and the FAM
endpoints returned the legacy column raw (or nothing). Now `getTenant`,
`listTenants` and `getVerificationQueue` serve
`MediaService.servedUrl(logo_key, logo_url, 256|64)` — the same rule the
customer app uses — and the FAM tenant list/detail/verify Avatars pass `src`
(initials remain the fallback; without R2 keys locally you still get
initials, never broken images). **Same-class bonus:** `GET /me/companies`
(the company switcher) had the identical bug — now serves signed logos too.
`FamModule`/`MembersModule` import `MediaModule`; existing spec ctors gained
a media stub (positional — appended, not reordered).

## 8. The stuck sidebar dropdowns  *(founder item, all roles)*

**Root cause:** `Sidebar.tsx` derived `isOpen = openGroups[id] || <route is
inside this section>`. The OR means the section containing the page you're ON
can never close — the toggle writes `false`, the render ORs it back to open,
and the chevron doesn't even rotate, so it reads as frozen. A second force:
an effect wrote `true` for the active section on every navigation. Fix: `||`
→ `??` (the user's explicit choice is authoritative; untouched sections still
auto-reveal the active route) and the force-open effect deleted. One
component serves both the customer app and the FAM console, so every role is
covered. Verified live: the CRM section collapses *while on /crm/deals*,
stays collapsed across navigation, reopens on click. The <900px auto-collapse
and localStorage rail state were deliberately untouched.

## Tests

`founder-round11.spec.ts` (5 specs, real Postgres, REAL NotificationsService
so the fan-outs are asserted as DB rows): submit-for-review notification
carries the employee deep link + group key; queue→approve activates;
`createTenant` leaves `verified_at` NULL **and** writes exactly one
`tenant.signup` row per platform admin (`tenant_id NULL`, correct link, none
for ordinary users); `verifyTenant` sets verified_at/by + audits notes; the
queue drops verified tenants; `listTenants` returns `verifiedAt` + served
`logoUrl`. One existing assertion updated on purpose:
`founder-round5.spec.ts` expected the OLD static notification link — it now
expects the deep link. 579/579 green.

## Deploy checklist

1. No migration, no data op, no new env vars. Deploy API + web.
2. Smoke: delete a test contact from the list — the dark in-app dialog (not
   the white browser popup); collapse the CRM sidebar section while inside
   CRM; submit a test onboarding and click the bell notification — the review
   modal opens on that hire; FAM → Tenants shows the Verified/Unverified
   column; FAM bell pings on a new signup.

## Open follow-ups from this round

1. Verify-page Reject / Snooze / Email-for-clarification are still disabled
   placeholders (approve is the only decision).
2. The FAM verify queue lists every unverified tenant from signup — a
   "details submitted" stage gate (only queue tenants that completed the
   GSTIN step) could cut noise if signups grow.
3. `NotificationsTab` (inbox) keeps its no-link no-op (it already renders at
   /inbox) — only the bell got the fallback.
4. The verified pill uses `Pill` uppercase styling ("UNVERIFIED") like every
   other pill — flagged in case the founder prefers title case there.
