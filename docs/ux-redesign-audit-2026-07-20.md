# RowPoint UX / UI Redesign — Audit & Plan (2026‑07‑20)

**Goal:** make RowPoint feel like a calm, premium, rowing‑inspired product a first‑time
user can navigate without overwhelm — while **preserving every existing feature**. This
is a reorganization + presentation project, not a feature‑removal project. No routes,
pages, DB tables, AI, BLE, PM5, HR, force‑curve, analytics, history, settings, or coach
capability is removed; buried things become *discoverable*, not deleted.

Scope of this document: (1) an honest read of what is already strong, (2) the six audits
the brief asked for — density, duplicated actions, navigation redundancy, tab merges,
excess text, design‑system inconsistency — each with concrete file references, (3) a
target information architecture, and (4) a phased implementation plan.

---

## 0. What is already strong (do **not** rebuild this)

RowPoint is **not** a raw/unstyled app. It already has:

- A mature, token‑driven design language (`public/styles.css`) — one water‑inspired
  palette, cohesive spacing scale (`--sp-*`), water‑like easing (`--ease`,
  `--ease-spring`), soft elevation, dark mode via `prefers-color-scheme`, and a
  `prefers-reduced-motion` + in‑app `data-motion="off"` escape hatch.
- A hand‑tuned SVG icon family (`public/js/icons.js`) and composition primitives
  (`.icon-chip`, `.section-head`, `.card-head`, `.card.feature`, `.li-icon`, `.page-head`).
  Decorative emoji are already banned app‑wide.
- Page‑transition (`page-in`), skeleton loaders, empty‑state patterns, accessible focus
  rings, a focus‑trapped modal, and Promise‑based styled dialogs (no native
  `alert/confirm/prompt`).
- A genuinely sophisticated AI coach (see §7) with an LLM path *and* a deterministic
  analysis‑engine fallback, plus safety guardrails.

**Implication:** the redesign is about **information architecture, density, progressive
disclosure, onboarding, and consistency** — not a visual from‑scratch reskin. The visual
language mostly needs *tightening and consistent application*, not replacement.

---

## 1. Current information architecture (the core problem)

**7 primary tabs** (`public/js/app.js:112‑120`): Home · Row · Progress · Heart · History ·
Teams · Social — feeding **28 routes** (`app.js:37‑67`):

| Tab (nav) | Routes it owns | Count |
|---|---|---|
| **Home** | `/` dashboard, `/wellness`, `/settings`, `/equipment`, `/integrations`, `/admin`, `/research` | 7 |
| **Row** | `/row`, `/stroke`, `/builder` | 3 |
| **Progress** | `/progress`, `/plan`, `/lab`, `/athlete`, `/optimizer`, `/racelab`, `/observatory`, `/benchmark`, `/timeline` | 9 |
| **Heart** | `/hr` | 1 |
| **History** | `/history`, `/journal`, `/workout/:id` | 3 |
| **Teams** | `/teams`, `/team/:id`, `/live/:id` | 3 |
| **Social** | `/social`, `/group/:id` | 2 |

Two structural problems fall straight out of this table:

1. **Too many tabs (7).** Mobile bottom nav is cramped; labels shrink to `.64rem` under
   640px (`styles.css:641`). Heart is a whole tab for a single screen; Teams and Social
   are two tabs for one social/community idea.
2. **The Progress tab is a dumping ground (9 routes).** It exposes eight deep analytics
   tools as a **wall of eight secondary buttons** in its header
   (`progress.js:43‑50`) — Observatory, Timeline, Lab, Athlete/Twin, Optimizer, Race Lab,
   Stroke, Plan — with no grouping or hierarchy. This is the single worst offender.

---

## 2. Audit A — Information‑density hot‑spots

| Screen | File | What's crammed in | Fix direction |
|---|---|---|---|
| **Progress** | `progress.js` | ~12 stacked sections in one scroll: 8‑button nav wall (43‑50), insight card, community chip, readiness ring + race‑prediction table, 3 living‑goal blocks, weekly‑goal ring, streak, 6 stat tiles, **11 PR tiles** (100‑113), full badge grid (all achievements), consistency heatmap, trend chart, goal editor. | Split into "Progress" (motivation: streak, goal ring, this‑week) with everything else behind sub‑views / an "Analytics" hub and progressive disclosure. Records → top 3 + "See all". Badges → recent + "See all". |
| **Dashboard** | `dashboard.js` | Hero (streak + ring + 4 stats + achievements + CTA), coach card (with inline expandable detail), experiment card, wellness nudge, assignments, daily suggestions, recent workouts, admin tools — up to **8 cards** on first paint. | Reduce first paint to: greeting, **one** primary "what to do today" (coach *or* assignment), readiness, next scheduled, one insight. Everything else → "expand"/detail. (Brief's explicit target.) |
| **Coach card** | `dashboard.js:213‑272` | Title, confidence badge, description, duration+targets line, explanation, health prompt, then a 6‑field "why" detail block. | Collapsed by default (title + one line + one action). "Why this workout?" already toggles — make that the default posture, not an afterthought. |
| **Settings** | `settings.js` (296 ln) | Profile, goals, units, research, equipment, integrations, export, danger‑zone all on one page. | Becomes the **Profile** tab; group into cards with clear section heads; heavy items (equipment, integrations) stay as their own sub‑pages (already are). |
| **HR / Force‑curve** | `hrm.js` (349 ln) | Dense single screen. | Fine as a screen; the issue is it occupies a top‑level *tab* (§4). |
| **Group / Admin** | `group.js` (640), `admin.js` (652) | Large but role‑appropriate (admin is power‑user). | Lower priority; apply spacing/section‑head consistency only. |

---

## 3. Audit B — Duplicated / redundant actions

| Action | Appears in | Problem | Fix |
|---|---|---|---|
| **Edit weekly goal** | `progress.js:159‑176` (inline editor) **and** `settings.js:33,182` | Two independent editors for the same `goalWeekly*` fields. | One canonical editor (Profile/Progress); the other links to it. |
| **Export CSV** | `history.js:16,30` **and** `settings.js:266` | Same export in two places. | Keep in Profile ▸ Data; History keeps a single obvious entry or links out. |
| **"Start a row"** | Labeled **4+ ways** to the same `#/row`: "Start rowing" (`dash`, `progress:27`, `lab:22`, `timeline:20`), "Row your first piece" (`history:26`, `journal:41`), "Row it" (`dash:86`, `teamDetail:38`), "Start this session" (`dash:269`). | Same destination, inconsistent verb/label; dilutes the one primary action. | One primary "Row" action + consistent secondary label ("Row it" only for an *assigned* piece). |
| **Coach "Start this session" vs Row tab vs Builder** | `dashboard.js:269`, Row tab, `builder.js` | Three ways to begin a session with different mental models. | Keep all paths (they differ in intent) but make the Row tab the single obvious home; coach/builder *hand off* to it (they already use the same `rp_draft_plan` draft — good). |

---

## 4. Audit C — Navigation redundancy & discoverability failures

- **Orphaned depth:** `/benchmark` is only reachable from inside `/observatory`
  (`observatory.js`), i.e. **3 taps deep** with no other path. `/research` only from
  `/admin`. `/wellness` only from a dashboard nudge (gone once you've checked in).
- **Tab attribute mismatches:** `/settings`, `/equipment`, `/integrations`, `/admin`,
  `/research`, `/wellness` all report `tab:'home'` (`app.js:60‑66`) but are reached from
  the top‑bar gear or deep links, so the Home tab highlights while you're on an unrelated
  page — the active‑tab indicator lies.
- **Heart is a top‑level tab for one page** (`app.js:116`) — HR pairing belongs under Row
  (during a session) and Profile ▸ Devices (setup), not the primary nav.
- **Teams vs Social** are two tabs for one "community" concept.
- **Settings lives in the top bar, not the nav** — discoverable only via a gear glyph.

---

## 5. Audit D — Tab‑merge plan → **4 primary tabs**

Proposed target nav (feature‑preserving; every current route keeps a home):

| New tab | Absorbs (current) | Sub‑pages reached inside |
|---|---|---|
| **Home** | dashboard, wellness | Today's focus, readiness, next up, quick check‑in |
| **Row** | row, builder, stroke, **hr** (pairing/live), history, journal, workout/:id | Start/free row, workout builder, live stroke, HR pairing, **History** + Journal + workout detail |
| **Insights** | progress, plan, lab, athlete, optimizer, racelab, observatory, benchmark, timeline | Progress (motivation) as the landing view; an **Analytics** hub groups the 8 deep tools into labelled sections (Training plan · Performance lab · Community/Observatory · Race tools) |
| **Profile** | settings, equipment, integrations, teams, team/:id, live/:id, social, group/:id, admin, research | Account/goals/units, Devices (equipment + integrations/HR), **Community** (teams + social + groups + live), plus admin/research when the role allows |

Notes / decisions to confirm with product:
- The brief's *example* was Home · Row · Community · Profile. RowPoint's analytics suite is
  large enough that folding it under Home or Row would just recreate the "Progress
  dumping ground." **A dedicated 4th tab for insight/analytics is recommended** over a
  pure Community tab — hence Home · Row · **Insights** · Profile, with Community living
  inside Profile (or promoted to the 4th tab if community is the strategic priority).
- History pairs naturally with Row (log → review) rather than living alone.
- This is the **one decision that gates everything downstream** and is the product
  owner's call — see §11.

---

## 6. Audit E — Excess text / text‑reduction targets

The brief asks for ~60–80% less *visible* text via progressive disclosure (not deletion).
Highest‑value reductions:

- **Coach card** (`dashboard.js:251‑264`): description + explanation + 6 labelled detail
  lines render at once when expanded. Default posture = title + one‑sentence summary +
  ⓘ. All copy stays — behind the existing toggle.
- **Onboarding research screen** (`auth.js:102‑110`): two paragraphs + toggle + a third
  line. Reduce to a one‑line value statement + toggle + "Learn more".
- **Progress consistency / predictions disclaimers** (`progress.js:215,226,134`): move
  long disclaimers into `<details>`/ⓘ (predictions already uses `<details>` — apply the
  same pattern to readiness + consistency).
- **Empty‑state blurbs** across pages are fine (they're motivational and short) — keep.

Guardrail: text reduction = *disclosure*, never information loss. Every paragraph removed
from first paint must be reachable via ⓘ / "Learn more" / expand.

---

## 7. AI Coach realism — assessment

**Finding: the coach is already principled**, contrary to a "generates unrealistic
recommendations" premise. `server/ai/coach.js` + `trainingAnalysis.js`:

- Distinct categories with realistic intent: `steady_state`, `long_aerobic`,
  `threshold_intervals`, `vo2max_intervals`, `sprint_intervals`, `race_pace`,
  `recovery_row`, `technique`, `return_easy` (`coach.js:27‑32`).
- System prompt (`coach.js:146‑166`) already encodes zone balance, "don't stack hard
  days," respect wellness/fatigue, prescribe splits **from the athlete's real 2k**, and
  scale to goal/history — exactly the brief's asks.
- Deterministic fallback derives paces from the athlete's real 2k split + recent steady
  pace with per‑zone HR bands and stroke rates (`coach.js:531‑545`), and the
  overtraining/coach‑assignment guardrails are enforced in code (`coach.js:178‑201`).

**Genuine tunables worth improving (small, targeted):**

1. **Steady/long‑aerobic duration ceilings are conservative.** Fallback steady sits at
   `[40,60]`/`[30,45]`/`[35,60]` (`coach.js:319,368,382`); the brief wants long
   steady‑state to reach **45–120+ min** by phase/athlete. `long_aerobic` should scale
   toward 75–120 for experienced, base‑phase athletes; the schema already allows up to
   `hi=300` (`coach.js:246`), so this is a fallback‑heuristic + prompt nudge, not a schema
   change.
2. **Make the 45–120+ steady‑state principle explicit in the system prompt** so the LLM
   path prescribes true long aerobic sessions, not defaulted ~30‑min pieces.
3. Otherwise: keep. This is tuning, not a rewrite. (Preserve LLM + fallback + guardrails.)

---

## 8. Audit F — Design‑system inconsistencies

- **i18n gaps (functional bug, not just cosmetic):** several pages hardcode English and
  bypass `t()` — `history.js` ("History", "No workouts yet", "Your history starts
  completely empty…"), `teams.js`, `social.js`, `builder.js`, and **the entire coach card
  in `dashboard.js:233‑272`** ("Today's coach recommendation", "Start this session", "Why
  this workout?"). In German these render in English — a real localization regression.
- **Terminology drift:** the same action reads "Start rowing" / "Row your first piece" /
  "Row it" / "Start this session" (§3). "Athlete/Twin" vs "Digital twin" vs "/athlete".
  Pick one noun per concept.
- **Heading pattern drift:** some pages use `.page-head`/`.section-head` (dashboard,
  progress), others a bare `<h1>` + ad‑hoc button row (`history.js`, `teams.js`). Unify on
  `.page-head` + `.section-head`.
- **Inline style sprawl:** many `style="..."` one‑offs (e.g. `progress.js` PR tiles,
  hero). Fine short‑term; migrate the repeated ones to utility classes for consistency.
- Consistent already (keep): buttons, badges, cards, icon‑chips, focus rings, motion
  tokens.

---

## 9. Motion, color, typography, accessibility (lighter‑touch)

- **Motion:** the water metaphor is mostly there (`page-in`, ring fill "rises like water",
  `--ease`). Add: consistent card‑enter stagger on list pages, and a "flowing" loading
  state (the boot spinner is a generic rotate — could become a calm horizontal glide).
  Keep everything behind `prefers-reduced-motion`.
- **Color:** palette is already calm blues/teals/slate — no change needed. Enforce one
  accent for primary actions; reserve gold/violet for achievements/experiments only.
- **Typography:** headings are strong; increase whitespace between sections (section‑head
  top‑margin) and cap paragraph width on wide screens for readability.
- **Accessibility:** focus rings, reduced motion, ARIA on nav present. Gaps to close:
  ensure 44px min touch targets on `nav.tabs a` and `.btn.sm`; verify contrast on
  `--muted` small text; add `aria-current` consistency; landscape/tablet: content is
  `max-width:1120px` centered — add a two‑column layout for tablet on the analytics hub.

---

## 10. Phased implementation plan (feature‑preserving)

Ordered by user‑visible impact ÷ risk. Each phase is shippable and reversible.

- **P0 — Consistency + correctness (low risk, high polish):** route all hardcoded strings
  through `t()` (coach card, history, teams, social, builder); unify page/section headers;
  fix tab‑active mismatches; de‑duplicate goal editor + CSV export to one canonical home.
- **P1 — Navigation: 7 → 4 tabs:** implement the confirmed IA (§5). Re‑home routes, keep
  all 28 working, add an **Analytics hub** that groups the 8 Progress deep‑links into
  labelled sections instead of a button wall. No page logic changes — just where things
  live and how they're grouped.
- **P2 — Progressive disclosure:** slim Dashboard first paint; collapse coach detail by
  default; Records/Badges → "recent + See all"; disclaimers → ⓘ/`<details>`. Pure
  presentation.
- **P3 — Onboarding + coach tuning:** one‑concept‑per‑screen onboarding with visible
  progress (extend the existing `step-dots`; account → profile → experience → goals →
  equipment/permissions → done); raise steady/long‑aerobic durations and make the
  45–120+ principle explicit in the coach prompt/fallback.
- **P4 — Motion + a11y refinements:** card stagger, calmer loaders, touch‑target/contrast
  pass, tablet two‑column analytics.

**Verification each phase:** `npm test` (unit/API) + `npx playwright test` (e2e) from
`rowpoint/`, plus a manual pass in the dev server for the touched screens. Nothing merges
that removes a capability.

---

## 11. Open decisions for the product owner (gate P1)

1. **4th tab identity:** Home · Row · **Insights** · Profile (analytics gets its own tab,
   community inside Profile) — *recommended* — **vs** Home · Row · **Community** · Profile
   (community is a tab, analytics folds into Row/Home). This single choice reshapes P1.
2. **Where History lives:** under **Row** (log→review, recommended) vs its own entry.
3. **How much to build now:** all of P0–P4 vs start with P0+P1 (the highest‑impact,
   lowest‑risk slice) and iterate.
