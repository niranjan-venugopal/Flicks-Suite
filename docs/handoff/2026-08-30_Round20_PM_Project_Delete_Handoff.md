# Round 20 handoff — deleting a project, and taking its issues with it

**Date:** 2026-08-30 · **Branch:** `claude/handoff-patch-deploy-0g4sp6` → `main` + `production`
**Migration to apply:** **`0056_pm_project_delete_cascade.sql`** (idempotent, additive).
**Gate at handoff:** api typecheck ✓ · api build ✓ · boundaries ✓ (324 modules) ·
web typecheck ✓ · web build ✓ · full jest ✓ · RLS `leak_with_bogus_context = 0` ✓ ·
live Chromium pass ✓

Read after `2026-08-30_Round19_FAM_Console_Nav_Role_Audit_Handoff.md`.

## The ask

> "There should be an option to delete a project in project management as well."

and, once the consequences were put to the founder:

> "Delete them with it. and if the guest also loses the project data once its
> completely deleted like in 30 days. Issues dont survive without a project."

## What already existed (and what the first read got wrong)

`POST /pm/projects/:id/delete` → `projects.service.softDelete` has been there
since PRD v6, along with `POST /pm/projects/:id/restore`, matching
`project.delete` / `project.restore` sync ops, and a **Recently deleted** list
with Restore and Purge at `/pm/settings/workspace` that already handled
projects. An early note in this session said restore was unexposed — it was not;
only the **delete entry point** in the project screens was missing.

So: no new Deleted tab, no new restore surface. One button, and the correctness
work underneath it.

## Why the button could not just be wired up

An eight-dimension audit of every surface a project delete touches found the
delete was safe to *call* and unsafe to *offer*. The blockers, in the order they
mattered:

### 1. The issues survived the project

`softDelete` stamped `pm_projects.deleted_at` and stopped. Every issue in the
project kept `deleted_at NULL`, so it stayed live in `/pm/issues`, My Issues,
Triage, PM search, the sync bootstrap and the delta — pointing at a project that
no longer existed. Six read paths, none of which joined `pm_projects`.

Fixed by cascading in the one place instead of teaching six queries to join:
`softDelete` now stamps every live issue in the project inside the same tenant
transaction. Search, Triage, My Issues and both sync paths are correct for free,
because the issues carry their own `deleted_at`.

**`deleted_with_project_id` (migration 0056)** marks the issues *this* delete
took. It is what makes restore precise: an issue the user had deleted by hand
before the project went stays deleted when the project comes back. No FK on
purpose — the 30-day purge hard-deletes the project, and `ON DELETE SET NULL`
would erase the marker mid-purge.

### 2. The delete had no authority check at all

The only guard was `assertProjectAccess`, which asks *"is this project in your
readable set"* — a **visibility** test, not an authority one. Any non-guest
member could destroy any project they could see, while deleting a mere *team*
already required `@Roles('owner','admin')`.

The bar is now `assertMayDeleteProject`: **manager and above, or the project's
own lead** — the initiative bar (`assertInitiativeRole`) plus the lead, so an
employee who runs a project can retire it instead of being stuck with something
only someone else can remove (house rule 8).

It is enforced **inside the service, not with `@Roles`**, because there are two
doors: the REST controller and the FSE sync mutation executor
(`sync/mutation-executor.service.ts` `case 'project.delete'`), which reaches the
same method through `/pm/sync/mutate` carrying no `@Roles` at all. A decorator
would have been bypassable by the app's own sync client. Both callers now pass
the role. Restore is held to the same bar.

### 3. Guests kept a deleted project forever

`guestScopeTx` built a guest's scope from `pm_project_members` with no join to
`pm_projects` and no `deleted_at` predicate. `pm_project_members` has no
`deleted_at` of its own, so an external guest kept receiving a deleted project's
issues, milestones and health-update bodies indefinitely — hidden from the
workspace's own team, still visible to an outsider. One `innerJoin` fixes it,
and restore puts the access back automatically because the row is only ever
filtered, never removed.

### 4. The purge detached issues instead of deleting them

`pm_issues.project_id` is `ON DELETE SET NULL`, so hard-deleting a project left
its issues alive as project-less rows. Both purge paths now delete the issues
explicitly first — the manual `purgeDeleted('project', id)` and the 30-day cron
— and the audit row records how many went, because after a hard delete nothing
can be counted. This is the founder's "issues don't survive without a project"
taken literally.

### 5. The offline engine's undo was lossy

`engine.deleteProject` applied an optimistic **tombstone**, which
(`store.ts applyTombstones`) purges the project's milestones, health updates,
team links, member links and initiative-lane membership — while the rollback
could only restore the project row from `inverse`. A delete the server then
rejected permanently stripped those rows from that browser. It now mirrors
`deleteIssue`: patch `deleted_at`, remove just the project row, and let the
authoritative delta tombstone do the full purge a moment later.

### 6. Restore came back half-dressed

`restore` published `sync: [{t:'pm_projects'}]` only, and the delta re-fetches
exactly what the refs name — so a restored project reappeared with no milestone
diamonds on Timeline and no team chips on the list until a full reload. The
event now names `pm_project_teams`, `pm_project_members` and every revived
issue. The delete event names every cascaded issue for the same reason: without
it, live clients kept rendering issues whose project had vanished.

### 7. Restore also had no audit row

The delete wrote one, the restore did not. Both halves of a destructive action
now appear in the log an Owner reads, with the project name and the issue count.

## What shipped in the UI

- **Projects list** (`pm/projects/page.tsx`): a trash button on the row,
  `stopPropagation`'d so it doesn't open the project — the same shape as
  `crm/companies/page.tsx`. Wired **twice**, because that page is two whole
  components: `SyncProjects` (the offline engine, optimistic, no spinner) and
  `RestProjects` (react-query, real round-trip). There is no shared PM data
  facade; that is the module's architecture, not an oversight.
- **Project page** (`pm/projects/[id]/page.tsx`): a trash button in the header,
  branching engine-or-REST exactly like the existing `patchProject`, then
  navigating back to the list — landing on this page's own "not found" state
  would have read as an error rather than success.
- The confirm names the project, **how many issues go with it**, and where to
  get it back: *"You can put it back for 30 days from Settings → Workspace →
  Recently deleted; after that it is gone for good."*
- The affordance only renders for someone the server would actually allow —
  `canDeleteProject` mirrors the service bar, on the UPPERCASE web side of the
  role split.

## Two defects the live run caught

Both were mine, and neither could have been caught by typecheck:

1. **The cascaded issues cluttered Recently deleted.** Deleting a 3-issue
   project produced four rows — the project plus its three issues, each with its
   own Restore, and restoring one alone would have resurrected an issue into a
   deleted project: exactly the orphan the cascade exists to prevent.
   `recentlyDeleted` now excludes issues carrying a `deleted_with_project_id`,
   and `issuesSvc.restore` refuses one directly with *"Restore the project to
   bring it back."*
2. **The first live run passed against a stale API.** `pnpm dev` has no watch;
   the cascade appeared to fail until the process was restarted. Worth
   remembering — it looks exactly like a real bug.

## Tests

`founder-round20.spec.ts`, 15 cases against the real Postgres: the cascade and
the row-level marker; a deleted project leaving the project list and its issues
leaving the issue list; restore returning **exactly** the cascaded set while a
hand-deleted issue stays deleted; the marker clearing so a second cycle starts
clean; recently-deleted listing the project and not its issues; a cascaded issue
refusing a solo restore while a hand-deleted one in a live project still
restores; purge destroying the issues rather than orphaning them; the guest
scope losing and regaining the project; the five permission cases (employee
refused, employee-as-lead allowed, manager allowed, guest refused, restore held
to the same bar); and both sync-ref payloads.

Full suite green with them.

## Live verification

`verify-r20.mjs` drives the real app end to end: the trash button on the row and
in the header; the confirm naming 3 issues and Recently deleted; the delete
removing the project and all three issues from the database and from both lists;
Recently deleted showing the project and **not** its issues; Restore bringing
back the project and all three issues; and a detail-page delete landing back on
Projects rather than a "not found" screen, with its 2 issues gone.

## Deploy checklist

1. **Apply `0056_pm_project_delete_cascade.sql` in Supabase.** Still pending
   from earlier rounds: **`0054`** and **`0055`**.
2. Deploy API + web.
3. Nothing to backfill — the column starts NULL, which is the correct value for
   every issue deleted before this round.

## Known follow-ups

- Deleting a project does not revoke its guest seats; the guests simply lose
  sight of it. If a project delete should also remove the guest membership
  (freeing the seat), that is a separate decision.
- `guests.service` list/revoke 404 on a soft-deleted project, so an admin cannot
  audit or revoke a deleted project's guests during the 30-day window.
- The production WebSocket upgrade (round 19) — infrastructure, not code.
- Migrations 0054 and 0055 still pending in Supabase.
