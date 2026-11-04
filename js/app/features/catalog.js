// ── Services / Items / Fees CRUD + dashboard visibility ─────────────────────
// Services & Retail Items use a PAGE-LEVEL draft editor (Wave 1b): every row is editable, edits
// accumulate in an in-memory draft, and ONE "Save" per page commits them (edit many, save once).
// Save reconciles the draft against the LIVE array (best-effort: keeps a concurrent edit to an
// untouched row, honors a remote delete, appends a concurrent add) + a "changed on another device"
// warn. Rows can be reordered (drag or up/down). Fees keep their simple instant-save rows.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, setSwitchVisual, escHtml } from '../utils.js';

const cfg = () => getState().config;

// ── Pure cores (unit-tested) ──────────────────────────────────────────────────
// Canonicalize an edited row: string inputs → numbers/null, trimmed strings. baseCost/price must be
// numeric/null (they feed turnClassOf / pricing), never "" or NaN. Spread `...r` FIRST so any field we
// don't edit here (e.g. a legacy Square link that was dual-written onto the row) survives the round-trip
// instead of being silently stripped on save.
export function coerceServiceRow(r) {
  const bc = parseFloat(r.baseCost);
  return { ...r, id: r.id, label: (r.label || '').trim(), abbr: (r.abbr || '').trim(),
    baseCost: (r.baseCost === '' || r.baseCost == null || !Number.isFinite(bc)) ? null : bc,
    desc: (r.desc || '').trim() };
}
export function coerceItemRow(r) {
  const pr = parseFloat(r.price);
  return { ...r, id: r.id, label: (r.label || '').trim(), abbr: (r.abbr || '').trim(), price: Number.isFinite(pr) ? pr : 0 };
}
// Dirty = the coerced draft differs from the coerced baseline (captures field edits + order + add/delete).
// Normalized (coerced) so a number vs its input-string form never reads as a change.
export function catalogDirty(baselineStr, draft, coerce) { return JSON.stringify((draft || []).map(coerce)) !== baselineStr; }
// Whole-draft validation → { id, msg } of the first offending row, or null (dup-name is scanned ACROSS
// the draft, so two new rows with the same name are caught and a renamed row isn't flagged against itself).
export function validateCatalogDraft(kind, draft) {
  const seen = new Map();
  for (const r of (draft || [])) {
    const label = (r.label || '').trim(), abbr = (r.abbr || '').trim();
    if (!label) return { id: r.id, msg: kind === 'service' ? 'Please enter a service name.' : 'Please enter an item name.' };
    if (kind === 'service' && !abbr) return { id: r.id, msg: 'Please enter an abbreviation.' };
    // Dup-name is a service-only rule; retail items may legitimately share a label (e.g. two gift-card SKUs).
    if (kind === 'service') {
      const key = label.toLowerCase();
      if (seen.has(key)) return { id: r.id, msg: `"${label}" is listed twice.` };
      seen.set(key, r.id);
    }
  }
  return null;
}
// Best-effort merge at Save: user order; a user-edited row → coerced user values; an untouched row →
// the LIVE row (keeps a concurrent edit); a brand-new row → kept; a row that existed at open but is
// gone from LIVE → DROPPED (honor a remote delete, never resurrect); a concurrent remote add → appended.
export function reconcileRows(live, base, draft, deletedIds, coerce) {
  const liveById = new Map((live || []).map(r => [r.id, r]));
  const baseStr = new Map((base || []).map(r => [r.id, JSON.stringify(coerce(r))]));
  const seen = new Set();
  const out = [];
  for (const d of (draft || [])) {
    const cd = coerce(d); seen.add(cd.id);
    const liveRow = liveById.get(cd.id);
    if (!liveRow) { if (!baseStr.has(cd.id)) out.push(cd); continue; }   // in base & gone → remote-deleted (drop); brand-new → keep
    out.push(JSON.stringify(cd) !== baseStr.get(cd.id) ? cd : liveRow);   // user-edited → user values; else LIVE (preserve concurrent edit)
  }
  for (const lr of (live || [])) if (!seen.has(lr.id) && !(deletedIds && deletedIds.has(lr.id))) out.push(lr);
  return out;
}

// ── Page-draft editor model (Services + Retail Items) ─────────────────────────
const _clone = o => JSON.parse(JSON.stringify(o));
// Date.now() alone collides when two rows are added in the same millisecond; the counter + random tail
// make every new-row id unique within a session so reconcile never confuses two fresh rows.
let _uc = 0;
const _uid = p => `${p}-${Date.now().toString(36)}${(++_uc).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const CAT = {
  service: { key: 'services', listId: 'services-merged-list', coerce: coerceServiceRow, saveBtn: 'services-save-btn', nounPlural: 'Services' },
  item:    { key: 'items',    listId: 'settings-items-list',  coerce: coerceItemRow,    saveBtn: 'items-save-btn',    nounPlural: 'Items' },
};
// Per-list edit state. Three live-at-open snapshots, each with a distinct job:
//   base        — raw clone of the rows; reconcileRows diffs against it to tell edited from untouched.
//   baselineStr — the coerced base, stringified; catalogDirty compares the coerced draft to it.
//   openedFrom  — raw stringified config; catalogSavePage uses it for the "changed on another device" check.
const _ed = { service: null, item: null };   // each: { draft:[], base:[], baselineStr, deleted:Set, openedFrom }
function _ensureDraft(kind) {
  if (_ed[kind]) return;
  const live = cfg()[CAT[kind].key] || [];
  _ed[kind] = { draft: _clone(live), base: _clone(live), baselineStr: JSON.stringify(live.map(CAT[kind].coerce)), deleted: new Set(), openedFrom: JSON.stringify(cfg()[CAT[kind].key] ?? null) };
}
function _clearDraft(kind) { _ed[kind] = null; }
function _kindDirty(kind) { const e = _ed[kind]; return !!e && catalogDirty(e.baselineStr, e.draft, CAT[kind].coerce); }
export function catalogHasUnsaved() { return _kindDirty('service') || _kindDirty('item'); }
const _draftRow = (kind, id) => (_ed[kind] ? _ed[kind].draft.find(r => r.id === id) : null);
const _liveHas  = (kind, id) => (cfg()[CAT[kind].key] || []).some(r => r && r.id === id);
function _renderKind(kind) { (kind === 'service' ? renderServicesMerged : renderSettingsItems)(); }
function _renderCatalog() { renderServicesMerged(); renderSettingsItems(); }

// Commit ONE kind's draft into the live array (validate → reconcile → dispatch). Returns false (+toast
// +scroll) on a validation miss so the caller can keep the user on the page.
function _commitKind(kind) {
  const e = _ed[kind]; if (!e || !_kindDirty(kind)) return true;
  const err = validateCatalogDraft(kind, e.draft);
  if (err) { showToast(err.msg); _scrollToRow(kind, err.id); return false; }
  const key = CAT[kind].key;
  dispatch('config.set', { key, value: reconcileRows(cfg()[key] || [], e.base, e.draft, e.deleted, CAT[kind].coerce) });
  if (kind === 'service' && e.deleted.size) {   // prune orphaned visibility ids for deleted services
    ['hidden_services', 'hidden_dash_services'].forEach(vk => {
      const cur = cfg()[vk] || [], next = cur.filter(id => !e.deleted.has(id));
      if (next.length !== cur.length) dispatch('config.set', { key: vk, value: next });
    });
  }
  _clearDraft(kind);
  return true;
}
// The page "Save" button: confirm any permanent removals, warn on a concurrent remote change, then commit.
export function catalogSavePage(kind) {
  if (!_ed[kind] || !_kindDirty(kind)) return;   // nothing to save → no spurious toast/warn (also the Enter-key path)
  const e = _ed[kind], noun = kind === 'service' ? 'service' : 'item';
  // On success re-render (re-inits a clean draft); on a validation miss DON'T — _commitKind already
  // highlighted + scrolled the bad row, and a re-render would wipe that outline and the user's typing.
  const commit = () => { if (_commitKind(kind)) { _renderKind(kind); showToast(`${CAT[kind].nounPlural} saved`); } };
  // Deletes are batched (they commit on Save, not on the Delete tap), so surface them at the decision point.
  const liveNames = new Map((cfg()[CAT[kind].key] || []).map(r => [r.id, (r.label || '').trim() || '(unnamed)']));
  const removing = [...e.deleted].filter(id => liveNames.has(id)).map(id => liveNames.get(id));
  const afterRemoveConfirm = () => {
    if (JSON.stringify(cfg()[CAT[kind].key] ?? null) !== e.openedFrom && window.showWarnModal) {
      window.showWarnModal(`${CAT[kind].nounPlural} changed on another device`,
        'They were changed on another device since you opened this page. Save your version anyway? Changes you didn’t touch are kept.', commit, 'Save anyway');
    } else commit();
  };
  if (removing.length && window.showWarnModal) {
    window.showWarnModal(`Remove ${removing.length} ${noun}${removing.length > 1 ? 's' : ''}?`,
      `Saving will permanently remove: ${removing.join(', ')}. This can’t be undone.`, afterRemoveConfirm, 'Remove & save');
  } else afterRemoveConfirm();
}

// ── Unsaved-changes guard (page-level; catalog's own 3-button modal) ──────────
let _pendingProceed = null;
function _openCatalogGuard(onProceed) {
  const m = document.getElementById('catalog-unsaved-modal');
  if (!m) { if (onProceed) onProceed(); return; }   // no modal → don't trap the user
  _pendingProceed = onProceed || null;
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => m.querySelector('button')?.focus(), 30);
}
function _closeCatalogGuard() { const m = document.getElementById('catalog-unsaved-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; } }
export function catalogUnsavedSave() {
  const doSave = () => {
    // validation miss → close the guard but DON'T re-render (keep the highlighted row + the user's typing in place)
    if (_kindDirty('service') && !_commitKind('service')) { _closeCatalogGuard(); _pendingProceed = null; return; }
    if (_kindDirty('item')    && !_commitKind('item'))    { _closeCatalogGuard(); _pendingProceed = null; return; }
    const go = _pendingProceed; _pendingProceed = null; _closeCatalogGuard(); _renderCatalog();
    if (go) go();
  };
  // Mirror the Save button: confirm any permanent removals (across both lists) before committing on leave.
  const removing = [];
  for (const kind of ['service', 'item']) {
    const e = _ed[kind]; if (!e || !_kindDirty(kind)) continue;
    const names = new Map((cfg()[CAT[kind].key] || []).map(r => [r.id, (r.label || '').trim() || '(unnamed)']));
    [...e.deleted].filter(id => names.has(id)).forEach(id => removing.push(names.get(id)));
  }
  if (removing.length && window.showWarnModal) {
    _closeCatalogGuard();   // swap the guard modal for the confirm (no stacking)
    window.showWarnModal(`Remove ${removing.length} item${removing.length > 1 ? 's' : ''}?`,
      `Saving will permanently remove: ${removing.join(', ')}. This can’t be undone.`, doSave, 'Remove & save');
  } else doSave();
}
export function catalogUnsavedDiscard() {
  const go = _pendingProceed; _pendingProceed = null; _clearDraft('service'); _clearDraft('item'); _closeCatalogGuard(); _renderCatalog();
  if (go) go();
}
export function catalogUnsavedStay() { _pendingProceed = null; _closeCatalogGuard(); }
// Core-nav chokepoints call this. Clears the drafts on a clean leave so a reopen re-reads live config.
export function catalogGuardLeave(onLeave) {
  if (!catalogHasUnsaved()) { _clearDraft('service'); _clearDraft('item'); if (onLeave) onLeave(); return; }
  _openCatalogGuard(() => { if (onLeave) onLeave(); });
}

// ── Delegated listeners on each list container (bound once) ───────────────────
let _catWindowBound = false;
function _ensureCatalogListeners() {
  if (!_catWindowBound && typeof window !== 'undefined' && window.addEventListener) {
    _catWindowBound = true;
    window.addEventListener('beforeunload', e => { if (catalogHasUnsaved()) { e.preventDefault(); e.returnValue = ''; return ''; } });
  }
  [CAT.service.listId, CAT.item.listId].forEach(cid => {
    const el = document.getElementById(cid);
    if (!el || el._catWired) return;
    el._catWired = true;
    el.addEventListener('input', _catInput);
    el.addEventListener('keydown', _catKeyDown);
    el.addEventListener('pointerdown', _catDragDown);
  });
}
function _kindOf(target) { const row = target.closest && target.closest('[data-cat-row]'); if (!row) return null; const [kind, id] = row.dataset.catRow.split(':'); return { row, kind, id }; }
function _catInput(ev) {
  const inp = ev.target, field = inp.dataset && inp.dataset.field; if (!field) return;
  const r = _kindOf(inp); if (!r) return;
  _ensureDraft(r.kind);
  const row = _draftRow(r.kind, r.id); if (row) { row[field] = inp.value; _syncSaveBtn(r.kind); }
  r.row.classList.remove('cat-invalid');   // typing clears the validation flag on this row
}
function _catKeyDown(ev) {
  // isComposing → don't treat the Enter that confirms an IME candidate as "save the page".
  if (ev.key === 'Enter' && !ev.isComposing) { const r = _kindOf(ev.target); if (r) { ev.preventDefault(); catalogSavePage(r.kind); } }
}
// How many rows a Save would write: new + edited + (live) deletes — shown on the button so pending edits are obvious.
function _dirtyCount(kind) {
  const e = _ed[kind]; if (!e) return 0;
  const baseIds = new Set(e.base.map(r => r.id));
  const baseStr = new Map(e.base.map(r => [r.id, JSON.stringify(CAT[kind].coerce(r))]));
  let n = [...e.deleted].filter(id => baseIds.has(id)).length;
  for (const d of e.draft) { const cd = CAT[kind].coerce(d); if (!baseIds.has(cd.id) || JSON.stringify(cd) !== baseStr.get(cd.id)) n++; }
  return n;
}
function _syncSaveBtn(kind) {
  const btn = document.getElementById(CAT[kind].saveBtn); if (!btn) return;
  // Enabled state tracks _kindDirty (which includes a pure REORDER); _dirtyCount only labels the button.
  // A reorder-only change is dirty with count 0, so fall back to "Save changes" rather than a "0" label.
  const dirty = _kindDirty(kind), n = _dirtyCount(kind);
  btn.disabled = !dirty; btn.style.opacity = dirty ? '1' : '0.5'; btn.style.pointerEvents = dirty ? '' : 'none';
  const lbl = btn.querySelector('.cat-save-lbl');
  if (lbl) lbl.textContent = dirty ? (n > 0 ? `Save ${n} change${n > 1 ? 's' : ''}` : 'Save changes') : 'Save';
}
const _rowSel = (kind, id) => `[data-cat-row="${(window.CSS && CSS.escape) ? CSS.escape(kind + ':' + id) : kind + ':' + id}"]`;
function _scrollToRow(kind, id) {
  const row = document.querySelector(_rowSel(kind, id));
  // Leave the red outline on until the row is corrected (cleared by _catInput), not a timeout the user can miss.
  if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('cat-invalid'); }
}
function _focusCatField(kind, id) {
  setTimeout(() => document.querySelector(`${_rowSel(kind, id)} input[data-field="label"]`)?.focus(), 30);
}

// ── Reorder: up/down + pointer drag from the grip (touch-action:none → iPad-safe) ──
export function catalogMoveRow(kind, id, dir) {
  _ensureDraft(kind);
  const d = _ed[kind].draft, i = d.findIndex(r => r.id === id); if (i < 0) return;
  const j = i + (dir === 'up' ? -1 : 1); if (j < 0 || j >= d.length) return;
  [d[i], d[j]] = [d[j], d[i]];
  _renderKind(kind);
}
function _moveDraftTo(kind, id, overId, before) {
  const d = _ed[kind].draft, from = d.findIndex(r => r.id === id); if (from < 0) return;
  const [row] = d.splice(from, 1);
  let to = d.findIndex(r => r.id === overId); if (to < 0) { d.splice(from, 0, row); return; }
  if (!before) to += 1;
  d.splice(to, 0, row);
}
const _GHOST_LIFT = 14;   // px the drag ghost rides above the pointer, so the pointer sits near its top edge
let _dragKind = null, _dragId = null, _dragEl = null, _ghost = null, _dragStart = null, _dragging = false;
function _clearDropMarks() { document.querySelectorAll('.cat-drop-before,.cat-drop-after').forEach(e => e.classList.remove('cat-drop-before', 'cat-drop-after')); }
function _catDragDown(ev) {
  if (ev.button) return;
  const grip = ev.target.closest && ev.target.closest('.cat-grip'); if (!grip) return;
  const row = grip.closest('[data-cat-row]'); if (!row) return;
  const [kind, id] = row.dataset.catRow.split(':');
  ev.preventDefault();
  try { grip.setPointerCapture(ev.pointerId); } catch {}
  _dragKind = kind; _dragId = id; _dragEl = row; _dragStart = { x: ev.clientX, y: ev.clientY }; _dragging = false;
  document.addEventListener('pointermove', _catDragMove);
  document.addEventListener('pointerup', _catDragUp);
  document.addEventListener('pointercancel', _catDragUp);
}
function _catStartDrag() {
  _dragging = true;
  const r = _dragEl.getBoundingClientRect();
  _ghost = _dragEl.cloneNode(true);
  // zIndex above any modal; _GHOST_LIFT keeps the pointer near the ghost's top edge rather than mid-row.
  Object.assign(_ghost.style, { position: 'fixed', zIndex: '2147483500', pointerEvents: 'none', width: r.width + 'px', left: r.left + 'px', top: (_dragStart.y - _GHOST_LIFT) + 'px', opacity: '0.92', boxShadow: '0 10px 28px rgba(0,0,0,.28)', background: 'var(--surface-container-lowest,#fff)' });
  document.body.appendChild(_ghost);
  _dragEl.style.opacity = '0.35';
}
function _rowUnder(x, y) { const el = document.elementFromPoint(x, y); return el && el.closest && el.closest(`[data-cat-row^="${_dragKind}:"]`); }
function _catDragMove(ev) {
  // 6px dead-zone: a press that barely moves stays a tap (so tapping the grip doesn't start a phantom drag).
  if (!_dragging) { if (Math.hypot(ev.clientX - _dragStart.x, ev.clientY - _dragStart.y) < 6) return; _catStartDrag(); }
  ev.preventDefault();
  _ghost.style.top = (ev.clientY - _GHOST_LIFT) + 'px';
  _ghost.style.display = 'none';
  const over = _rowUnder(ev.clientX, ev.clientY);
  _ghost.style.display = '';
  _clearDropMarks();
  if (over && over !== _dragEl) { const rr = over.getBoundingClientRect(); over.classList.add(ev.clientY < rr.top + rr.height / 2 ? 'cat-drop-before' : 'cat-drop-after'); }
}
function _catDragUp(ev) {
  document.removeEventListener('pointermove', _catDragMove);
  document.removeEventListener('pointerup', _catDragUp);
  document.removeEventListener('pointercancel', _catDragUp);
  const wasDragging = _dragging; _dragging = false;
  if (_ghost) { _ghost.remove(); _ghost = null; }
  if (_dragEl) _dragEl.style.opacity = '';
  _clearDropMarks();
  const kind = _dragKind, id = _dragId;
  if (wasDragging && ev.type !== 'pointercancel') {
    const over = _rowUnder(ev.clientX, ev.clientY);
    if (over && over.dataset.catRow !== `${kind}:${id}`) {
      const overId = over.dataset.catRow.split(':')[1], rr = over.getBoundingClientRect();
      _ensureDraft(kind); _moveDraftTo(kind, id, overId, ev.clientY < rr.top + rr.height / 2);
    }
  }
  _dragKind = _dragId = _dragEl = _dragStart = null;
  if (kind && wasDragging) _renderKind(kind);   // a plain tap on the grip (no move) shouldn't rebuild the list
}

// ── Shared row bits ───────────────────────────────────────────────────────────
// `attrs` carries extra HTML attributes (maxlength on abbr, inputmode="decimal" on the money fields).
const _fInput = (field, val, ph, cls, attrs) => `<input data-field="${field}" ${attrs || ''} value="${escHtml(val == null ? '' : String(val))}" placeholder="${escHtml(ph)}" aria-label="${escHtml(ph)}" class="bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none ${cls || ''}">`;
function _rowControls(kind, id, idx, total) {
  const dis = c => c ? 'opacity:.3;pointer-events:none' : '';
  // Hit areas are ~40px for comfortable front-desk iPad taps; delete is set apart (ml-2) from the reorder
  // cluster so a mis-tap between the arrows can't land on delete.
  return `<span class="cat-grip material-symbols-outlined flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-outline-variant" title="Drag to reorder" aria-hidden="true" style="touch-action:none;cursor:grab;font-size:22px">drag_indicator</span>
    <button onclick="catalogMoveRow('${kind}','${id}','up')" title="Move up" aria-label="Move up" class="cat-ic flex-shrink-0 w-10 h-10 rounded-lg hover:bg-surface-container flex items-center justify-center text-on-surface-variant" style="${dis(idx === 0)}"><span class="material-symbols-outlined" style="font-size:20px">keyboard_arrow_up</span></button>
    <button onclick="catalogMoveRow('${kind}','${id}','down')" title="Move down" aria-label="Move down" class="cat-ic flex-shrink-0 w-10 h-10 rounded-lg hover:bg-surface-container flex items-center justify-center text-on-surface-variant" style="${dis(idx === total - 1)}"><span class="material-symbols-outlined" style="font-size:20px">keyboard_arrow_down</span></button>
    <button onclick="${kind === 'service' ? 'deleteService' : 'removeItem'}('${id}')" title="Delete" aria-label="Delete" class="cat-del flex-shrink-0 ml-2 w-10 h-10 rounded-full hover:bg-error/10 flex items-center justify-center text-on-surface-variant hover:text-error transition-colors"><span class="material-symbols-outlined" style="font-size:20px">delete</span></button>`;
}

// ── Services (page-draft: name / abbr / base / description + check-in & dashboard toggles + reorder) ──
export function renderServicesMerged() {
  const list = document.getElementById('services-merged-list'); if (!list) return;
  _ensureCatalogListeners(); _ensureDraft('service');
  const draft = _ed.service.draft;
  list.innerHTML = draft.length ? draft.map((s, i) => _serviceRowHtml(s, i, draft.length)).join('')
    : '<p class="text-sm font-body text-on-surface-variant py-4 text-center">No services yet. Add one to get started.</p>';
  _syncSaveBtn('service');
}
function _serviceRowHtml(s, idx, total) {
  const id = s.id, saved = _liveHas('service', id);
  const checkin = isServiceVisibleOnCheckin(id), dash = isServiceVisibleOnDash(id);
  const toggle = (on, label, fn, title) => `
    <button onclick="${fn}('${id}',this)" title="${title}" class="flex flex-col items-center gap-1 flex-shrink-0 px-1 py-1">
      <span class="text-[9px] font-body uppercase tracking-wider ${on ? 'text-primary' : 'text-outline-variant'}">${label}</span>
      <div class="mswitch relative w-14 h-7 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-surface-container-high'}"><div class="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${on ? 'left-7' : 'left-0.5'}"></div></div>
    </button>`;
  return `
  <div class="cat-row bg-surface-container-lowest rounded-xl px-4 py-3 border border-surface-container-high" data-cat-row="service:${id}">
    <div class="cat-fields flex items-center gap-2 flex-wrap">
      ${_fInput('label', s.label, 'Service name', 'flex-1 min-w-[140px] font-headline font-semibold')}
      ${_fInput('abbr', s.abbr, 'Abbr', 'w-16 text-center font-semibold', 'maxlength="4"')}
      <div class="flex items-center gap-1"><span class="text-sm text-on-surface-variant">$</span>${_fInput('baseCost', (s.baseCost != null && s.baseCost !== '' ? s.baseCost : ''), '0.00', 'w-20 text-right', 'inputmode="decimal"')}</div>
      ${_fInput('desc', s.desc, 'Description (optional)', 'flex-1 min-w-[180px]')}
    </div>
    <div class="cat-actions flex items-center gap-2 mt-2 flex-wrap">
      ${saved ? toggle(checkin, 'Check-in', 'toggleCheckinService', 'Show on the customer check-in screen') : '<span class="text-[11px] font-body text-outline-variant italic px-1">Save first to set visibility</span>'}
      ${saved ? toggle(dash, 'Dashboard', 'toggleDashService', 'Show in Assign, Turns, Queue & Calendar') : ''}
      <div class="ml-auto flex items-center gap-1">${_rowControls('service', id, idx, total)}</div>
    </div>
  </div>`;
}
export function showAddService() {
  _ensureDraft('service');
  const id = _uid('svc');
  _ed.service.draft.push({ id, label: '', abbr: '', baseCost: '', desc: '' });
  renderServicesMerged(); _focusCatField('service', id);
}
export function deleteService(id) {
  _ensureDraft('service');
  _ed.service.draft = _ed.service.draft.filter(r => r.id !== id);
  if (_liveHas('service', id)) _ed.service.deleted.add(id);   // track so the commit honors it (and prunes visibility ids)
  renderServicesMerged();
}

// ── Customer check-in service visibility (config.hidden_services) — instant-save, independent of the draft ──
export function isServiceVisibleOnCheckin(id) { return !cfg().hidden_services.includes(id); }
export function toggleCheckinService(id, btn) {
  const hidden = cfg().hidden_services;
  const nowVisible = hidden.includes(id);
  dispatch('config.set', { key: 'hidden_services', value: hidden.includes(id) ? hidden.filter(x => x !== id) : [...hidden, id] });
  if (btn) setSwitchVisual(btn, nowVisible); else renderServicesMerged();
}
export function toggleAllCheckinServices() {
  dispatch('config.set', { key: 'hidden_services', value: cfg().hidden_services.length === 0 ? cfg().services.map(s => s.id) : [] });
  renderServicesMerged();
}
// ── Dashboard service visibility (config.hidden_dash_services) ────────────────
export function isServiceVisibleOnDash(id) { return !cfg().hidden_dash_services.includes(id); }
export function toggleDashService(id, btn) {
  const hidden = cfg().hidden_dash_services;
  const nowVisible = hidden.includes(id);
  dispatch('config.set', { key: 'hidden_dash_services', value: hidden.includes(id) ? hidden.filter(x => x !== id) : [...hidden, id] });
  if (btn) setSwitchVisual(btn, nowVisible); else renderServicesMerged();
}
export function toggleAllDashServices() {
  dispatch('config.set', { key: 'hidden_dash_services', value: cfg().hidden_dash_services.length === 0 ? cfg().services.map(s => s.id) : [] });
  renderServicesMerged();
}

// ── Retail Items (page-draft: name / abbr / price + reorder) ──────────────────
export function renderSettingsItems() {
  const container = document.getElementById('settings-items-list'); if (!container) return;
  _ensureCatalogListeners(); _ensureDraft('item');
  const draft = _ed.item.draft;
  container.innerHTML = draft.length ? draft.map((it, i) => _itemRowHtml(it, i, draft.length)).join('')
    : '<p class="text-sm text-on-surface-variant py-2">No items yet.</p>';
  _syncSaveBtn('item');
}
function _itemRowHtml(it, idx, total) {
  const id = it.id;
  return `
  <div class="cat-row py-2 border-b border-surface-container-high last:border-0" data-cat-row="item:${id}">
    <div class="cat-fields flex items-center gap-2 flex-wrap">
      ${_fInput('label', it.label, 'Item name', 'flex-1 min-w-[120px]')}
      ${_fInput('abbr', it.abbr, 'Abbr', 'w-16 text-center font-semibold', 'maxlength="4"')}
      <div class="flex items-center gap-1"><span class="text-sm text-on-surface-variant">$</span>${_fInput('price', (it.price != null && it.price !== '' ? it.price : ''), '0.00', 'w-20 text-right', 'inputmode="decimal"')}</div>
      <div class="ml-auto flex items-center gap-1">${_rowControls('item', id, idx, total)}</div>
    </div>
  </div>`;
}
export function addItemRow() {
  _ensureDraft('item');
  const id = _uid('item');
  _ed.item.draft.push({ id, label: '', abbr: '', price: '' });
  renderSettingsItems(); _focusCatField('item', id);
}
export function removeItem(id) {
  _ensureDraft('item');
  _ed.item.draft = _ed.item.draft.filter(r => r.id !== id);
  if (_liveHas('item', id)) _ed.item.deleted.add(id);
  renderSettingsItems();
}

// ── Fees (unchanged — simple instant-save rows) ───────────────────────────────
function setFees(fees) { dispatch('config.set', { key: 'fees', value: fees }); }
export function renderSettingsFees() {
  const container = document.getElementById('settings-fees-list');
  if (!container) return;
  container.innerHTML = cfg().fees.map((fee, i) => `
    <div class="flex items-center gap-2 py-2 border-b border-surface-container-high last:border-0">
      <input type="text" value="${escHtml(fee.label)}" placeholder="Fee name"
        onchange="updateFeeField(${i},'label',this.value)"
        class="flex-1 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none">
      <select onchange="updateFeeField(${i},'type',this.value)"
        class="bg-surface-container border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none">
        <option value="flat"    ${fee.type==='flat'   ?'selected':''}>Flat $</option>
        <option value="percent" ${fee.type==='percent'?'selected':''}>Percent %</option>
      </select>
      <input type="text" inputmode="decimal" value="${fee.value || ''}" placeholder="0"
        onchange="updateFeeField(${i},'value',this.value)"
        class="w-16 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none text-right">
      <button onclick="removeFee(${i})" class="text-outline-variant hover:text-error transition-colors">
        <span class="material-symbols-outlined" style="font-size:16px">delete</span>
      </button>
    </div>`).join('') || '<p class="text-sm text-on-surface-variant py-2">No fees yet.</p>';
}
export function updateFeeField(i, field, value) {
  const fees = cfg().fees.map((f, idx) => idx === i ? { ...f, [field]: field === 'value' ? (parseFloat(value) || 0) : value } : f);
  setFees(fees);
}
export function addFeeRow() {
  setFees([...cfg().fees, { id: 'fee-' + Date.now(), label: '', type: 'flat', value: 0 }]);
  renderSettingsFees();
}
export function removeFee(i) {
  const f = cfg().fees[i];
  if (f && (f.label || f.value) && !confirm(`Remove "${f.label || 'this fee'}"?`)) return;
  setFees(cfg().fees.filter((_, idx) => idx !== i));
  renderSettingsFees();
}
