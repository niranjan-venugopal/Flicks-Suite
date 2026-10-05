# Round P · R5 — Project icons: a crisp icon library on colour tiles, or an uploaded image (never both)

**Date:** 2026-10-05 · **Type:** feature · **Migration:** none · **Status:** see §7

Founder's ask: *"Add premium logos like Apple does, or add an image. Both can't be added … add more icons."* Decision: a **large, crisp icon library** (187 curated glyphs from the open-source lucide set, in five groups) drawn white on one of twelve colour tiles; a project shows **either** its icon tile **or** an uploaded image.

## 1. What the customer gets

- **New project**: the icon tile next to the name opens the picker — search the library, pick a glyph and a colour, see the live preview; or switch to **Image** and upload a logo. New projects start on a folder glyph with a colour chosen from the name.
- **Project page**: one tile button in the header replaces the old "upload" button plus the six-emoji dropdown. Click it to change the icon or colour, upload an image, or remove the image (the icon and colour come straight back).
- **Everywhere a project appears** — the projects list, the issue composer, the timeline, the roadmap, an issue's project field — the same tile is drawn, so a project is recognisable at a glance. Old projects that used an emoji keep it, on a neutral tile.
- Choosing an icon while an image is set removes the image (the rule the founder asked for); uploading an image hides the icon until the image is removed.

## 2. How it works

- No schema change: `pm_projects.icon` now holds either a legacy emoji or `lucide:<name>`; `pm_projects.color` (stored since Round C, never rendered) holds `#RRGGBB`; `logo_key` is the uploaded image as before.
- The web library is `apps/web/components/pm/icons/project-icons.ts` (curated names imported individually, so only those glyphs ship in the bundle) and the single renderer is `components/pm/ProjectIcon.tsx` (image → lucide tile → legacy emoji → default). `ProjectVisualPicker` is the modal used by both the create form and the header.
- The API validates `icon` and `color` on **both doors** — the REST DTOs and the service, which the offline-sync mutation path calls directly. The icon rule (one regex exported from `projects.service.ts`): `lucide:[a-z0-9-]{1,24}` — any letter-case of the `lucide:` prefix must be a well-formed lower-case name, so `lucide:Rocket` is refused rather than stored as a 13-character "emoji" — or a 1–16 character emoji without whitespace or control characters; `color` is `#RRGGBB` or null. Setting an icon clears `logo_key` in the same update (the project row is locked `FOR UPDATE` so an upload racing an icon write lands after it), writes the same `pm.project.logo_removed` audit row as a manual remove, and deletes the stored image after the transaction; uploading keeps the icon and colour stored; removing the image leaves them untouched. A colour-only change never touches the image: the header sends `{ color }` alone when the glyph is unchanged.

## 3. API

| Endpoint | Change |
|---|---|
| `POST /pm/projects`, `PATCH /pm/projects/:id` | `icon` ≤ 32 chars matching `lucide:[a-z0-9-]{1,24}` or a legacy emoji; `color` `#RRGGBB` or null; a non-null `icon` on PATCH clears the image |
| `POST /pm/projects/:id/logo`, `DELETE /pm/projects/:id/logo` | unchanged behaviour; icon + colour survive both |
| sync `project.create` / `project.update` | same validation as REST (service level) |

## 4. Founder action — release order

No migration. Push `production` (API) then `main` (web); either order is safe (an older web only shows the default tile for new icon values, an older API accepts them as plain strings).

## 5. Tests

`founder-roundP-r5-project-icons.spec.ts` (create/update with lucide values and legacy emoji, icon-on-image clears the image and deletes the object, upload keeps icon/colour, remove restores the tile, invalid icon/colour rejected through the DTO and through the sync door, null handling).

## 6. Follow-ups
- Team and milestone colours still use their own pickers; the swatch set could be shared.
- Project icons in email/notification bodies stay text (no tile).
- The "recently deleted" projects list in PM workspace settings shows names only; drawing tiles there needs the API to return icon / colour / image for deleted rows.
- The issue composer's Project pill shows a dashed placeholder when no project is linked (instead of the old 🎯) — a design call to confirm.

## 7. Gate and live verification

**Build process.** Three implementers (API validation + exclusivity · web surfaces · web picker + create form + header), three adversarial review lenses each, one fix pass each: 15 agents. The reviews caught: the contract's icon regex would have accepted `lucide:Rocket` as a 13-character "emoji" (now refused at both doors, control characters refused too); an upload racing an icon write could orphan its new image (the project row is now locked for the update, with a race test that fails without the lock); a silent failure on "Remove image" from the picker (now toasts); and the crop dialog opened from the project picker was titled "Update company logo" (it now says "Project image", through a `title` / `noun` prop on the shared crop modal that the orchestrator added). A colour-only change is sent without the icon so it can never drop an image.

**Gate (all green):** API typecheck · nest build · **Jest 89 suites / 1 365 tests** (the one failure is `attendance-selfheal`, run at 01:45 IST: between 00:00 and 05:30 IST the UTC date is still the previous day, so the punch day and the presence day disagree — the documented environmental flake; R5 touches no attendance code) · module boundaries (358 modules, 0 violations) · web typecheck · web production build · RLS probe `leak_with_bogus_context = 0`.

**Live verification** (`scratchpad/verify-roundP-r5.mjs`, production web build, real API, real Postgres, S3-compatible mock with bulk delete): **41 pass / 0 fail / 0 skip** across 5 scenarios; the implementers' own harnesses added 56/56 (surfaces) and 43/43 (picker).

| # | Scenario | Result |
|---|---|---|
| 1 | Create with `lucide:rocket` + `#DC2626` → stored; a legacy `🚀` still accepted; `lucide:Rocket`, a 30-char name, `lucide:a b`, 20-char text → 400; `red`, `#FFF`, `#GGGGGG` → 400; `color: null` clears | pass |
| 2 | Upload an image → `logo_url` signed, icon + colour kept; PATCH icon while the image is set → `logo_url` null in the response, `logo_key` null in the DB, **the old object is gone from storage**; upload again → image back, icon kept; remove → `logo_url` null, icon + colour untouched | pass |
| 3 | Projects list draws the purple target tile and the legacy emoji tile (the tile is painted with the project colour); the header tile is a button → picker ("Project icon") → search "rocket" → pick → the header becomes the rocket without a reload and the DB records `lucide:rocket` (through the offline-sync door, `POST /pm/sync/mutate`) | pass |
| 4 | An issue in the project, an initiative holding both projects: the roadmap lane, the timeline bar, the issue's project field and the composer's project options all draw the tile | pass |
| 5 | New project → tile → picker → Green swatch, then the Trophy glyph (commits and closes) → "Create project" → the row has `lucide:trophy` + `#059669` | pass |

Screenshots in the session scratchpad: `rp5-projects-list`, `rp5-picker`, `rp5-header-after-pick`, `rp5-roadmap`, `rp5-timeline`, `rp5-issue-detail`, `rp5-composer`, `rp5-create-modal`.

**Worth knowing before the first customer uses it**
- In the picker, clicking a glyph applies it and closes the dialog (Linear-style); clicking a colour re-tints the grid and applies immediately when the project already shows an icon tile. On a project that shows an image or a legacy emoji, pick a glyph to use the colour — the dialog says so.
- Old projects keep their emoji until someone opens the picker and chooses a glyph.
