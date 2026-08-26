# Round 9 handoff — 401 noise, quick-start flash, CRM cleanup, coupon retirement

**Date:** 2026-08-26 (same day as round 8) · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** `packages/db/drizzle/0053_crm_soft_delete_leads_forms.sql`
**Prod data op to run:** `scripts/supabase-editor/06-retire-coupons.sql`
**Gate at handoff:** api typecheck ✓ · api build ✓ · **jest 568/568 (49 files)** ✓ ·
`lint:boundaries` ✓ · web typecheck ✓ · web production build ✓ ·
`diagnose-rls.sh` → 0 leaks, 137/137 ✓ · live Chromium pass over every item ✓

Read after `2026-08-26_Round8_Access_Approvals_Handoff.md`.

## 1. The console 401s on `/notifications/unread`  *(founder item 1)*

**Diagnosis.** The route is healthy — only `JwtAuthGuard` can 401 it. The access
cookie deliberately lives 15 minutes; when it lapses, the first request to
notice eats a 401, silently refreshes and retries. The notifications bell is
the only query with `refetchOnWindowFocus: true` + a 2-minute poll, so it is
always that canary. The founder's two console lines were two self-healed
expiries — cosmetic. But the trace exposed a real hole: an unrecovered 401 on
a *background poll* hard-redirected the whole app to `/login`, ejecting a
session with a valid 180-day refresh cookie (the same failure class `b92665d`
fixed for `/auth/me`).

**Fixes (`apps/web/lib/api/client.ts`):**
- `/api/v1/notifications/unread` and `/api/v1/presence` joined
  `AUTH_PATHS_NO_REDIRECT` — background polls fail quietly; only the
  `/auth/me` path (already guarded by `authRejected`) can bounce to login.
- **Proactive refresh**: the client stamps the cookie's mint time (exactly on
  every successful refresh; lower-bound estimate on the first authenticated
  success after load) and refreshes at ~12 minutes via a 60s heartbeat plus a
  `visibilitychange` hook — so the 15-minute cookie never actually lapses
  while a tab is open or on return to it. Also heals the socket gateways'
  15-minute handshake death. Single-flight refresh reused.
- `Content-Type: application/json` is no longer sent on GETs (it forced a CORS
  preflight on every read).

## 2. CRM quick-start checklist  *(founder item 2)*

Two defects: the card decided visibility against `undefined` query data (flash:
"0 of 5 done" → hide, within ~1s), and its predicates were weak proxies that
auto-satisfied (steps 1 and 5 were the same condition via a dead `||`;
"schedule a follow-up" counted completed and due-date-less activities).

`apps/web/app/(app)/crm/page.tsx`: the block renders only when all four inputs
(`forecast/board/mine/reps`) have settled — the invoicing wizard's pattern —
and the steps are now: deal exists · a deal has BOTH company & contact · an
open activity with a due date exists · ≥2 members · **every open deal has a
next step**. Dismissal stays in `localStorage` (deliberate). Verified live:
no flash, "2 of 5 done" persists on a partly-set-up workspace.

## 3. CRM delete & cleanup  *(founder item 3)*

**Migration 0053**: `deleted_at` on `leads` and `web_forms`;
`uq_web_form_name` rebuilt as a partial unique index (`WHERE deleted_at IS
NULL`) so a deleted form frees its name; live-rows partial index on leads.

**API** (all soft deletes, `crm.<entity>.delete` audit, tenant tx,
`@Roles('owner','admin','manager')` + `@RequireGrant('crm','edit')`):
- `DELETE /crm/leads/:id` — works from any status; converted records are kept
  (their FKs are lead-side). Every lead read now filters `deleted_at`,
  including the status counts and the claim/discard/convert guards.
- `DELETE /crm/forms/:id` — the public token dies immediately (publicForm and
  submit filter `deleted_at`), submissions + leads are kept. `setActive` also
  gained the audit row it was missing.
- `DELETE /crm/activities/:id` gained the `@Roles` gate the other deletes
  carry (it was grant-only).
- **Bulk purge**: `GET /crm/activities/purge-preview?days=&completed_only=` and
  `POST /crm/activities/purge` (both **owner/admin only**; days ∈
  {30,60,90,180,365}). One set-based soft delete in a tenant tx, ONE
  `crm.activities.purge` audit row carrying the count, and the touched deals'
  `next/last_activity_at` recomputed. No socket emit (ActivitiesService has no
  emitter; react-query invalidation covers the acting user — noted as a
  conscious cut).

**Web**: delete buttons with confirms on the contact/company/deal detail
pages; Delete beside Discard on leads (both live and analytics rows); Delete
beside the toggle on forms; completed activities are deletable; and a
**"Clear old activities"** preview→confirm card on `/crm/merge` (Data
hygiene), owner/admin only.

## 4. Coupons — retired, and the sequence surface removed  *(founder item 4)*

Founder's decision: **delete everything except FOUNDER-001**.
- `scripts/supabase-editor/06-retire-coupons.sql` — deletes every
  founder/chartered-accountants code with `redemption_count = 0`. FOUNDER-001
  is untouchable by construction (redeemed; FK-protected; its 3 months were
  already materialised into `trial_ends_at`). **The founder must run this in
  the Supabase SQL editor.**
- Both seeds (`scripts/seed-coupons.sh`, `scripts/supabase-editor/
  05-seed-coupons.sql`) now mint ONLY FOUNDER-001 — re-running the runbook
  can no longer resurrect the retired sets. Runbook text updated.
- **Sequential minting is rejected** (`fam-billing.service.ts` throws;
  console dropdown replaced with a fixed "Random" field) — numbered sequences
  are enumerable, which was the founder's actual concern. Note the CA codes
  were 10-use each: 15 codes = up to 150 free workspaces of exposure.
- New `DELETE /fam/coupons/:id` (FAM only): unredeemed codes delete with a
  platform-audit row; redeemed ones 409 ("deactivate instead"). Console got a
  per-row Delete button for unredeemed codes.

## 5. Deploy checklist

1. Apply `0053_crm_soft_delete_leads_forms.sql` in the Supabase SQL editor.
2. Run `06-retire-coupons.sql` there too; verify the SELECT at the bottom
   shows only FOUNDER-001.
3. Deploy API + web. No new env vars.
4. Smoke: `/crm` shows the Get-set-up card without flashing; delete a test
   lead; Data hygiene → Clear old activities previews a count; FAM → Coupons
   shows Delete only on unredeemed rows and no Sequential option.

## 6. Open follow-ups from this round

1. `MemberAccessModal` still uses the replace-all grants endpoint (pre-round-9
   known issue) — move it to the per-module upsert.
2. Activity purge does not broadcast `crm.board.changed` to OTHER open
   sessions (needs an EventEmitter2 in ActivitiesService; 6 spec ctors).
3. A nightly hard-purge cron for long-soft-deleted CRM rows could copy
   `pm.jobs.ts:70-89` (`pm-recently-deleted-purge`) if retention ever becomes
   a compliance ask.
4. `subscriptions.applied_coupon_id` is a bare uuid nothing reads — harmless,
   but worth dropping or FK-ing whenever billing is next touched.
