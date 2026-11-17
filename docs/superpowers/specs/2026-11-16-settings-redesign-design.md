# Settings redesign — modern layout + control system

**Status:** design, pending owner sign-off → then plan → build (rigorous-build).
**Date:** 2026-11-16. **Scope:** the **Settings** screen only (the first "window" in a wider,
one-window-at-a-time UI refresh). Client-only (no Worker change).

---

## 1. Intent & why

The app works but parts feel "clunky / like the 90's." The owner wants to modernize it one screen
at a time, starting with Settings. Looking at the real screen, the structure is already good
(searchable root → category → setting drill-down), but it reads dated because:
- **Raw native form controls** — `<select>` dropdowns and `<input type=date>` render with the grey
  OS-default look (the single biggest "old software" tell).
- **Mixed concerns + debug chrome** — e.g. the Pay Period leaf also holds the Time-clock Station
  setting, with multi-line gray paragraphs and developer strings (`dev-fu8xjl · none`).
- **ALL-CAPS micro-labels**, thin hierarchy, and on wide screens a large empty void below the content.

This redesign fixes the control-level craft and the desktop layout while staying recognizably
TurnDesk (teal brand, Space Grotesk + Inter). It does **not** touch what any setting does.

## 2. Goals

1. **Responsive layout** — **two-pane console on desktop, drill-down on tablet/phone** (owner pick):
   - **Desktop (>1194px):** a persistent left rail (categories + their items) and a content pane on
     the right. No drilling, no empty void (like Linear / Stripe / macOS System Settings).
   - **Tablet/phone (≤1194px):** the existing root-cards → category-list → leaf drill-down, unchanged
     in flow. (1194px is the app's existing tablet breakpoint — reuse it.)
2. **A modern, consistent control system ("Option A")** — owner pick — applied to every setting:
   - **Tactile primary button** (solid teal + soft shadow + press-down), soft/ghost secondary buttons.
   - **Segmented control** replacing native `<select>` where there are a few choices.
   - **Switch** replacing native on/off checkboxes.
   - **Styled field** replacing native `<input type=date>`/text where practical (reads
     "Mon, Nov 16 2026", matches the app).
   - **Sentence-case labels** (no ALL-CAPS), concise helper text.
3. **One concern per screen** — split mixed leaves (first: pull the Time-clock Station setting out of
   Pay Period into its own "Stations & devices" leaf) and remove developer/debug strings from the UI.

## 3. Non-goals

- **No change to what any setting does** — same config keys, same save semantics, same permissions/tree.
- **No redesign of other screens yet** — Settings only (the rest of the app keeps its current look
  until its turn; the new control system is built reusably so later screens can adopt it).
- **No new settings, no reordering the tree** beyond the one-concern splits called out.
- Not a full design-system/token overhaul — reuse the existing CSS variables, fonts, and Material icons.

## 4. Anti-goals (failure even if it "works")

- Any existing setting that stops working, loses its value, or can't be reached.
- Losing **touch-friendliness** on the front-desk iPad (controls must stay finger-sized; the tablet
  drill-down must stay simple).
- The new controls not adapting to **dark mode** (the app has `data-appearance="dark"`).
- Inconsistency: two different button/switch/field styles living side by side after a leaf is migrated.
- A redesign that reads as a *different* product from the rest of the (not-yet-redesigned) app —
  it must still be clearly TurnDesk.

## 5. Constraints

- No build step; plain ES modules; Tailwind CDN; Material Symbols; fonts Space Grotesk (headline) +
  Inter (body); brand teal `#2a7a4f`. Match `// ── Section ──` conventions.
- Settings live in `js/app/features/settings.js` (`SETTINGS_NAV`, the root/category/leaf orchestrator)
  + the per-leaf render functions, with markup in `index.html` (`#panel-settings`, `#settings-root`,
  `#settings-category`, the leaf `*-section` containers) and styling in `css/styles.css`.
- There are **~25 leaf settings**, each rendered by its own function using raw controls — migrating all
  at once is large, so the build is **staged** (see §7.3).
- Version trio (`config.js`/`version.json`/`sw.js`) bumped together per shippable batch; What's-New entry.
- Must work at both >1194px (two-pane) and ≤1194px (drill-down), light and dark.

## 6. Approaches considered

**Layout** (owner picked B+A responsive):
- **B+A responsive (picked):** two-pane console on desktop, drill-down on tablet/phone. Best of both —
  fills the desktop void and keeps the simple one-thing flow on the iPad; fits the app's existing
  responsive split. Cost: two layouts to maintain in one panel.
- *A-only (polished drill-down everywhere):* simplest, but leaves the desktop void and the constant
  back-and-forth.
- *B-only (two-pane everywhere):* a cramped rail on a phone/iPad; worse for front-desk touch use.

**Control language** (owner picked A):
- **A — Soft & tactile (picked):** gentle depth + press feedback; premium but friendly; reads well on touch.
- *B — Crisp & precise (Stripe/Vercel):* flat/hairline; a touch more developer-dashboard.
- *C — Rounded pill:* airy/consumer; pills across a dense settings screen can read toy-ish.

## 7. The design (decided)

### 7.1 Control system ("Option A") — a small reusable kit
A set of consistent, dark-mode-aware controls, built once and reused by every leaf (and later, other
screens). Delivered as CSS classes in `css/styles.css` + a few tiny render helpers so leaves produce
identical markup:
- **Button:** solid teal, `border-radius:12px`, soft shadow `0 2px 8px rgba(31,95,60,.30)` + inner top
  highlight, `translateY(1px)` on `:active`; Space Grotesk 600. Soft (tinted) + ghost variants.
- **Segmented control:** tinted track, active chip = teal fill + soft shadow; for 2–4 mutually-exclusive
  choices (e.g. pay schedule, numpad mode).
- **Switch:** 44×26 pill, teal when on; replaces on/off checkboxes.
- **Field:** bordered, `border-radius:12px`, focus-ring in teal; for dates/text; shows friendly values.
- **Label:** sentence-case, 13px/600; concise helper text 12px muted.
All use existing CSS variables so dark mode works; all finger-sized.

### 7.2 Layout shell (B+A responsive)
- `#panel-settings` gains a **desktop two-pane** mode (>1194px): a left **rail** listing every category
  with its items (permission-filtered, same `settingsLeafVisible` source of truth), and a right
  **content pane**. Clicking a rail item renders that leaf into the content pane (no drill). The active
  item is highlighted; a **search field at the top of the rail filters the rail's items** (the drill-down's
  own search box is hidden on desktop). On first open the content pane shows a neutral **"Select a setting"
  empty state** — it does not auto-open a (possibly heavy) leaf.
- **≤1194px:** unchanged drill-down — root cards → `settingsOpenCategory` list → leaf. The same leaf
  render functions populate either the right pane (desktop) or the full-width section (tablet).
- Leaf content is **one concern per screen**, sentence-case, using the §7.1 controls.

### 7.3 Staged build (so it ships in safe, reviewable pieces)
- **Phase 1 — foundation + proof:** build the §7.1 control kit; build the §7.2 two-pane desktop shell
  (tablet drill-down untouched); migrate **Pay Period** (incl. splitting Time-clock Station into its own
  "Stations & devices" leaf) + **Numpad Entry** + **Checkout Rebooking** as the first leaves on the new
  controls. Ship. This proves the whole pattern live, end to end.
- **Phase 2+ — migrate the rest** of the leaves to the control kit in small batches (a few per ship),
  each batch verified. No behavior changes — just swapping raw controls for the kit and sentence-casing.

## 8. Decisions / my calls (owner: veto any)
- **Save behavior: keep today's auto-save** (settings apply the instant you change them) and **drop the
  explicit "Save" button** I drew in the mockups. It's the current behavior, lower-friction, and avoids a
  "did it save?" ambiguity across ~25 leaves. *(If you'd rather have an explicit Save per leaf, say so —
  it's a bigger change.)*
- **Breakpoint = 1194px**, reusing the app's existing desktop/tablet split.
- **Staged build** per §7.3 rather than redesigning all ~25 leaves in one commit.
- Native `<input type=date>` is **kept as the actual input, restyled** (border, 12px radius, teal focus ring)
  so it matches the app — but the **OS still owns the picker and the date format** (we don't overlay a custom
  "Mon, Nov 16" string, which would break the native picker). Modernizing = styling the real control, not faking it.

## 9. Architecture — resolved from the builder-check (my calls)
- **DOM model: flat DOM, CSS-driven layout — do NOT move the leaf `*-section` cards.** Keep every leaf
  section as a direct child of `#panel-settings` (one DOM instance each). Desktop two-pane is a **CSS
  Grid** on `#panel-settings` (`grid-template-columns: <rail> 1fr` at >1194px): a new desktop-only
  **rail** element sits in column 1; `#settings-root`/`#settings-category` are hidden on desktop (the
  rail replaces them); the one visible leaf section occupies column 2. At ≤1194px the grid collapses to
  one column and the existing drill-down runs unchanged. This reuses `settingsOpenLeaf` /
  `_hideAllSettingsSections` / `content.parentElement` **as-is** (one section id in the DOM → render
  functions reused verbatim) — resolving builder-check Q1/Q4.
- **Desktop leaf swap + initial state (Q2):** a rail click calls the existing `settingsOpenLeaf(contentId)`
  (it already hides root+category — harmless on desktop) plus a new rail-highlight step. On panel open at
  desktop width, open a sensible default leaf (first visible leaf, or a light overview) instead of the
  root grid. A `matchMedia('(min-width:1195px)')` listener reconciles on resize: entering desktop with no
  leaf open → open the default + show the rail; the shared `.hidden` state is the single source so the two
  layouts never double-render a section.
- **One wrapper per leaf (Q3):** split the shared `commission`+`numpad` card so each migrated leaf has its
  own wrapper; the content pane shows exactly one concern.
- **Segmented vs select (Q6):** the segmented control is for **short** 2–4 option sets (e.g. Numpad
  cents/dollars; pay schedule shown as **Weekly / Bi-weekly / Bi-monthly** with the parenthetical detail
  moved to helper text). Option sets that are long or many stay a **styled select** in the kit.

## 10. What's left to the builder
- The exact control-kit class names + the tiny render helpers (segmented/switch/field/styled-select) and markup.
- The rail markup generated from `SETTINGS_NAV` + `settingsLeafVisible`; the grid/media CSS; dark-mode values.
- The per-leaf migration list; version/What's-New per batch.

## 11. Resolved with the owner
- **Time-clock station split → a new "Time-clock station" leaf under the Workflow category** (near Pay
  Period), **adminOnly** (same permission as today). The name is deliberately distinct from the existing
  seats **Stations** leaf. *(owner, 2026-11-16)*
  - Mechanical: add a `*-section` container (e.g. `#settings-clockstation-section`) in `index.html`; add a
    `SETTINGS_NAV` entry in the `workflow` group (`adminOnly`, a device/clock icon); re-point
    `renderClockStationSetting` at the new container; remove the Time-Clock block + the
    `window.renderClockStationSetting?.()` call from `renderPayPeriodSettings` so Pay Period is one concern.
