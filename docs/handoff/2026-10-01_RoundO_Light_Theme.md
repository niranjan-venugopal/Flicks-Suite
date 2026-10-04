# Round O (part A) — Light theme: System / Light / Dark, per person

**Date:** 2026-10-01 → 2026-10-04 · **Type:** feature (founder request: *"Can we have a light version of the application. Everyone is asking for it?"*) · **Migration:** 0065 (`docs/handoff/apply-0065.sql`) · **Status:** released 2026-10-04 on the founder's instruction — migration 0065 applied by the founder in production Supabase first, then `production` (API) and `main` (web) pushed; the Dev catch-up commit stays local.

## 1. What the founder decided

- A light **colour theme** (the app was dark-only), not a cut-down edition.
- **Each person chooses** — *System / Light / Dark* — and the choice is **remembered on the server**, so it follows them to every device and to the admin console (which lives on a different web address and cannot share browser storage with the app).
- **New sign-ups start light; existing accounts stay dark** until they switch.
- **Before sign-in** (the login and sign-up screens) the app **follows the device** setting, because nothing is known about the person yet.
- In light mode two brand colours are **slightly deeper for readability on white**: the blue (`#3E7BFA → #2563EB` on buttons, links and coloured text) and the yellow, which reads as **amber** (`#B54708`) when used as text. Fills, pills and dots keep their familiar tints. Dark mode keeps the exact brand colours.

## 2. Where to find it

- **Profile → Appearance** (every role, including guests — Settings is admin-only, so the control is not there).
- The **avatar menu** in the top bar — also the only entry point on the admin console.
- "System" follows the laptop/phone setting live, without a reload.

## 3. How it works (for the team)

- `<html data-theme="dark|light">` carries the *resolved* theme; the *preference* (`system|light|dark`) lives in `users.theme` and in a small browser mirror (`flicks-theme`) used only for the first paint.
- A tiny inline script runs **before anything is drawn** and sets the attribute from the mirror (or the device setting when there is no mirror), so there is no flash of the wrong theme on reload. After sign-in the server's value wins and the mirror is updated.
- All colours are CSS tokens in `apps/web/app/globals.css`: today's dark values under `:root, [data-theme="dark"]`, the light set under `[data-theme="light"]`. Dark is unchanged by construction — every replaced literal maps to the token holding the same value.
- Customer-facing pages (hosted invoice, mandate, public form, invoice preview/PDF) are wrapped in a dark scope and keep their own customer toggle; they are **not** affected by the signed-in user's preference.
- Emails are untouched (own palette).

## 4. API / database

- **Migration 0065** adds `users.theme` (`'system' | 'light' | 'dark'`): the column is created with default `'dark'` so **every existing account is backfilled dark**, then the default is switched to `'light'` so **accounts created afterwards are light**. Idempotent; safe to run twice.
- `GET /auth/me`, the sign-in and the workspace-switch responses now include `theme`.
- `PATCH /auth/me/preferences` `{ theme }` — self-scoped, validated, **refused during an impersonation session** so support cannot change a customer's preference by accident.
- The data-export bundle includes `theme`.

## 5. Release order (when the founder decides to ship)

`/auth/me` reads every column of `users`, so an API without the column would fail for everyone. **Run `docs/handoff/apply-0065.sql` in Supabase first, then push `production` (API), then `main` (web).** The web tolerates both states (an old API simply never sends `theme`).

## 6. Verification

**Build process.** One foundation agent (contract + tokens + Tailwind + pre-paint script + provider), four implementers on disjoint files (A data + plumbing, B shared primitives + charts, C1 controls + CRM + Projects, C2 everything else), **three adversarial review lenses per implementer** (correctness · dark-regression / security · light-contrast), then a fix pass each: 20 agents, 1 blocker and 13 majors found and fixed. The blocker is worth knowing about: making the invoicing palette theme-aware turned `INVO.blue` into a CSS variable, which also reached the **Razorpay checkout** `theme.color` on the hosted invoice page — an iframe cannot read our CSS variables — so that one sink now gets the literal brand hex (`INVO_BRAND_BLUE`). After the live run three more adjustments: the device mirror is no longer written until a preference is actually known (pre-login, new device, public page), the light ink ramp was deepened (`--text-2 .82 · --text-mute .70 · --text-faint .64`) because 50 % ink on the card surface was 3.4:1, and the Razorpay fix above.

**Scale.** 178 files, ~1,100 insertions; ~500 dark-assuming colour literals moved onto tokens. What is still literal is intentional: the token definitions themselves, the customer-facing invoice document palette, white text on brand-coloured fills, the avatar initials, the white QR box, dead code (`components/dashboard/*`, `StatusBadge`), and the public pages' own palettes.

**Gate (all green):** API typecheck · nest build · **Jest 79 suites / 1,119 tests** (the new `founder-roundO-theme` spec pins the migration defaults, the CHECK, the endpoint's validation, self-scoping, the impersonation refusal, `/me` exposure and the data-export field) · module boundaries (345 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0` across 133 tenant tables.

**Live verification** (`scratchpad/verify-roundO.mjs`, production build, real browser, real API and database; every assertion against the DOM, computed styles or the `users` row): **79 pass / 0 fail / 1 skip** across the 12 scenarios.

| # | Scenario | Result |
|---|---|---|
| 1 | Fresh account → dashboard | paints **light**; body `rgb(255,255,255)`; mirror written `light` |
| 2 | `users.theme = 'dark'` set directly in SQL → reload | paints **dark**; body `rgb(1,1,13)` |
| 3 | Profile control | attribute flips **250 ms after the click while the PATCH is still pending** (optimistic); PATCH 200; row updated; survives the `/me` re-fetch |
| 4 | No flash of the wrong theme | the `data-theme` mutation log after reload is exactly `["light"]`; the one change landed at **30 ms, before first paint at 56 ms** |
| 5 | New browser (empty storage) | light after `/me`; mirror written |
| 6 | Admin console | the admin-host rewrite proven at the HTTP layer (the `/overview` response under `Host: admin.localhost:3000` carries the same console page chunk as `/fam/overview`); console shell renders; first load light from `/me`; **Dark from the avatar menu** → attribute flips → row `dark` → a fresh tenant-origin browser on a light OS reloads **dark** |
| 7 | System | `emulateMedia` OS dark → dark, OS light → light, **without a reload** |
| 8 | Hosted invoice while the user is light | `html[data-theme]` forced **dark** immediately and after the provider; the public wrapper resolves `--bg` to `#01010D`; the customer's own toggle still flips its document palette; `/inv/:token/print` renders dark; the user's mirror stays `light` |
| 9 | Pre-login | `/login` follows the emulated device (light → white, dark → `#01010D`); **no mirror is written** |
| 10 | Impersonation | Appearance control disabled; PATCH → **403**; the target's row unchanged |
| 11 | Light screenshot sweep (20 pages incl. menu, confirm dialog, command palette) | every page `data-theme=light` |
| 12 | Low-contrast probe (every visible text element, effective background by ancestor walk, WCAG ratio) | **0 offenders on all 20 pages** after the ink-ramp change (the first draft had 30, all `--text-faint` captions) |

Skip: the public PDF endpoint answers 500 in this sandbox (the headless PDF renderer is not available locally); the `/print` route it renders is verified directly.

Harness notes for the next engineer: Chromium cannot spoof the `Host` header for navigations, and fulfilling every response from Node stalls the page's own API fetches — hence the HTTP-layer proof of the rewrite in scenario 6; scenario 8 warms the context on the app first so the "mirror untouched by a public page" check is meaningful.

## 7. What to tell your team

1. Everyone keeps dark until they switch. Profile → Appearance, or the avatar menu — including on the admin console.
2. New sign-ups see light from their first dashboard.
3. "System" follows the device setting, live.
4. The sign-in screens follow the device until you are signed in.
5. Customer-facing invoice, mandate and form pages are unchanged — they have their own switch.
6. In light mode the blue is one notch deeper and yellow text reads amber, for legibility.

## 8. Follow-ups

- Delete the dead `components/dashboard/*` and `components/common/StatusBadge.tsx` (0 importers) in a cleanup round.
- Decide whether the hosted-invoice customer toggle should follow the customer's device setting (it defaults to dark today).
- A grey page with white cards is a two-line token change if the founder prefers it to the pure-white page.
- Converge the remaining avatar components on one primitive (carried over from Round N).
