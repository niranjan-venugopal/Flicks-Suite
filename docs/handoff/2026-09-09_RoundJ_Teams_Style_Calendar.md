# Round J — The Teams-style calendar (events, meetings, team availability)

**Date:** 2026-09-09 · **Type:** feature build on top of Round I · **Migration:** `0061` (**must be applied in Supabase — see §7**)
**Reported by:** founder — *"can we switch back to the calendar without these dot
things? With actual information of team leave or holidays or meetings etc, like
a Microsoft Teams calendar, with options to create an event or schedule a
meeting with a Teams Meeting link or a Google link (which can be integrated
later with the Teams / Google Meet account of the user so it can auto-generate
the link)."* Standing rule: *"no leakage of data at any point."*

## 1. What the founder gets

`/calendar` is a real calendar now — Week (default), Day, Month and Agenda
(the phone layout) — with titled chips and blocks instead of anonymous dots:

| Source | Who sees it | Colour |
|---|---|---|
| **Holidays** (company-wide + the viewer's own location) | everyone | yellow |
| **My leave** (any status; pending is marked) | the person | blue / leave-type colour |
| **Team leave** (approved only, name + leave-type code, **never the reason**) | *teammates + reports + manager* (founder decision, §2) | purple |
| **Meetings & events** (new) | organizer, attendees, or everyone when the organizer picks *Everyone in workspace* | green / event colour |
| **Birthdays & work anniversaries** | same scope as team leave, plus yourself | coral / purple / green |
| **My CRM calls & meetings** | the assignee, only with CRM access | blue |

Plus: a **New** button (*New event* / *Schedule meeting*), **click any empty
slot** to start a 30-minute meeting there, a Linear-style composer (title,
agenda, start/end or all-day, attendees from the workspace directory, location,
meeting link with a **Teams / Google Meet / Other** picker, *Attendees only* /
*Everyone in workspace*), a detail card with **Join** (opens the pasted link),
attendee reply dots, **Accept / Tentative / Decline**, Edit and Cancel; invite,
change and cancellation notifications in-app **and by email with an `.ics`
invite attached** (adds the meeting to Outlook / Google Calendar); live refresh
of everyone's calendar over the existing notifications socket; the personal
**Subscribe (iCal)** feed now carries meetings too; and **Settings →
Integrations** with two honest *Coming soon* cards (Microsoft 365, Google
Workspace) — the door for auto-generated links.

## 2. Founder decisions (asked and answered) and the defaults taken

| Question | Decision |
|---|---|
| Who sees whose leave? | **Teammates + reports.** Everyone sees approved leave of people who share their manager (and the manager); managers also see their direct reports; owner / HR admin see the whole workspace. Pending leave stays private to the person + approver. Names and leave-type code only — never the reason. |
| Meeting links | **Pick the provider, paste the link now.** Teams / Google Meet / Other / None. A provider without a link is allowed ("link pending", organizer sees *Add link*). Auto-generation arrives once a Microsoft 365 / Google account is connected (Settings → Integrations, coming soon). |
| Who can schedule? | **Any member can create events and invite any workspace member.** Only the organizer (or owner / HR admin) edits or cancels. Guests and auditors never see the calendar. |
| Extra sources | **CRM calls & meetings (own), birthdays & work anniversaries, holidays.** Project due dates: not this round. |

Defaults I took (flag if you want them different): new events are **Attendees
only** with a one-click *Everyone in workspace* switch · cancelling removes the
meeting from every calendar and notifies attendees · attendees are workspace
members only (no external e-mail invitees yet) · no recurring meetings yet ·
Week view on desktop, Agenda on phones · a new meeting defaults to 30 minutes ·
the week starts on the workspace's *Week starts on* setting (Settings →
General) and working hours are tinted from Settings → Working hours.

## 3. Data model — migration `0061_calendar_events.sql`

`calendar_events` (created by 0001 as a never-written projection cache) is
extended in place and becomes the record for user-authored events; a child
table holds attendees. No enum changes: user rows use `event_type =
'company_event'` and the real kind lives in a new text column.

- `calendar_events` += `kind` (`event` | `meeting`), `organizer_user_id`,
  `location`, `timezone` (authoring zone), `meeting_provider`
  (`none` | `teams` | `google_meet` | `other`), `meeting_url`, `created_by`,
  `updated_by`, `updated_at`, `cancelled_at` (soft cancel); check constraints
  on kind / provider / `end_at > start_at`; partial indexes
  `idx_calendar_events_tenant_range (tenant_id, start_at, end_at) WHERE cancelled_at IS NULL`
  and `idx_calendar_events_organizer`.
- **New** `calendar_event_attendees` (`event_id` → cascade, `user_id`,
  `is_optional`, `response` `pending|accepted|declined|tentative`,
  `responded_at`, unique `(event_id, user_id)`), indexes by user and by event.
- `idx_leave_requests_tenant_range (tenant_id, start_date, end_date)` — the
  week/day views range-scan leave on every navigation.
- Both tables: ENABLE + FORCE RLS, `tenant_isolation_*` policy on
  `current_setting('app.tenant_id')`, grants to `flicks_app` (the 0037 DO-loop).
- **All-day rows store UTC midnights with an exclusive end** so their dates are
  timezone-independent; timed rows store real instants plus the authoring zone.
- Drizzle mirror: new `packages/db/src/schema/calendar.ts` (enums + table moved
  out of `leave.ts`, every index mirrored by name so drizzle-kit never proposes
  dropping them); `packages/shared/src/constants` gains `MEETING_PROVIDERS`,
  `ATTENDEE_RESPONSES` and four `calendar.event.*` domain events.

## 4. API — `apps/api/src/modules/calendar/*` (rewritten)

Routes (`/api/v1/calendar`, no module grant — HRMS-core like leave; guests are
refused by `GuestScopeGuard`, auditors in-service with 403):

| Route | What |
|---|---|
| `GET events?from&to` | the unified feed (inclusive YYYY-MM-DD range, ≤ 93 days) → `{ data, prefs, sources }` — `prefs` = workspace timezone, week start, working days / hours; `sources.crm` tells the UI whether to offer the CRM toggle |
| `GET events/:id` | detail with attendees; **404 unless visible to the caller** |
| `POST events` | create (validation below) |
| `PATCH events/:id` | organizer / owner / HR admin only (403) |
| `DELETE events/:id` | soft cancel, idempotent, attendees notified |
| `POST events/:id/rsvp` | attendee only (403), refused once cancelled (400) |
| `GET people?q=` | invitable members — active seats, no guests / auditors / deactivated, ILIKE with `%`/`_` escaped, signed avatars |
| `GET me/ical-url`, `GET me.ics` | unchanged signatures; feed extended (§6) |

**Scope rules (all inside one `withTenant` transaction, explicit `tenant_id`
on every read; the viewer's membership/employee row is resolved *inside* the
transaction — the old `dbAdmin` lookup is gone and a seat without an employee
row no longer throws):**

- `availabilityScope(viewer)` — org-wide roles (`owner`, `admin`, `fam`,
  `super_admin`) → everything; an employee → `reporting_manager_id = me OR
  reporting_manager_id = my manager OR id = my manager`; no employee row →
  nothing. Applied to team leave (approved, `employees.deleted_at IS NULL`,
  `user_id IS DISTINCT FROM me`) and to birthdays / anniversaries (+ self).
- Events are visible when the caller is the organizer, an attendee, the
  visibility is `company`, or the caller is org-wide (`visibleEventPredicate`).
- CRM calls & meetings come through the CRM facade
  (`CrmPublicService.listMyScheduledActivities` → `ActivitiesService.listMyScheduled`:
  tenant, `assignee_user_id = me`, `type IN (call, meeting)`, not deleted),
  fetched **after** the tenant transaction and only when
  `ModuleAccessService.resolve(..., 'crm')` is not `none` — the same
  resolution `CrmGrantGuard` makes.
- Holidays are company-wide plus the viewer's own location (`meta.blocking`
  false for optional / restricted types).

**Writes:** every invitee id from the DTO is existence-checked in-tenant
(`memberships` active, role not guest / auditor) before anything is inserted —
FK checks bypass RLS (house rule 2); the organizer is auto-inserted as an
`accepted` attendee; the domain event is published **inside** the transaction
(a failed outbox write rolls the whole create back — pinned); after commit:
audit row, `eventEmitter.emit('calendar.changed')` → the notifications gateway
pushes `calendar_changed { eventId }` to the `tenant:<id>` room (id only —
nothing a member may not see travels over the room), and best-effort
notifications. Validation: end > start; timed ≤ 14 days, all-day ≤ 31 days;
`timezone` must be a real IANA zone (400), defaults to the workspace zone;
`teams` links must point at `teams.microsoft.com` / `teams.live.com`,
`google_meet` at `meet.google.com`, https only; `none` + a link becomes
`other`. `MeetingLinksService.generate()` runs **before** the transaction
(house rule 7 — no network inside a tx) and returns `null` until a provider is
connected; `meeting-links.service.ts` documents the `MeetingLinkProvider`
interface Round K will register Microsoft / Google against.

**Notifications** (`notifications.service.ts`): events `calendar_invited`
(in-app + email), `calendar_updated` (in-app), `calendar_cancelled` (in-app +
email) with preference defaults and Settings rows under a new *Calendar* group;
templates `calendar-invite` / `calendar-updated` / `calendar-cancelled` (every
value HTML-escaped, **Join** button only when a link exists, times rendered in
the **recipient's** timezone via the new shared `core/common/time.ts`
`formatRangeInTimezone`, plain-text subject); `sendEmail` gained `attachments`
and the invite carries `invite.ics` (`METHOD:REQUEST`,
`text/calendar; method=REQUEST`). Update notifications are a **delta**: added →
invited, removed → "removed you from", kept → "updated" only when time / place
/ link / title changed (a description-only edit tells nobody). RSVPs notify the
organizer in-app (grouped per event).

## 5. Web — `components/calendar/*` (new), `lib/api/queries/use-calendar.ts` (rewritten)

- `CalendarShell` — URL state `?view=&date=` (canonicalised on load, survives
  reload, shareable), `useCalendarFeed(range)` with `keepPreviousData` so
  paging weeks never blanks the grid, legend toggles persisted per browser
  (`localStorage['calendar.filters']`), the **deep link**
  `?event=<id>&date=` the invite notification / email lands on (opens the
  detail; a cancelled or invisible event toasts and scrubs the URL), the
  toolbar (round prev / next, Today, month-year chooser on the title,
  Day / Week / Month / Agenda), a 256 px rail (mini month + legend) that
  hides under 1180 px, the composer, the cancel confirm and the iCal dialog.
- `WeekGrid` (Day = 1 column) — sticky day header + all-day lane, 24-hour
  scroller opened on the working morning, working-hours tint, today column,
  live now-line, lane-packed blocks (`layoutDay`), **click an empty slot → new
  30-minute meeting there**. `MonthGrid` — honours *Week starts on*, three
  chips + "+N more" → Day. `AgendaList` — date-grouped, the phone layout.
- `EventChip` (chip / block) owns the detail popover; `EventDetail` — kind
  pill, when (viewer's zone) + duration, location, organizer, Join /
  "link pending · Add link", attendees with reply dots, RSVP segmented,
  Edit, Cancel. Read-only sources get a compact card with their own link
  (leave page, deal, employee profile for roles that may open it).
- `EventComposer` — clone of the Round-E issue composer skeleton: Event /
  Meeting switch, borderless title, auto-grow agenda, Start / End
  `DateTimeField` pills (End follows Start, duration preserved), All day
  toggle → `DateField` pair, **Attendees** pill with a search box over
  `GET /calendar/people`, Location, Visibility pill, **Meeting link** panel
  (None / Teams / Google Meet / Other + URL with the host rule mirrored
  client-side and the "generate automatically once … is connected — Settings →
  Integrations (coming soon)" hint behind `FEATURES.calendar_meeting_links`),
  ⌘↵ submit. Times are authored in the browser's zone and sent as instants
  plus the zone.
- `lib/hooks/use-is-mobile.ts` (lifted from the deals board; `useMediaQuery`
  too), `NotificationsSocket` reacts to `calendar_changed` by invalidating the
  `['calendar']` query tree, Inbox + bell show a calendar icon for
  `calendar.*` notices, Settings → Notifications gains the Calendar group,
  Settings → **Integrations** page + nav row, PostHog events
  `calendar_event_created` / `calendar_view_changed` / `calendar_rsvp`, the
  manager dashboard's **Team calendar** button opens `/calendar?view=week`.
- Removed: `components/attendance/MonthCalendar.tsx` (the dots) — nothing
  else referenced it. The dashboard `TodaysSnapshotCard` reads the new feed
  shape with local dates.

## 6. iCal feed

`GET /calendar/me.ics` now carries the subscriber's meetings and events
(organized or attending, declined and cancelled excluded) as UTC VEVENTs with
`LOCATION`, `URL`, `ORGANIZER;CN=`, `ATTENDEE;CN=;ROLE=;PARTSTAT=`, RFC 5545
75-octet line folding, the workspace `X-WR-TIMEZONE`, holidays scoped to the
subscriber's location (previously every location's), and members without an
employee row (an owner seat) can subscribe — they get holidays + events.

## 7. Deploy — **the founder must run `apply-0061.sql` in Supabase**

1. Supabase → SQL editor → paste `docs/handoff/apply-0061.sql` → Run (idempotent,
   safe to re-run; ~1 s).
2. Railway auto-deploys from `production`; the API inserts into the new columns
   on the first "New event", so run the SQL before or right after the deploy.
3. Nothing else to configure. No new environment variables.

Verify afterwards: open `/calendar` as any member — the week grid renders with
holidays / leave chips; **New → Schedule meeting** creates a block; the
invitee's Inbox shows the invite; `GET /api/v1/calendar/events?from=…&to=…`
returns `{ data, prefs, sources }`.

## 8. Gate + verification

- `pnpm -F api typecheck` · `nest build` · **full jest 831 / 831 (67 suites)**
  · `lint:boundaries` (330 modules, no violations) ·
  `pnpm -F web typecheck` · `pnpm -F web build` · `diagnose-rls.sh` →
  `leak_with_bogus_context = 0`, both new tables RLS-forced.
- **`founder-roundJ.spec.ts` — 36 pins** against the real Postgres: migration
  0061 landed (indexes, forced RLS + policies, `flicks_app` grants, check
  constraints); the availability scope for owner / manager / teammate /
  other-team / no-employee seats; pending leave private; reason never
  serialized; holidays location-scoped with the blocking flag; birthdays and
  anniversaries (joining year skipped, years counted, profile links by role);
  CRM items only for the assignee with CRM access; range limits; guests /
  auditors 403 and the guest path allowlist; create happy path (rows,
  organizer auto-accepted, domain event inside the tx, invites with `.ics`,
  tenant push, organizer not notified); private vs company visibility;
  cross-tenant / guest / auditor / deactivated invitee → 400 with nothing
  written; every validation rule; all-day storage identical for an
  Asia/Kolkata and an America/Los_Angeles viewer; outbox failure rolls back;
  RSVP transitions + organizer notice; edit permissions; delta notifications;
  cancel (soft, idempotent, feed excludes, RSVP/edit refused after); notifier
  failure never fails the write; tenant isolation for read / edit / cancel /
  RSVP and an RLS select from the other tenant; people picker filters and
  ILIKE escaping; iCal token round-trip + rendering rules; template escaping;
  the timezone helper; the global ValidationPipe keeping nested attendees and
  rejecting unknown keys.
- Re-run green: `founder-roundH`, `founder-roundI`, `leave-notify`,
  `holidays-locations`, `founder-round13`, `crm-activities`,
  `crm-automation`, `multi-tenant`, `pm-sync` (200 tests).
- **Live (production build :3001 + API :4000, `verify-roundJ.mjs`)** — week
  view default with holiday / team leave / birthday chips and no dots,
  Month / Day / Agenda + URL state through a reload; slot click → composer
  prefilled 10:00–10:30 → Teams meeting with two attendees → block + detail;
  the invitee's Inbox row → deep link → Accept, and the organizer's open tab
  updates to *2 accepted* without a reload; a member on another team never
  sees the private meeting, the leave or the birthday and their deep link
  toasts + scrubs; Edit moves the meeting (attendee told), Cancel → confirm →
  gone for both; API probes (cross-tenant attendee 400, guest 403, RSVP by a
  non-attendee refused, `me.ics` carries the fresh meeting with `DTSTART…Z`
  and `LOCATION`, CRM meeting for the manager only); Google Meet without a
  link → *link pending* + Add link; Settings → Integrations; phone agenda +
  composer; manager dashboard **Team calendar** → `/calendar?view=week`.
  Screenshots `rj-1…rj-14`.

## 9. Follow-ups (not this round)

- **Microsoft 365 / Google OAuth** (auto-generated Teams / Meet links,
  Outlook / Google Calendar sync) — register providers on
  `MeetingLinksService`; template: `connected_email_accounts` self-visibility
  RLS in 0035, `AppCryptoService` purpose key; then flip
  `FEATURES.calendar_meeting_links`.
- Recurring meetings, external e-mail attendees, drag-to-create / resize,
  true multi-day spanning bars in Month view, project due dates as a source,
  the Redis socket.io adapter (live push is single-instance today).
- `TodaysSnapshotCard.tsx` is unreferenced (kept, updated to the new feed shape).
