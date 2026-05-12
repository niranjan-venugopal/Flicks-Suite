# Flicks Suite — Feature-by-Feature Completion Plan

> **Working agreement:** complete one feature end-to-end (data model → API → UI matching the prototype → manual verification in browser) before starting the next. No half-built features.

---

## 1. Current state (audit, May 2026)

The repo already has substantial backend coverage. The visual layer is the main gap.

### Backend modules (apps/api/src/modules/)

| Module | Endpoints | Service LOC | Has DB schema |
|---|---|---|---|
| auth | 10 | 805 | ✓ (auth.ts) |
| attendance | 10 | 1049 | ✓ (attendance.ts) |
| leave | 9 | 863 | ✓ (leave.ts) |
| employees | 13 | 647 | ✓ (employees.ts) |
| onboarding | 6 | 429 | ✓ (platform.ts) |
| calendar | 3 | 420 | ✓ (uses leave + employees) |
| dashboard | 2 | 404 | – (aggregates) |
| notifications | 2 | 265 | ✓ (platform.ts) |
| settings | 10 | 249 | ✓ (platform.ts) |
| fam | 10 | 233 | ✓ (fam.ts) |
| timesheet | 7 | 204 | ✓ (timesheet.ts) |
| audit | 1 | 148 | ✓ (platform.ts) |

### Web pages (apps/web/app/)

```
(auth):  login, verify, onboarding
(app):   dashboard, attendance, leave, calendar, timesheets, help
         employees, employees/[id], employees/documents,
         employees/onboarding, employees/org-chart
         reports/attendance, reports/headcount, reports/leave, reports/audit
         settings, settings/departments, settings/leave-policies,
         settings/locations, settings/members, settings/notifications,
         settings/working-hours
```

**Missing pages** (vs prototype):
- Approvals inbox (dedicated `/inbox`) — prototype has it; we only have a dashboard widget
- Manager-specific views (`mgr-dashboard`, `mgr-team`, team attendance/leave/timesheets)
- Employee self-service home (`emp-home`) — currently shares /dashboard
- Employee profile (`emp-profile`) — `[id]` page exists but isn't wired for the logged-in user
- FAM console (whole 8-page admin tree at `admin.flickssuite.com`)

---

## 2. PRD vs prototype vs code — feature-by-feature status

Per the PRD §12 acceptance gates:

| # | Feature | PRD § | Gate | API | DB | UI shell | UI matches prototype | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Auth (OTP + magic link + JWT) | 3 | – | ✓ | ✓ | ✓ | ✗ | **Working, needs visual polish** |
| 2 | Customer onboarding (tenant signup) | 4 | 2 | ✓ | ✓ | partial | ✗ | **API done, UI is bare** |
| 3 | Employee mgmt + self-onboarding | 5 | 2 | ✓ | ✓ | ✓ | ✗ | **Functional, needs visual + 5-step wizard** |
| 4 | Attendance / clock-in | 6 | 3 | ✓ | ✓ | ✓ | ✗ | **Gate 3 was claimed; verify + visual** |
| 5 | Leave management | 7 | 4 | ✓ | ✓ | ✓ | ✗ | **Gate 4 was claimed; verify + visual** |
| 6 | Calendar + iCal | 7.5 | 4 | ✓ | – | ✓ | ✗ | **Gate 4 was claimed; verify + visual** |
| 7 | Timesheet | 8 | 7 | ✓ | ✓ | ✓ | ✗ | **API thin (204 LOC) + UI partial** |
| 8 | Settings | 9 | – | ✓ | ✓ | ✓ (7 tabs) | ✗ | **All sub-pages exist; visual + wire-up** |
| 9 | Customer Admin Dashboard | 10 | 5a | ✓ | – | ✓ | ✗ | **Gate 5a was claimed; verify + visual** |
| 10 | FAM platform admin | 11 | 5b | ✓ | ✓ | ✗ (no pages) | ✗ | **API only — UI doesn't exist** |
| 11 | Approvals inbox | 10.2 | 5a | partial | – | ✗ (widget only) | ✗ | **No dedicated page** |
| 12 | Audit log | 9.4 | – | ✓ | ✓ | partial | ✗ | **Exists; needs visual + wire-up** |
| 13 | Notifications (in-app) | – | – | ✓ | ✓ | ✗ | ✗ | **API only — no bell/list UI** |

Where Gate 3/4/5a were claimed in commit messages, **I have not personally re-verified the acceptance criteria** — that gets re-checked when we tackle that feature.

---

## 3. The visual gap (root cause of "doesn't match prototype")

The prototype's design tokens and the repo's Tailwind config disagree on every brand color:

| Token | Tailwind today | Prototype |
|---|---|---|
| blue | `#2B69F5` | `#3E7BFA` |
| green | `#00C9A7` | `#27D280` |
| yellow | `#FFC72C` | `#FED800` |
| coral | `#FF6B6B` | `#F8786B` |
| purple | — (missing) | `#9B7BFA` |

Also missing from globals.css / Tailwind:
- 4 elevation shadows (`--e1`, `--e2`, `--e3`, `--glow-blue`)
- Glass surfaces (`--glass-bg`, `--glass-blur`)
- Type scale (`t-display`, `t-h1`, `t-h2`, `t-h3`, `t-body`, `t-mute`, `t-caption`)
- Utility classes (`.card`, `.glass`, `.btn`, `.btn-primary/secondary/ghost/danger`, `.pill` + tones, `.avatar` + sizes, `.dot`, `.input`, `.label`, `.tbl`, `.progress`)

Shared primitives in prototype but not in repo:
- `Logo` / `LogoMark` (custom SVG, gradient mark)
- `Icon` set (50+ inline SVG icons, 1.6px stroke, line style)
- `Avatar` with deterministic gradient by name
- `AvatarStack` (overlapping)
- `Pill` (tone + dot)
- `Btn` (kind/size variants)
- `SectionHead`, `Kpi`, `Spark` (sparkline SVG), `BarChart`, `Donut`, `Toggle`, `Modal`, `PageGlows`

**Until these tokens + primitives exist, no individual screen can "match the prototype" cleanly** — every screen would need bespoke styling otherwise.

---

## 4. Recommended sequence

### Phase 0 — Visual foundation (1 session, blocks everything else)

Single commit, no behaviour change, low risk. After this every existing screen looks measurably closer.

**What lands:**
1. New `apps/web/app/tokens.css` literally copied from prototype's `tokens.css` (CSS variables only).
2. `apps/web/app/globals.css` rebuilt: imports tokens, includes all utility classes (`.card`, `.glass`, `.btn`, `.pill`, `.avatar`, `.dot`, `.input`, `.label`, `.tbl`, `.progress`, type scale).
3. `apps/web/tailwind.config.ts` updated: replace `brand.*` with the prototype's hex values, add `purple`, expose elevation shadows.
4. New primitives in `apps/web/components/ui/`:
   - `Icon.tsx` (the full 50+ icon set, ported as React components)
   - `Avatar.tsx` (with deterministic gradient via `avBg`)
   - `Pill.tsx`, `Btn.tsx`, `Kpi.tsx`, `Sparkline.tsx`, `Donut.tsx`, `BarChart.tsx`, `PageGlows.tsx`
   - `LogoMark.tsx` + `Logo.tsx`
5. Keep existing `@radix-ui` primitives untouched (Topbar's dropdown still uses them).

**Acceptance:** existing pages still load; brand colors visibly shift to the prototype values; `import { Kpi, Pill, ... } from '@/components/ui'` works.

### Phase 1 onwards — one feature per session, in this order

Each feature: re-check PRD acceptance criteria → match prototype screen verbatim → wire to existing API hooks → manual verify in browser → commit.

| # | Feature | Why this order | PRD § | Prototype source |
|---|---|---|---|---|
| 1 | **App Shell** (Sidebar + Topbar, role-based 2-level nav) | Once this matches, every other screen reads as "the prototype" instantly | 10.4–10.5 | `_app-shell.jsx` |
| 2 | **Customer Admin Dashboard** | First screen the demo user lands on; sets visual tone | 10 | `_dashboard.jsx` |
| 3 | **Approvals Inbox** | New dedicated page; manager's primary daily action | 10.2 | `_dashboard.jsx` (Approvals section) |
| 4 | **Employee directory + profile** | People is the most-touched screen after dashboard | 5 | `_people.jsx` |
| 5 | **Attendance** (re-verify Gate 3) | Daily clock-in is the demo's "live" moment | 6 | `_attendance.jsx` |
| 6 | **Leave + Calendar** (re-verify Gate 4) | Pair them since calendar overlays leave | 7 | `_leave.jsx` |
| 7 | **Onboarding wizards** (tenant + employee 5-step) | Needed before first real customer | 4, 5 | `_onboarding.jsx` |
| 8 | **Settings** (7 sub-tabs) | Configuration UX; needed for any non-demo tenant | 9 | `_timesheets-reports-settings.jsx` |
| 9 | **Timesheets** (Gate 7) | Lighter-priority for HR demo; ship after the rest is polished | 8 | `_timesheets-reports-settings.jsx` |
| 10 | **Reports + Audit log** | Owner views; not part of the daily loop | 10.3, 9.4 | `_timesheets-reports-settings.jsx` |
| 11 | **Manager team views** | Distinct nav under Manager persona | 10.4 | `_manager.jsx` |
| 12 | **Employee self-service home** | Distinct nav under Employee persona | 10.5 | `_dashboard.jsx` (Employee view) |
| 13 | **FAM Console** (admin app) | Specflicks-internal; ship after public app is solid | 11 | `_fam-console.jsx` + `_fam-tenant.jsx` + `_fam-subroutes.jsx` |
| 14 | **Notifications bell + list** | Cross-cutting; only meaningful once notifications fire from above features | – | – |

Estimated session count: **14 sessions** (1 phase 0 + 13 features). Some features may pair into one session if scope is small.

### What "done" looks like for each feature

Before marking a feature complete:
- [ ] PRD §X.x acceptance criteria checked off explicitly (cite by line)
- [ ] All endpoints used by the new UI return 2xx with seed data
- [ ] Visual matches the prototype's screen at 1280×800 (manual screenshot comparison)
- [ ] No TypeScript errors (`pnpm typecheck`)
- [ ] One commit per feature, descriptive message, signed if signing server is up
- [ ] Push to origin

---

## 5. First feature to tackle — recommendation

**Start with Phase 0 (visual foundation), then App Shell (Sidebar + Topbar).**

Rationale:
- Phase 0 is non-negotiable — without the tokens and primitives, every screen we touch afterward is bespoke instead of consistent
- App Shell is everywhere — once it matches, the visual gap to the prototype shrinks by ~40% across all logged-in screens
- Both have minimal risk (no DB changes, no API contract changes)
- We can verify both manually in browser within minutes

If you'd rather lock in a feature end-to-end FIRST (skipping the foundation), the cleanest standalone feature to do is **Customer Admin Dashboard** since its API and data are already real (see commit `b3e6f1f`), so we'd only be redoing the visual layer.

---

## 6. Open questions before we start

1. Persona selection: the prototype has a built-in persona switcher (Owner/Admin/Manager/Employee/FAM) for demoing. Do you want that switcher in dev mode, or strictly enforce the logged-in user's role?
2. Icon set: the prototype's icons are inline SVG. The repo currently uses `lucide-react`. Port the prototype's 50+ icons verbatim, or keep `lucide-react` and re-map to closest equivalents?
3. Font files: the prototype ships 7 woff/woff2/ttf files (Gilroy + JetBrains Mono + Lora). Do you have license-clear copies to ship, or should we substitute with web-safe fallbacks for now?
4. FAM (Specflicks-internal admin) — is this in scope for the customer demo, or strictly internal and lower priority?

---

## 7. What I won't do without sign-off

- Change DB schemas (would require migration on Supabase)
- Change API response shapes (would break existing flows we just unblocked)
- Remove existing screens — only enhance/replace their UI
- Add new third-party services
