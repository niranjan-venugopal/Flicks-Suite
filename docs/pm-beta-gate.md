# PM Beta Gate — PRD v6 checklist (Checkpoint 5)

Run this list top to bottom before opening the module to beta users.
Sign-off starts the 2-week dogfood clock.

## Automated (all green in CI)

- [x] Full API suite (`pnpm -F api test`) — 432 tests incl. the isolation
      class in `multi-tenant.spec.ts` (every PM table), the FSE convergence/
      replay/horizon suite, the fake-clock cycle suite, the GitHub fixture
      chain, the importer round-trips, and the inbox digest suite.
- [x] Perf budgets @10k issues (`pnpm jest pm-perf`) — bootstrap < 2s
      (measured 869ms), delta < 150ms P95 (6ms), search < 200ms P95 (126ms).
      Client half from the spike gate: optimistic 1.6ms, propagation ~420ms.
- [x] `diagnose-rls.sh` leak = 0 · boundaries lint clean · web prod build.

## Drills (§22 — run once on staging before beta)

- [ ] **Kill-switch**: FAM → `pm_sync_engine` flag off → fresh session runs
      the SAME list on REST (yellow "rest" pill); flag back on → sync pill.
- [ ] **Reset local**: Projects → Settings → Workspace → Reset local data —
      re-bootstrap < 5s, no data loss.
- [ ] **Horizon re-bootstrap**: park a client past 90d of outbox retention
      (or delete its cursor's events) → next delta gets 410 → clean cold
      bootstrap (automated test also covers this).

## Product walkthrough (CP1–CP5 scripts in the testing guide)

- [ ] Two-window real-time convergence < 1s; offline queue replay.
- [ ] Board / filters / saved views / bulk bar / ⌘K / keymap.
- [ ] Projects + milestones + health updates; timeline drag; roadmap lanes.
- [ ] Cycles + Autopilot review; keyboard triage.
- [ ] Inbox collapse + E/Z + digest cadence; notification matrix.
- [ ] GitHub: install claim, repo map, branch→PR→merge walks an issue
      (fixtures prove it without a live App).
- [ ] Import a REAL Linear (or Jira) export — spot-check 10 issues.
- [ ] Deal Won → Create project → complete → deal timeline echo.
- [ ] Teams: create, private + audited self-add, states/labels/templates
      editors, estimate scales, delete + restore from Recently deleted.
- [ ] Phone (390px): list, issue open, inbox — readable and scrollable.

## User-side launch actions (blockers for real users, not for dogfood)

- [ ] Rotate every credential pasted into chat during the build (Supabase DB
      password, JWT_SECRET, Resend key, R2 keys).
- [ ] Register the production GitHub App; set GITHUB_APP_ID /
      GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET / GITHUB_APP_SLUG;
      webhook URL `https://<api>/api/v1/webhooks/github`.
- [ ] `pnpm sync:supabase` through migration 0047.
- [ ] Create the dogfood tenant; import your real tracker export.

## Honest deferrals (documented, not gaps)

- i18n string catalog (hi/es/pt-BR fast-follow) — strings are inline today.
- Timesheet `hourly_rate_snapshot` — no compensation model to source it.
- ~~Guest seats~~ (SHIPPED round 7: per-project guest invites), label groups, recurring templates, project-template starter
  issue sets — reserved columns exist ("v1.5" in the UI copy).
- CRDT/Yjs collaborative editing — markdown v1 shipped by design.
