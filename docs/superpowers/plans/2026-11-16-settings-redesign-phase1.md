# Settings redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation of the Settings redesign — a reusable modern control kit, the desktop two-pane layout (tablet/phone drill-down untouched), and three settings migrated onto it (Pay Period, Numpad, Checkout Rebooking) plus the one-concern split of the time-clock station into its own Workflow screen.

**Architecture:** Flat DOM, CSS-driven layout. `#panel-settings.active` becomes a CSS Grid at ≥1195px — a desktop-only **rail** in column 1 (its own title + search + grouped items), the drill-down chrome hidden, and the active leaf `*-section` in column 2 (with the existing `#settings-nav-header` reused as the content-pane title). ≤1194px is the existing drill-down, unchanged. Leaf render functions are reused verbatim (one DOM instance per section). A new node-safe `js/app/settings-ui.js` holds pure control-markup helpers; `css/styles.css` holds the kit + layout classes (dark-mode aware).

**Tech Stack:** Plain ES2020 modules, no build; Tailwind CDN; Material Symbols; Space Grotesk + Inter; brand teal `#2a7a4f`. `node:test` (per-file on Windows: `node --test-force-exit --test <file>`).

**Spec:** `docs/superpowers/specs/2026-11-16-settings-redesign-design.md`

## Global Constraints

- No build; plain ES modules; reuse existing CSS variables, fonts, Material icons; `// ── Section ──` markers.
- **Flat DOM + CSS Grid** — do NOT move/duplicate the leaf `*-section` cards; reuse `settingsOpenLeaf` /
  `_hideAllSettingsSections` / `content.parentElement` as-is. One DOM instance per section.
- **The Settings panel is a `.dash-panel`** (`display:none`; `.active` → shown). So the desktop grid rule MUST be
  scoped to **`#panel-settings.active`** at `@media(min-width:1195px)` — never a bare `#panel-settings{display:grid}`
  (an id selector would force the panel visible on every screen).
- **Grid columns are pinned explicitly, not auto-placed:** `#settings-rail{grid-column:1;grid-row:1/-1}` and
  `#panel-settings.active > :not(#settings-rail){grid-column:2}` at ≥1195px; the drill-down chrome
  (`#settings-root`, `#settings-category`, `#settings-search-wrap`, `#settings-results`) is `display:none` via **id
  selectors** on desktop (id-specificity beats Tailwind/`.hidden`).
- **The rail must survive `_hideAllSettingsSections`** (it iterates `panel.children` and `.hidden`s all but a few):
  add `#settings-rail` (and the new `#settings-empty`) to its exemption list AND give the rail an id-selector
  `display` on desktop so `.hidden` can't kill it.
- Any new render function referenced by `SETTINGS_NAV` `render:'…'` or an inline handler must be **`export`ed** from
  settings.js (the `main.js` bulk `Object.assign(window, ns)` glue then auto-exposes it — no manual main.js edit).
- **Breakpoint 1195/1194px** (reuse the app's existing desktop/tablet split; ≤1194 = drill-down).
- **Auto-save stays** — settings apply on change; NO Save buttons. The migrated controls must **pass their value
  explicitly** to their setter (don't read a now-removed DOM id — see Task 4's Pay Period fix).
- Controls **dark-mode aware** (`html[data-appearance="dark"]`) and **finger-sized**; rail rows **≥44px tall**
  (a 12.9" iPad lands on the desktop rail).
- **No behavior / permission / tree changes** except the approved time-clock-station split (new "Time-clock
  station" leaf under Workflow, `adminOnly`).
- Version trio bumped together → **td-v0.85**; add `settings-ui.js` to `sw.js` PRECACHE; plain-English What's-New.
- Commit after each task. **Do not push, do not deploy** (owner's call). Client-only.

## Review Focus

- **Panel stays hidden on other screens** — the desktop grid is scoped to `#panel-settings.active`; open Queue/Turns and Settings must not bleed in. → Task 2 CSS + browser check from another tab.
- **Rail isn't hidden by `_hideAllSettingsSections`** — click several leaves; the rail stays. → Task 2.
- **Grid robustness** — no stray drill-down child (search results, root) displaces the leaf out of column 2 on desktop. → Task 2 force-hide + explicit columns.
- **Pay Period still saves the chosen schedule** — pick Bi-weekly/Bi-monthly and reload; it persists (not silently 'weekly'). → Task 4 (the `#pp-type` read is removed).
- **Dark mode** — every new control legible in dark. → Task 1 CSS + dark browser check.
- **Resize across 1194px** — leaf open on desktop → shrink to tablet, and root on tablet → grow to desktop: no blank/double-render; the single `matchMedia` listener reconciles. → Task 2.
- **No regression in un-migrated leaves** — open two un-migrated leaves via the rail; they render + save. → Task 2.
- **Time-clock split** — Pay Period shows no station UI; the new leaf sets/clears the station; the developer id debug line is gone/muted. → Task 4.

---

### Task 1: Control kit — `settings-ui.js` helpers + CSS

**Files:** Create `js/app/settings-ui.js`; Test `test/settings-ui.test.js`; Modify `css/styles.css`.

**Interfaces — Produces** (pure; import only `escHtml` from `utils.js`):
- `segControl({ value, items }) -> html` — `items:[{value,label,onclick}]`; `<div class="set-seg">` with a `<button>` per item; the item whose `value===value` gets `set-seg-on`.
- `switchRow({ label, help, on, onclick }) -> html` — label/help + a `set-switch`(/`set-switch-on`) button, `role="switch"` + `aria-checked`.
- `styledSelect({ value, items, onchange }) -> html` — a `set-field`-wrapped native `<select>` (long/many option sets); matching option `selected`.

- [ ] **Step 1: Failing tests** `test/settings-ui.test.js` (import `./setup-globals.js` first): segControl (all items; exactly-active `set-seg-on`; onclick; escaped label); switchRow (`set-switch-on`/`aria-checked` iff on; onclick; label+help); styledSelect (matching option selected; onchange).
- [ ] **Step 2: Run → FAIL** (`node --test-force-exit --test test/settings-ui.test.js`).
- [ ] **Step 3: Implement `js/app/settings-ui.js`.**
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Kit CSS in `css/styles.css`** — `.set-btn`(+soft/ghost), `.set-seg`/`.set-seg-on`, `.set-switch`/`.set-switch-on`, `.set-field` (also wraps/styles a native `<select>` and `<input type=date>`; **no custom date text — style the real input**), `.set-label`/`.set-help`; Option-A values from the approved mockup; `html[data-appearance="dark"]` overrides via existing vars.
- [ ] **Step 6: Commit** — `git commit -m "feat(settings): modern control kit (settings-ui.js) + CSS (td-v0.85 wip)"`

---

### Task 2: Desktop two-pane shell (rail + CSS grid + empty state + rail search)

**Files:** Modify `js/app/features/settings.js`, `index.html` (`#panel-settings`), `css/styles.css`; Test `test/settings-ui.test.js` (add rail-groups cases).

**Interfaces:** Consumes `SETTINGS_NAV`, `settingsLeafVisible`, `settingsOpenLeaf`, `_setSettingsHeader`. Produces `settingsRailGroups(nav, visible, query?) -> [{title, items:[{label,content,action,icon}]}]` (pure, predicate injected; optional query filters items); `renderSettingsRail()`, `filterSettingsRail(q)` (DOM); a once-registered `matchMedia('(min-width:1195px)')` reconcile.

- [ ] **Step 1: Failing test** for `settingsRailGroups` — group order preserved; only `visible` items; projected shape; a `query` filters by label/sub (mirrors `_settingsSearchRows`). Run → FAIL.
- [ ] **Step 2: Implement `settingsRailGroups`** (export). Run → PASS.
- [ ] **Step 3: Rail markup + grid CSS** — add `#settings-rail` (first child of `#panel-settings`: a "Settings" title, a rail search input `oninput="filterSettingsRail(this.value)"`, and the grouped item list) and `#settings-empty` ("Select a setting" neutral state). CSS at `@media(min-width:1195px)`: scope `#panel-settings.active{display:grid;grid-template-columns:248px 1fr;gap:…}`; `#settings-rail{grid-column:1;grid-row:1/-1;display:flex}` (id selector); `#panel-settings.active > :not(#settings-rail){grid-column:2}`; `display:none` via id selectors for `#settings-root/#settings-category/#settings-search-wrap/#settings-results`; keep `#settings-nav-header` (col 2) as the content title; rail rows ≥44px. ≤1194px: `#settings-rail,#settings-empty{display:none}` and the drill-down is unchanged.
- [ ] **Step 4: Exempt the rail + empty state** in `_hideAllSettingsSections` (add `ch.id==='settings-rail' || ch.id==='settings-empty'` to the skip at settings.js:513).
- [ ] **Step 5: Desktop open + swap + default** — make `renderSettingsPanel`'s tail **width-conditional**: ≥1195 → `renderSettingsRail()` + show `#settings-empty` (no auto-open leaf) + hide the Back button; ≤1194 → `settingsNavRoot()` as today. A rail item click calls `settingsOpenLeaf(content)` (or its `action`), then `_setSettingsHeader(label,'',false)` and a rail-highlight + hides `#settings-empty`. (Skip `action`-only items as the "default".)
- [ ] **Step 6: Rail search** — `filterSettingsRail(q)` re-renders the rail from `settingsRailGroups(SETTINGS_NAV, settingsLeafVisible, q)`.
- [ ] **Step 7: Resize reconcile** — ONE module-scope `matchMedia('(min-width:1195px)')` listener: → desktop with no leaf open: render rail + show empty state; → tablet: ensure drill-down reachable (Back/root works). Register once (not per render).
- [ ] **Step 8: Browser-verify** (preview `turndesk`; reveal settings): desktop rail shows, clicking swaps content + highlights + updates the title; the empty state shows on open; rail search filters; a non-admin role hides admin-only rail items; **open another panel (Queue) — Settings does not bleed in**; resize across 1194 both ways stays coherent; two un-migrated leaves open/save; light + dark. Commit — `git commit -m "feat(settings): desktop two-pane rail (scoped CSS-grid, flat DOM, rail search + empty state)"`.

---

### Task 3: Migrate Numpad + Checkout Rebooking to the kit

**Files:** Modify `js/app/features/settings.js` (`renderNumpadSettings`, `renderRebookSettings`), `index.html` (split the shared commission/numpad wrapper).

- [ ] **Step 1: Import the kit** — `import { segControl, switchRow, styledSelect } from '../settings-ui.js';` in settings.js.
- [ ] **Step 2: Split the shared wrapper** — `index.html:1313-1316` wraps `#settings-commission-section` + `#settings-numpad-section` in one card; give each its own `bg-surface-container-lowest … overflow-hidden` card (reveal still works via `content.parentElement`); fix the stale `<!-- Leaf: Commission & Refunds -->` comment.
- [ ] **Step 3: Rebuild `renderNumpadSettings`** with `segControl` (Cents / Whole dollars) → `setNumpadWholeDollars(bool)`; sentence-case label + concise help. No behavior change.
- [ ] **Step 4: Rebuild `renderRebookSettings`** with `switchRow` → `setRebookPrompt(bool)`; sentence-case.
- [ ] **Step 5: Browser-verify** both render with the new controls, toggle + auto-save correctly, light + dark; Commission (un-migrated) still works in its own card. Commit — `git commit -m "feat(settings): migrate Numpad + Checkout Rebooking to the control kit"`.

---

### Task 4: Time-clock station split + Pay Period migration

**Files:** Modify `js/app/features/settings.js` (`SETTINGS_NAV`, `renderPayPeriodSettings`, `savePayPeriod`, new leaf render), `index.html` (new `#settings-clockstation-section`), `js/app/features/timeclock.js` (debug-line cleanup + stale comment). Two commits are fine (split, then Pay Period).

- [ ] **Step 1: New leaf** — add `#settings-clockstation-section` card in index.html; add a `SETTINGS_NAV` workflow entry after Pay Period: `{ label:'Time-clock station', sub:'Which device staff clock in/out on', content:'settings-clockstation-section', render:'renderClockStationLeaf', adminOnly:true, icon:'punch_clock' }`. Add **`export function renderClockStationLeaf()`** that writes a sentence-case heading + explainer + `<div id="timeclock-station-status"></div>`, then calls `window.renderClockStationSetting?.()`.
- [ ] **Step 2: Remove the station block from `renderPayPeriodSettings`** (settings.js:383-389 — the Time-Clock `<div>` + the trailing `window.renderClockStationSetting?.()`), so Pay Period is one concern and `#timeclock-station-status` exists only once.
- [ ] **Step 3: Clean the debug tell** — in `renderClockStationSetting` (timeclock.js), remove/mute the monospace "This device: `dev-…` · Saved station: …" diagnostic line (spec §1/§2.3 target); keep the actionable status + buttons (restyle buttons with `.set-btn` optionally). Update the stale "inside the Pay Period settings section" comment (timeclock.js:183).
- [ ] **Step 4: Migrate Pay Period controls + fix the save coupling** — replace the `<select id="pp-type">` with `segControl` (Weekly / Bi-weekly / Bi-monthly; parenthetical detail → help text). **Because `savePayPeriod` reads `#pp-type` (settings.js:390), that read must go:** the segControl passes the chosen type to a setter that dispatches `pay_period` with `{type, startDate: <preserved>}` and re-renders (to show/hide the start-date field); the date input passes its value to the same/paired setter (preserving `type`). Restyle the native date input as `.set-field` (no custom text). Sentence-case labels.
- [ ] **Step 5: Browser-verify** — Pay Period shows only pay-period controls; **changing the schedule to Bi-weekly persists across a reload** (not reset to weekly); the new "Time-clock station" leaf appears in Workflow (admin only), sets/clears the station, and shows no `dev-…` debug line; no duplicate station UI; light + dark. Commit(s) — `git commit -m "feat(settings): split Time-clock station into its own Workflow leaf"` then `git commit -m "feat(settings): migrate Pay Period to the control kit (+ fix save coupling)"`.

---

### Task 5: Version bump, precache, What's-New

**Files:** Modify `js/app/config.js`, `version.json`, `sw.js`, `js/app/main.js`.

- [ ] **Step 1:** Bump trio → **td-v0.85**; add `'/turndesk/js/app/settings-ui.js'` to `sw.js` `PRECACHE_URLS`.
- [ ] **Step 2:** Plain-English `WHATS_NEW` (td-v0.85): a refreshed Settings — a side menu on desktop, modern switches/buttons, and the time-clock station on its own screen.
- [ ] **Step 3:** FULL suite per-file (green, report count); `node --check` changed JS. Commit — `git commit -m "chore: td-v0.85 — Settings redesign Phase 1"`.

---

## Known-accepted for Phase 1 (from the plan review)
- The desktop rail won't live-refresh the **Billing** entry when its async `get hidden()` flag resolves (billing default-off; acceptable). The **Customers** root shortcut is desktop-rail-absent (it has its own nav tab). The ~22 un-migrated leaves render today's controls in the new pane (coherent, shippable half-migration). On desktop→tablet with a leaf open, Back falls through to root (no category context) — acceptable.

## Phase 2 (separate plan, after this ships)
Migrate the remaining ~22 settings leaves onto the control kit in small verified batches (no behavior changes).

## Post-build (outside the task loop)
- rigorous-build pre-presentation review (correctness / subject-matter / cosmetics) + senior pass; fix; report.
- Owner reviews the live screen on a device; **push + any deploy stay the owner's call** (client-only).
