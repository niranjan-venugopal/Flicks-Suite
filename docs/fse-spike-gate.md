# FSE Spike Gate — Result: PASS (Sprint 32)

PRD v6 §3.9 mandated a week-1 spike proving the Flicks Sync Engine end-to-end
on the real `pm_issues` pipeline before building further. Measured on the dev
stack (local Postgres 16 + Redis, Next dev server, headless Chromium, demo
tenant), full production pipeline: optimistic MobX apply → IndexedDB
write-behind → `POST /pm/sync/mutate` (idempotency ledger, RLS, in-tx
`domain_events` publish with `sync_seq`) → direct post-commit `{seq}` ping on
the `/sync` socket → second client delta pull → snapshot upsert.

| §3.9 criterion | Budget | Measured | Verdict |
|---|---|---|---|
| Optimistic create/edit, local apply | < 50 ms | **1.6 ms** | PASS (~30× headroom) |
| Propagation to a second client | < 1 s | **417–424 ms** | PASS |
| Offline queue replay | exactly-once | 2 offline mutations queued (pending badge), replayed once on reconnect, both landed on client B with server-assigned numbers; idempotency ledger shows one application each | PASS |
| Kill-switch fallback | same UI on REST | `pm_sync_engine` flag OFF in `feature_flags` → fresh session renders the same list in REST mode (react-query against `/pm/issues`), same rows visible | PASS |

Also verified in the suite (`pm-sync.spec.ts`, 9 tests): mutation idempotency
(duplicate `clientMutationId` = single application), in-tx event emission with
sync refs, private-team rows never present in a non-member's bootstrap OR
delta (tombstoned on visibility loss), delta tombstones for vanished rows.

**Decision: FSE proceeds. ElectricSQL evaluation not required.** The
architecture holds with wide margins; the remaining §21 budgets (cold
bootstrap < 2 s at 5–10 k issues, delta < 150 ms P95) are asserted in CI at
Sprint 41 on the 10k reference workspace.

Tuning notes: the propagation path's dominant cost is the delta round trip
(~250 ms of the 424 ms) — the direct post-commit socket ping (locked decision
#3) is what keeps this under budget; routing the ping through the 2 s outbox
dispatcher would blow it. The optimistic apply cost is negligible (MobX map
set + observer re-render of one group).
