# Round N — Faces everywhere: uploaded photos on every person list

**Date:** 2026-09-22 · **Type:** bug fix (founder report) + a security hardening pass it uncovered · **Migration:** none
**Reported by:** founder, with a production screenshot of Time → Attendance → Team. Standing rule: *"no leakage of data at any point."*

## 1. What the founder reported

> *"The images are not reflecting the images of the employees in the Team attendance list. Can you check and fix the bug? Also make sure the bug is fixed on wherever this bug is there for any organisation or any list where the image gets involved."*

## 2. Root cause

Uploading a profile photo writes **one** column: `users.avatar_key` — a *private* R2 object key (`users/<id>/avatar/<uuid>_256.webp`). It is not a URL and cannot be rendered directly; it has to be signed for reading. `users.avatar_url` is a legacy public-URL column kept only as a fallback for old rows.

So any endpoint that returns a person **must** join `users`, sign the key (`MediaService.servedUrl(key, legacyUrl, 64)`), and strip the key before responding. An endpoint that skips this returns no photo at all, and the web — correctly — falls back to coloured initials. That is the entire bug.

The Team attendance list was the clearest case: `listTeamToday` selected only `employeeId / employeeName / employeeCode / locationName` from `employees ⋈ locations`, never touching `users`, and the attendance module did not even have the media service available. The chip therefore rendered with no photo to show. The regularization detail was worse: it returned a **hard-coded `avatarUrl: null`**.

An audit of the whole app found **33 person chips** showing initials-only, in two classes: the API never returned the photo (most), or the API returned it and the web dropped it (dashboard approvals, the project team pages).

## 3. What changed

### One shared signing primitive
- **`apps/api/src/core/storage/signed-avatar.ts`** (new): `servedAvatarUrl(r2, key, legacyUrl, size)` — the signing body, moved out of `MediaService` so modules that cannot import the media module can still sign; and `withSignedAvatars(sign, rows)`, the strip-and-sign row mapper. `MediaService.servedUrl` now delegates here, so the two paths cannot drift.
- **`apps/api/src/modules/media/public.ts`** (new): the facade CRM imports through (its dependency rule forbids deep imports).
- Audit signs via the **global** storage module rather than importing media, because media already imports audit and the reverse would be a cycle.

### Endpoints that now return a signed photo
| Area | Endpoint | Field |
|---|---|---|
| Attendance | `GET attendance/team/today` | `avatarUrl` + `employeeUserId` (the id also powers the live presence dot) |
| Attendance | regularization detail (reviewer) | `avatarUrl` — replaces a hard-coded `null` |
| Leave | `GET leave/team` | `avatarUrl` |
| Timesheets | team list, approval queue, utilization report | `avatarUrl` |
| Dashboard | `GET dashboard/admin/activity` | `avatarUrl` |
| Audit | audit log search | `avatarUrl` |
| CRM | deals (board, list open/closed, detail, contact & company timelines), owner picker, leads, reports (leaderboard, forecast drill-down, goals), my activities | `owner_avatar_url` / `user_avatar_url` / `assignee_avatar_url` |
| Platform console | tenant members, auditor registry, feedback inbox | `avatarUrl` / `user_avatar_url` |

Rules held everywhere: the photo is signed at the **64 px** rendition, signing happens **after** the tenant transaction (it is local cryptography, not a network call), the raw key is **stripped from every response**, and a signing failure degrades to the legacy URL or null rather than failing the read.

### Web
- The Team attendance chip (the founder's screenshot) now renders the photo with the live presence dot, matching the Team page.
- Photos passed through on: dashboard team-today, pending approvals and recent activity; Team → Leave and Team → Timesheets; Reports → Utilization and Audit; CRM owner chips; the project team pages; the platform console.
- **Expired-link resilience:** signed URLs last 24 hours. None of the three avatar components reset their "this image failed" flag when the row's photo changed. That is the founder's own bug in a second form: once a link expired, that row slot stayed on initials for the session, and — because lists re-sort and paginate — the stale failure was handed to **the next person to occupy that slot**, who then showed initials despite having a perfectly good photo. All three components now reset on change and recover on the next data refresh.
- **Upload propagation:** a new photo previously refreshed only a few screens. The invalidation list now covers attendance, leave, timesheets, CRM, calendar, audit and the platform console.
- Cleanup: two duplicate copies of the project avatar component collapsed onto the shared one; an unused avatar component deleted.

## 4. Security hardening this uncovered (important)

Reviewing which rows the newly-photographed reads return exposed **pre-existing** gaps in CRM: several reads were relying on database row-level security alone to scope them, without the explicit tenant predicate the house rules require as a second line of defence. Attaching a face to those rows is what made them worth proving.

Fixed, each with a regression test that runs on a **security-role connection with row-level security off** — the only way to distinguish "the query is scoped" from "the connection is scoped":

*Reads that gained a face:*
- **My activities** filtered on assignee/completed-by only. A person who belongs to more than one workspace is the normal case here, so this one genuinely spanned workspaces.
- **Deal detail** looked up by the id in the URL with no tenant predicate; the whole payload (stage history, products, people, tags, owner) hangs off that row.
- **CRM reports**: a `pipeline_id` from the query string resolved unscoped, and the forecast drill-down had no tenant predicate at all; plus the snapshot, funnel, stage-history, velocity and counters reads.

*Two write/send paths found while sweeping for the same pattern — these matter more than the reads:*
- **Offboarding bulk reassignment** (`crm/merge.service.ts`) took two user ids from the request and had no tenant predicate on the membership check **or on its three bulk UPDATEs**. Demonstrated with row-level security not binding: it moved a deal, an activity and a lead into another workspace. Now scoped, and it refuses a receiver who isn't a member *before* writing anything.
- **CRM send email** (`crm/email.service.ts`) resolved the deal, template and **person** ids on row-level security alone. The person id is the sharp end: that person's address becomes the **recipient**, so a foreign id could have addressed a message outside the workspace. All three are now tenant-scoped.

No customer data was exposed by any of these in production: row-level security was doing its job on the tenant connection, which is why they were invisible. The predicates restore the defence-in-depth the codebase standard requires. The leak probe reports **0 leaks across 133 tenant tables**.

**Known remaining posture (not a regression):** roughly 120 other CRM reads across 16 services still rely on row-level security alone rather than carrying their own filter. That is the module's pre-existing standard and every avatar-bearing read in this round is now explicit. Hardening the rest deserves its own change and its own test run — listed as a follow-up rather than smuggled into a photo fix.

## 5. Not changed (and why)

- **CRM contacts, leads and companies**: these are your customers, not your staff. There is no photo of them in the system — this is a missing feature, not this bug. Same for invoicing customer chips.
- **Notification rows** carry no actor identity at all, so there is no person to show a face for.
- The win/loss "by owner" report groups by name, so a photo there would change the shape of the aggregate rather than add a field.

## 6. Verification

**Tests:** two new specs (`founder-roundN-avatars-a`, `founder-roundN-avatars-b`) pin every changed endpoint three ways — a person with an uploaded photo, a person with only a legacy URL, a person with neither — plus a sweep asserting the private key never appears in any response, cross-tenant cases, and the no-signer fallback. Regression suites across HR, CRM, platform and invoicing re-run green.

**Gate:** API typecheck · build · full Jest · module-boundary lint · web typecheck · web production build · leak probe = 0.

<!-- LIVE-RESULTS -->

## 7. What to tell your team

1. Everywhere a person appears in a list, their uploaded photo now shows. People who haven't uploaded one keep their coloured initials — that is intentional, not a failure.
2. Uploading or changing a photo now updates every screen without signing out.
3. If a browser tab is left open for more than a day, photo links expire; the chip quietly shows initials and the photo returns on the next refresh.
4. CRM contacts and leads are outside customers — the system holds no photo of them. Adding contact photos would be a new feature.

## 8. Follow-ups

- Contact/lead photos in CRM; customer logos in invoicing.
- Actor identity (and faces) on notification rows.
- **Bulk hardening pass**: give the remaining ~120 CRM reads their own workspace filter instead of relying on row-level security alone (see §4).
- The owner picker in CRM lists auditor and guest seats while the reports leaderboard excludes them — the two should agree.
- The CRM win/loss "by owner" report groups by name, so two reps with the same name merge into one row.
- A contact's chip in the CRM directory shows the *owner's* availability dot, which is misleading.
- The feedback inbox hides a respondent's email behind their contact preference but still shows their name and now their photo; decide whether the photo belongs behind that preference.
- Converge the remaining avatar components (proto, the newer one, the project one) on a single primitive.
