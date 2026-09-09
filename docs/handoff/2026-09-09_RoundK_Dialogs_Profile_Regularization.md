# Round K — Safari-proof dialogs, self-service Edit profile, regularization deep link

**Date:** 2026-09-09 · **Type:** production bug clearance after the Round J deploy · **Migration:** none
**Reported by:** founder — *"invoicing delete option showing this issue [Delete
invoice dialog with only its title bar]. check all the places for this kind of
alignment issues and correct it. Also we got some user feedbacks: 1. Edit
profile button is not working for me. 2. Ranjith made the regularize request
and when i click on the request in the Flicks Suite, its redirecting to my
timesheet and not Ranjith's timesheet. (This should be in Manager's view
page)."* Standing rule: *"Do not mess with the User details or the security …
no leakage of data at any point."*

## 1. What the founder gets

| # | Complaint | What changed |
|---|---|---|
| 1 | **Delete invoice dialog shows only its title bar** on Safari; sidebar and topbar stay bright | Every dialog in the app now renders through one shared overlay that is portaled to `<body>`, dims and blurs the whole screen (chrome included), and sizes its body the way WebKit expects — body text, Cancel and Delete are back on Safari, and the fix is structural so it holds for all ~45 proto dialogs plus the 13 hand-rolled overlays that were migrated (§3). |
| 2 | **Edit profile does nothing** | A real Edit profile dialog on *My profile* (founder decision: **contact details only** — personal phone, personal email, current address, emergency contact — saved immediately; name / work email / designation / role stay HR-managed and are shown read-only with a *Managed by HR* note). Also revived on the same page: a real **Last sign-in** time and a working **Sign out other devices** (§4). |
| 3 | **A regularization request notification sends the manager to his own attendance page** | The notification (in-app and email) now opens **Inbox → Approvals with that request selected** (founder decision), with the employee's proposed in/out times and a *View {name}'s attendance →* link to their attendance history; the employee's approve/reject notice opens their own attendance log on that day. The 6th+ pending request is finally reachable (the Inbox was capped at the dashboard's top 5). Old stored `/team/attendance` links keep working, role-aware (§5). |

Also closed while in there, because the "no leakage" rule demanded it: `GET
/employees/:id` returned the full personal block (personal phone/email,
addresses, DOB, bank details, emergency contacts …) to **any** workspace
member. It is now redacted unless the viewer is the person, their direct
reporting manager, or owner / admin / finance / FAM (same predicate as the
Round 15 attendance-history rule). The 360° page shows "—" for redacted fields.

## 2. Founder decisions (asked and answered)

| Question | Decision |
|---|---|
| Which browser showed the broken dialog? | **Safari on Mac.** (The structural cause is below; Safari cannot be driven from the build box, so §8 asks the founder to confirm the Delete-invoice dialog there.) |
| What may a person edit on their own profile? | **Contact details only** — personal phone, personal email, current address, emergency contact; saved immediately, no approval. Name, work email, designation, role stay HR-managed (Employees → Edit, with the existing confirmation flow). |
| Where should the regularization notification land? | **Inbox → Approvals with the request selected**, plus a link to the person's attendance log. |

## 3. Fix A — the dialog class (Safari + un-dimmed chrome)

### Root causes (two, both structural)

1. **WebKit flex sizing.** The proto `Modal` body was `flex: 1` (basis **0**) +
   `overflow: auto` inside an auto-height column-flex card with `overflow:
   hidden`. WebKit sizes an auto-height flex container from the children's
   flex *base* sizes, so a basis-0 body resolves to **0 px** and the footer
   collapses to its top border — exactly the founder's screenshot (title bar
   only). Chromium sizes from content, which is why it never reproduced in
   headless verification. Fix: body `flex: 1 1 auto; min-height: 0; overflow:
   auto`, head/foot `flex-shrink: 0`.
2. **Not portaled.** The Modal rendered in place. On invoicing pages that is
   inside `InvoPage`'s `position: relative; z-index: 1` wrapper
   (`components/invoicing/invo.tsx`), which creates a stacking context that
   traps the z-1000 scrim **under** the sticky Topbar (z 50, backdrop-filter)
   and the sticky Sidebar — the bright chrome in the screenshot. The same
   `z-index: 1` page-shell wrapper exists on ~15 pages (inbox, profile,
   attendance, team, dashboard …), so every in-tree overlay was affected
   app-wide; only the recurring-invoices drawer had worked around it with a
   portal, and the Radix dialogs are portaled by construction.

Round D's `.modal-card` (opaque face, no nested backdrop-filter) fixed the
card's *paint*; it could not fix layout or stacking.

### The fix

- **New primitive `components/proto/Overlay.tsx`** — client component,
  mounted-guard, `createPortal` to `document.body` of **two fixed siblings at
  the same z-index**: a scrim (`[data-overlay-scrim]`, dim + blur, click →
  close) and a root (`[data-overlay-root]`, flex-centred, `pointer-events:
  none`, children re-armed via `.overlay-root > * { pointer-events: auto }` so
  a proto dialog still works while a Radix dialog has set `pointer-events:
  none` on `<body>`). No `isolation: isolate`, no negative z-index: a
  backdrop-filter inside an isolated root samples nothing and renders as a
  flat dim. Props: `open, onClose, zIndex (1000), align (center|start|end),
  padding, blur, dim, label`.
- **`components/proto/Modal.tsx`** — same public API (`open, onClose, title,
  sub, children, footer, width, hideHeader, bodyPadding`, so no call-site
  changes); renders through `Overlay`; card keeps `card-glass modal-card` +
  `stopPropagation` (React portals bubble through the React tree, and some
  pages have clickable ancestors); `modal-head` / `modal-body
  [data-modal-body]` / `modal-foot [data-modal-foot]` with the WebKit-safe
  flex rules, also pinned in `globals.css`.
- **`globals.css`** — the three rules above; the layering comment now says
  overlays portal to `<body>`, so page-shell `z-index: 1` wrappers no longer
  matter. The three **blocking gates** (billing wall, consent *Manage
  choices*, terms re-acceptance) move from 850–990 to a **1300–1399 band** above every
  overlay: once overlays portal to `<body>` they would otherwise have painted
  *over* a locked workspace or an unaccepted terms gate (the command palettes
  had sat at z 200, below the gates, before). Radix dialogs stay at `z-50`
  (portaled, so the number only has to beat in-flow content; they must stay
  under the gates).

### Sweep — hand-rolled overlays migrated

| Site | Before | After |
|---|---|---|
| Every proto `Modal` (~24 files) and `ConfirmDialog` (~21 files) | in-tree, z 1000, WebKit body 0 px | `Overlay` → `<body>`, body `flex 1 1 auto / min-height 0`, head/foot pinned |
| PM roadmap · *Add projects to this initiative* | hand-rolled `.card` face, z 120 | `Modal` (380 px); empty state *No projects yet — Go to Projects* |
| CRM deals · *Save view* | hand-rolled `.card-glass` z 1000 | `Modal` with Cancel / Save footer |
| CRM deals · mobile *New deal* bottom sheet | hand-rolled z 100 | `Overlay align="end"` (no blur) |
| PM teams · *New team* | hand-rolled z 1150 | `Modal` (420 px) |
| PM team settings · *Make private?* | hand-rolled z 1150, closed optimistically | `ConfirmDialog` with a real loading state (scoped to that write) |
| PM workspace · *Reset local data?* | hand-rolled z 1150, closed before the reset ran | `ConfirmDialog`; closes after `engine.reset()` resolves, error toast |
| Invoicing payments · *Record a payment* picker | hand-rolled `.card` z 90 (translucent) | Radix `Dialog` — same family as the page's `PaymentModal` |
| CRM keyboard shortcuts (`?`) | in-tree z 1200 | `Overlay` 1200 |
| CRM quick add (`N`) | in-tree z 1100 | `Overlay` 1100, top-aligned; in-card dropdowns unchanged |
| Inbox first-run tour | in-tree z 1150 | `Overlay` 1150 |
| CRM search palette (`/`, ⌘K) · PM command palette (⌘K) | in-tree z 200 | `Overlay` 1250, top-aligned |
| PM keyboard shortcuts (`?`) | in-tree z 200 | `Overlay` 1200 |
| Profile / Settings · *Update photo* / *Update company logo* (`MediaCropModal`) | in-tree z 960 | `Overlay` 960, dim .7 |
| Blocking gates: billing wall, consent *Manage choices*, terms re-acceptance | 850 / 950 / 990 — **below** the overlay band once overlays portal | **1350 / 1360 / 1390** — above every overlay, below `--z-float`. The non-blocking consent strip stays at 900, under a dialog's scrim. |
| Trust-device prompt (Radix, z 50) | a proto overlay opening above it counted its first click as an outside click and silently discarded the prompt | `onInteractOutside` prevented — only *Not now* / *Yes* / Escape close it; it also waits for an **unlocked** workspace so the billing wall (which, like the re-acceptance gate, now re-arms its own pointer events under a Radix body lock) is never left visible but inert above it |
| Any Radix dialog | a click on an error toast (z 2000) closed the dialog and lost the form | toast clicks are never "outside" clicks (`ui/dialog.tsx`) |

Left alone, on purpose: `ReacceptanceGate`, `BillingGate`, `ConsentBanner`
(layout-level, outside `<main>`, own pointer-events contract), the
recurring-invoices drawer (already portals), the Topbar dropdown (Radix), and
the two bottom sticky bars inside `z-index: 1` shells (invoicing settings save
bar, CRM deals bulk bar — checked live, they do not clip).

Data-dependent bodies: the CRM merge "clear activities" confirm showed an
empty body until the count arrived (now *Counting activities…* / an error
line), and the employee Remove confirm gains an error branch. Two dropdowns
inside dialogs (`ItemModal`, `InvoiceEditor`) used `.glass` (a backdrop-filter
inside the dialog card) and now use the opaque `.modal-card` face.

## 4. Fix B — self-service Edit profile (+ Last sign-in, Sign out other devices)

### Root cause

`app/(app)/profile/page.tsx` rendered the *Edit profile* button with **no
`onClick`** (never wired since the page was built), loaded no employee record,
and its *Sign out other devices* button was dead too; *Last sign-in* printed
`new Date()`. On the API, `PUT /employees/me` existed but only wrote
`users.phone` and ignored address / emergency contact; nothing on the web ever
called it.

### API (`apps/api/src/modules/employees`, `auth`)

- `employees.dto.ts`: `SelfUpdateEmployeeDto { personalPhone?, personalEmail?, currentAddress?: SelfAddressDto | null, emergencyContact?: SelfEmergencyContactDto | null }` — nested classes carry `@Type` + `@IsObject` (house rule 5), every nested property is decorated (the global whitelist strips undecorated keys), `''` clears, a phone must match `/^\+?[0-9][0-9 ().-]{6,29}$/`, `{ firstName }` and friends are refused with 400.
- `employees.service.ts selfUpdateEmployee(userId, dto, tenantId)`: one `withTenant` transaction — active membership → employee (`tenant_id`, `deleted_at IS NULL`) or **404 "No employee record is linked to your seat — ask HR"**; trims, lower-cases the email, merges the address over the saved JSON (country and unknown keys kept; blanking every line stores `null`, not a country-only blob); the primary emergency contact is looked up `ORDER BY created_at ASC LIMIT 1` (the same ordering is now applied to the onboarding upsert and to `getEmployee`'s list, so two accidental primaries can no longer flip between reads), updated in place or inserted, `null` deletes it; after commit an `employee.self_updated` audit row names the sections changed — never the values.
- **Peer redaction** — `redactForViewer(record, viewer)` (exported, pure) applied in `GET /employees/:id` only. Unless the viewer is the person, their direct reporting manager (role `manager`), or owner / admin / finance / FAM, the response nulls personal email/phone, both addresses, DOB, marital status, blood group, Aadhaar last-4, PAN/passport flags, every bank field, PF UAN, ESIC, gender, nationality, custom fields **and the this-month attendance numbers**, and returns no emergency contacts and no leave balances (the same rule `GET /attendance/employee/:id` already enforced). `GET /employees/me` and internal callers are unchanged.
- `auth.service.ts logoutOthers(userId, currentDeviceId?, currentRefreshToken?)` + `POST /auth/logout-others`: revokes every live refresh token whose device is not the current one and whose hash is not the current cookie; 400 if neither identifier is present (never degrades into sign-out-everywhere); returns `{ revokedDevices }` (distinct devices; rows without a device id count as one); writes a `logout` auth event with `other_devices: true`. Cookies are not cleared.
- **Refresh-token reuse cascade narrowed, rotation made atomic.** The refresh handler used to treat *any* revoked token as a reuse attack and revoke the whole user — so the stale tab on a device you had just signed out would, on its next silent refresh, sign **you** out too. Now only a replayed *rotated* token trips the cascade; a token revoked by logout / sign-out-others gets a plain 401 *"Session has ended — sign in again"* **and still writes a `token_revoked` auth event** (`reason: revoked_token_presented`) so a stolen token replayed after sign-out stays visible. Rotation itself became **one conditional write**: the new pair is minted first, then the old row is retired with `UPDATE … SET revoked_at, rotated_to WHERE id = old AND revoked_at IS NULL`; zero rows means another presentation of the same token won the race, so the just-minted pair is deleted and the cascade fires — two concurrent presentations of one token can no longer both succeed, and there is no window in which a replay goes unnoticed. Pinned in the spec both ways.
- **Identity documents follow the same rule.** `GET /employees/:id/documents/:docId/url` (unused by the UI while Documents is *Coming soon*) handed a signed URL to any member; it now applies the personal-block predicate (self / reporting manager / owner-admin-finance-FAM) and refuses everyone else.
- `getMe` returns `lastLoginAt`.

**`users.phone` is no longer written by self-service.** `users` is a
platform table (no `tenant_id`): a write there changes the person's phone in
*every* workspace they belong to, and nothing renders it. `employees.
personal_phone` is the single owner of the personal phone from this round.

### Web

- `components/profile/EditProfileDialog.tsx` (Radix dialog, proto buttons,
  native selects): read-only *Managed by HR* block, then Personal phone,
  Personal email, Current address (line 1/2, city, state list, PIN), Emergency
  contact (name, relationship, phone, email, *Remove contact*). Sends only the
  sections that were touched; *Profile updated* toast.
- `app/(app)/profile/page.tsx`: the button opens the dialog (disabled with
  *"No employee record is linked to this seat — ask HR"* for a seat without an
  employee row); the Account card shows the four contact rows; *Last sign-in*
  is the real `lastLoginAt`; *Sign out other devices* → confirm → *Signed out N
  other device(s)*.
- Hooks: `useSelfUpdateEmployee()` (writes `['employees','me']` back, invalidates
  `['employees']` + `['auth','me']`), `useLogoutOthers()`, `MeResponse.lastLoginAt`.

## 5. Fix C — regularization deep link

### Root cause

`attendance.service.ts` linked the manager to `'/team/attendance'` — a
Round-14 stub that server-redirects to `/attendance`, the viewer's **own**
daily log (the My/Team toggle is local state and cannot be deep-linked). The
email button was a bare `/inbox`. Inbox → Approvals lists regularizations but
had no deep-link support and only saw the dashboard overview's **top 5 rows
per kind** — a 6th pending request was unreachable anywhere. Leave
(`/team/leave?request=`, Round I) and timesheets already did this right.

### API

- `attendance.service.ts`: optional `ConfigService` + `appUrl()` (same pattern as leave). The manager's in-app notice links to `/inbox?tab=approvals&request=<id>`; the email gets `reviewUrl`. Decision notices link the employee to `/attendance?date=<YYYY-MM-DD>`; the email gets `attendanceUrl`. Self-approval is now also blocked through the membership bridge (an employee row with `user_id NULL` linked only via `memberships.employee_id`); the same bridge resolution keeps a bridged applicant out of their own reviewer fan-out and gives a bridged *manager* their in-app bell (they used to get email only).
- `notifications.service.ts`: the three regularization templates escape every interpolation; *Review request* points at `reviewUrl` (fallback `/inbox?tab=approvals`) with the leave-style *"Nothing changes until you confirm in the app"* line; approved / rejected mails gain *Open attendance*.
- `dashboard.service.ts getAdminOverview(…, { pendingLimit })`: the pending leaves / regularizations **lists** honour `?pendingLimit=` (clamped 1–50, default 5); counts, scope and the own-request exclusion are untouched. Regularization rows now carry `proposedInTime` / `proposedOutTime`.

### Web

- `/inbox?tab=approvals&request=<id>` — `ApprovalsTab` selects and highlights
  the row (rows carry `data-request-id` / `data-kind` / `aria-selected`),
  scrolls it into view, resets the filter to *All*; a request that is not in
  the viewer's queue (already reviewed, or another manager's team) toasts *"That
  request isn't waiting on you — it may already be reviewed, or it belongs to
  another manager's team"* and the URL is scrubbed; the URL is also scrubbed
  after Approve / Reject. The regularization detail shows the proposed in/out
  times and *View {first name}'s attendance →* (`/employees/<id>?tab=attendance`).
  The Inbox asks the overview for up to 50 pending rows per kind; the
  dashboard keeps 5. Presence lookups are capped to the first 40 rows.
- `/employees/<id>?tab=…` — the 360° page honours the tab in the URL.
- `/attendance?date=YYYY-MM-DD` — opens that month (clamped to the current
  month) and highlights that Daily-log row; `?view=team` selects the team
  toggle for approver roles.
- `/team/attendance` — client redirect, role-aware: owner / HR admin / manager
  → `/inbox?tab=approvals`; everyone else → `/attendance` (old stored
  notification rows keep working).

## 6. Regression spec — `apps/api/src/__tests__/founder-roundK.spec.ts`

25 pins (real Postgres, `dbAdmin` seeds, unique suffixes, cleanup in
`afterAll`), grouped **Fix C** / **Fix B**:

- Manager in-app link `/inbox?tab=approvals&request=<id>` + email `reviewUrl`
  (owner-without-manager fan-out gets the same link, never themselves); a
  **bridged applicant** (employee row with `user_id NULL`, seat linked only
  through the membership) is never asked to review their own request, and a
  **bridged manager** still gets the in-app ping.
- Rendered *requested* template: escaped `reviewUrl` href, `<script>` reason
  escaped, fallback href without `reviewUrl`; decision notices
  `/attendance?date=<d>` + `attendanceUrl`, both decision templates carry
  *Open attendance*.
- Self-approval blocked through the membership bridge (`employees.user_id`
  NULL) for approve and reject alike.
- Overview `pendingLimit: 50` lists all 7 pending regularizations for the
  manager while the default stays 5 (same scope, same order).
- `selfUpdateEmployee`: trimmed phone, lower-cased email, address merged
  across two calls with `country` + unknown keys kept, `''` clears one key,
  `null` = unchanged, **blanking every line stores `null`**; emergency contact
  insert → same-row update → `null` deletes; with two pre-existing primaries
  the **oldest** is the one read and written; `users.phone` untouched; T2
  caller → 404; seat without an employee row → 404 with the HR message; RLS:
  a T2 connection sees no T1 emergency contacts; audit row
  `employee.self_updated` names sections only.
- The real `ValidationPipe` config: nested `currentAddress.line1` intact;
  `{ firstName }`, `{ currentAddress: [] }`, `{ currentAddress: { foo } }`,
  `{ personalEmail: 'nope' }`, a 5-digit phone → 400; `currentAddress: null`
  accepted.
- `redactForViewer`: a peer gets the personal block nulled, no emergency
  contacts, **no leave balances, no this-month numbers, no gender /
  nationality / custom fields / PF-ESI flags**; the reporting manager (role `manager`),
  owner and the person see everything; a reporting manager whose seat role is
  `employee` does not.
- `logoutOthers`: keeps the current device and the cookie-matched
  `device_id NULL` row, revokes the rest (two rows on one device count once,
  expired / already-revoked / foreign rows untouched), 400 with no
  identifier, idempotent; **a signed-out device's stale refresh is a plain
  401 that leaves the current device signed in (and writes a
  `revoked_token_presented` audit event), while replaying a rotated token
  still revokes every session**; `getMe.lastLoginAt`.

## 7. Gate + live verification

| Check | Result |
|---|---|
| `pnpm -F api typecheck` · `nest build` | clean |
| `pnpm -F api test` (full, real Postgres) | **854 / 855** — the one failure is `attendance-selfheal` › *clock-in clears "Appear offline"*, the suite CLAUDE.md documents as flaking near IST midnight (run at 02:16 IST: the punch stamps the tenant-zone date while presence looks the open punch up by the UTC date). Round K touches none of the punch / presence path. |
| `founder-roundK.spec.ts` | 25 / 25 |
| `pnpm -F api lint:boundaries` | no violations (330 modules) |
| `pnpm -F web typecheck` · `pnpm -F web build` | clean |
| `scripts/diagnose-rls.sh` | `connected_as = flicks_app`, `leak_with_bogus_context = 0`, no tenant table without RLS |
| Adversarial review | 3 implementers + 9 read-only reviewers (correctness / security / UX per fix) + a final security pass over the orchestrator's follow-ups; every finding above *nit* is fixed and pinned (§3 sweep table, the refresh-cascade note in §4, the freshness gate in §5). |

Live (`scratchpad/verify-roundK.mjs`, headless Chromium against the
production web build + the API; screenshots `rk-*.png`):

1. **Overlay sweep** — Delete invoice, Delete client, Record-a-payment picker
   (Radix), New team, CRM keyboard shortcuts, Save view, the Inbox tour,
   Change photo and the roadmap *Add projects* dialog: each one's scrim and
   root are direct children of `<body>`, the scrim covers the whole viewport
   at the same z as the root, no ancestor of the card has a backdrop-filter,
   the proto body has a real height with computed `flex-basis: auto` and
   `min-height: 0`, the footer buttons are inside the viewport, hit-testing
   over the sidebar and topbar resolves inside the overlay, and a
   screenshot-diff of the sidebar with the dialog open vs closed differs
   (the dim + blur are live). A 1200×300 viewport keeps the Delete-invoice
   footer on screen with the body scrolling inside 90 vh.
2. **Edit profile** — the HR block is plain text; phone / email / address /
   emergency contact save, show on the Account card, survive a reload and
   match `GET /employees/me` (trimmed, lower-cased); `users.phone` stays
   NULL; the audit row names sections only; a seat without an employee row
   gets the explanatory toast + hint and a 404 with the HR message from the
   API; a peer fetching the employee gets the personal block nulled while the
   manager and the owner see it; `{ firstName }` → 400.
3. **Regularization** — the manager's bell entry links to
   `/inbox?tab=approvals&request=<id>`; clicking it lands on Approvals with
   the row selected and ringed, proposed in/out shown, *View Asha's
   attendance →* opens the 360° Attendance tab; back → Approve → URL scrubbed;
   the employee's notice links to `/attendance?date=<day>` and opens that
   month with the row highlighted.
4. **Queue depth + guards** — six pending requests under one manager: all
   six listed, the sixth deep-linkable (`overview` default 5 → `pendingLimit`
   50 → 6); another manager's request and a random id toast *"That request
   isn't waiting on you"* and scrub; `/team/attendance` sends the manager to
   Approvals and the employee to their log.
5. **Sign out other devices** — the second device's refresh returns 401, the
   first device's session survives, *Last sign-in* shows the real time.

Not driven here: **Safari**. No WebKit build exists on the box; the fix is
structural (§3) and the founder is asked to confirm in §8.

## 8. What the founder should do

1. **Confirm on Safari:** Invoicing → Invoices → *Delete* on any draft. The
   dialog must show the warning text and the *Cancel* / *Delete* buttons, and
   the sidebar + top bar must be dimmed behind it. (Same for Delete client,
   Record payment, Create team, Save view, Change photo — any dialog.)
2. **My profile → Edit profile:** change a personal phone / address / emergency
   contact and save; the Account card updates immediately. Name, work email,
   designation and role are read-only there by decision.
3. **Ask Ranjith to file a regularization** (Attendance → Daily log →
   Regularize) and click the notification: it opens Inbox → Approvals with his
   request selected; *View Ranjith's attendance →* opens his history.
4. Nothing to run in Supabase this round — **no migration**.

## 9. Follow-ups (not blocking)

- `Overlay` has no Escape-to-close or body scroll-lock (no proto overlay had
  them before; adding them is a behaviour change for 45+ sites — a small
  follow-up once wanted).
- Migrate the three layout gates to `Overlay` for one overlay family.
- Auto-generated meeting links (Round J's Integrations door) — unchanged.
