// ── Floor Plan v2: free-positioned station canvas ───────────────────────────
// Each station is one physical seat → ONE customer. Manicure: 1 customer / 1 tech /
// up to 3 services. Pedicure: 1 customer / up to 3 techs / up to 4 services.
// The station shows that customer + their service·tech lines (sized to fit, no scroll).
// Layout is free-form (x/y/w/h per station) + per-station fill/outline/shape, saved
// additively in config.station_layout. Edit mode: move (incl. multi-select), resize,
// recolor, reshape. View mode: drag a customer onto a seat; tap a customer to open
// Assign & Price. Reuses the a.station field (set on all the customer's assignments).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, todayStr, localDateStr, formatElapsed, partyLetterMap, escHtml } from '../utils.js';
import { getAssignmentStatus, isPaidStatus, entryStatusSince, serviceLineStyle, applyAssignmentStatus, applyEntryStatus, effectiveServiceStatus } from './status.js';
import { getStations, stationDefs, stationType, stationLabel, stationCategories, categoryDef, categoryMaxTechs } from './queue.js';
import { getActiveTurnsOrder, getTechStatusColor, getTechTurns } from './turns.js';
import { serviceTimeInfo } from './servicetime.js';

const cfg = () => getState().config;
const q   = () => getState().queue;
const svc = id => cfg().services.find(s => s.id === id);
const staffById = id => cfg().staff.find(s => s.id === id);

let floorEditMode = false;
let _fpZoom = 1;               // edit-mode VIEW zoom (visual scale only — never changes the saved layout)
const _selected = new Set();   // station ids selected in edit mode
let _fpLetters = new Map();    // groupId → A/B/C party tag (matches queue/turns)

// Logical (pre-zoom) canvas coords from a pointer event — divides out the view scale
// so marquee/drag math stays accurate at any zoom.
function canvasPoint(ev) {
  const c = document.getElementById('floorplan-canvas'); if (!c) return { x: 0, y: 0 };
  const r = c.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / _fpZoom, y: (ev.clientY - r.top) / _fpZoom };
}
// Stations whose tile rect intersects the given (logical) rectangle — marquee hit test.
function stationsInRect(x1, y1, x2, y2) {
  return getStations().filter(id => { const L = layoutFor(id); return L.x < x2 && L.x + L.w > x1 && L.y < y2 && L.y + L.h > y1; });
}

const GAP = 10;
// Per-category default tile size + accent color now live in config.station_categories
// (categoryDef). catDims/catColor read from there with a safe fallback so the floor
// plan keeps working even for a station whose category was removed.
function catDims(typeId)  { const c = categoryDef(typeId); return { w: c?.w || 120, h: c?.h || 90 }; }
function catColor(typeId) { return categoryDef(typeId)?.color || '#1a5c7a'; }

function containerW() { const g = document.getElementById('floorplan-grid'); return g && g.clientWidth ? g.clientWidth : 720; }

// Deterministic default layout: each category gets its own zone, stacked top→bottom
// in category order. A station's default slot = its index within its category's grid,
// offset below all earlier categories' zones.
function computedDefault(id) {
  const type = stationType(id), { w, h } = catDims(type), W = containerW();
  let yOffset = 0;
  for (const c of stationCategories()) {
    if (c.id === type) break;
    const cnt = stationDefs().filter(s => s.type === c.id).length;
    if (!cnt) continue;
    const cw = c.w || 120, ch = c.h || 90;
    const cPerRow = Math.max(1, Math.floor((W + GAP) / (cw + GAP)));
    yOffset += Math.ceil(cnt / cPerRow) * (ch + GAP) + 26;
  }
  const list = stationDefs().filter(s => s.type === type).map(s => s.id);
  const idx = Math.max(0, list.indexOf(id));
  const perRow = Math.max(1, Math.floor((W + GAP) / (w + GAP)));
  const col = idx % perRow, row = Math.floor(idx / perRow);
  const y = yOffset + row * (h + GAP);
  return { x: col * (w + GAP), y, w, h, fill: catColor(type), outline: catColor(type), shape: 'rounded' };
}
function layout() { return cfg().station_layout || {}; }
function layoutFor(id) { return { ...computedDefault(id), ...(layout()[id] || {}) }; }
function saveLayout(next) { dispatch('config.set', { key: 'station_layout', value: next }); }

// ── Live occupancy (one customer per station) ─────
function activeAssignments(e) { return (e.assignments || []).filter(a => !isPaidStatus(getAssignmentStatus(e, a))); }
function collectFloor() {
  const today = todayStr();
  const byStation = {};   // stationId -> entry
  const unplaced = [];
  q().forEach(e => {
    if (isPaidStatus(e.status)) return;   // paid customers leave the floor; complete stays (awaiting payment)
    if (localDateStr(new Date(e.checkinTime)) !== today) return;
    const active = activeAssignments(e);
    const stationIds = getStations();
    const at = active.find(a => a.station && stationIds.includes(a.station));
    // A customer's seat = a service's station, else the entry-level station set by dragging on the plan.
    const station = at ? at.station : (e.station && stationIds.includes(e.station) ? e.station : null);
    // Keep first-in-queue-order as the seated occupant; route a same-station COLLISION (two
    // entries claiming one seat — cross-device race, or two dropdown assigns to the same station)
    // to the tray instead of dropping it, so the second guest stays visible + re-seatable.
    if (station && !byStation[station]) byStation[station] = e;
    else unplaced.push(e);   // not seated, OR a station collision loser — kept visible either way
  });
  return { byStation, unplaced };
}
function entryInservice(e) { return activeAssignments(e).some(a => getAssignmentStatus(e, a) === 'inservice'); }
// Small tech avatar for a tile service row: photo if set, else a colored initial; a faint "?" when
// the service still has no tech (waiting). Deterministic color per tech so it's recognizable.
const _AV_COLORS = ['#7c5cbf', '#1a7aa8', '#2a7a4f', '#b0612a', '#8f1a5c', '#1a5252', '#7a4f1a'];
function _techAvatar(tech, fs) {
  const d = Math.round(15 * fs);
  const box = `display:inline-flex;align-items:center;justify-content:center;width:${d}px;height:${d}px;border-radius:50%;flex-shrink:0;border:1.5px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.18);font-size:${Math.round(8 * fs)}px;font-weight:700;line-height:1;overflow:hidden`;
  if (!tech) return `<span style="${box};background:#cfd8d8;color:#8a98a0">?</span>`;
  if (tech.photo) return `<img src="${escHtml(tech.photo)}" style="${box};object-fit:cover">`;
  let h = 0; for (const ch of String(tech.id || tech.name || '')) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return `<span style="${box};background:${_AV_COLORS[h % _AV_COLORS.length]};color:#fff">${escHtml((tech.name || '?').charAt(0).toUpperCase())}</span>`;
}
// ALL of the customer's services (this seat's + others + still-waiting), each as a row:
// status dot + tech avatar + service · tech · $ , with the elapsed▸avg badge on the line below.
function custLines(e, stationId, fs = 1) {
  const assigns = e.assignments || [];
  const sids = [...new Set([...(e.services || []), ...assigns.map(a => a.serviceId)])];
  const dotPx = Math.round(9 * fs);
  return sids.map(sid => {
    const a = assigns.find(x => x.serviceId === sid);
    const status = a ? getAssignmentStatus(e, a) : 'waiting';
    if (a && isPaidStatus(status)) return '';   // drop a paid line (whole entry leaves the floor when all paid)
    const ls = serviceLineStyle(a ? effectiveServiceStatus(e, a) : status);
    const s = svc(sid), t = a && a.techId ? staffById(a.techId) : null;
    const dot = `<span style="display:inline-block;width:${dotPx}px;height:${dotPx}px;border-radius:50%;flex-shrink:0;box-sizing:border-box;${ls.dot}"></span>`;
    const main = `<div style="display:flex;align-items:center;gap:${Math.round(3 * fs)}px;font-size:${Math.round(10.5 * fs)}px;color:#374151;min-width:0">
      ${dot}${_techAvatar(t, fs)}<span class="truncate" style="min-width:0">${s ? escHtml(s.label) : 'Service'}${t ? ' · ' + escHtml(t.name.split(' ')[0]) : ''}${a && a.cost ? ' · $' + Number(a.cost).toFixed(0) : ''}${t ? '' : ' · Wait'}</span>
    </div>`;
    const sti = a ? serviceTimeInfo(a) : null;
    const stiHtml = sti ? `<div style="font-size:${Math.round(9 * fs)}px;font-weight:700;color:${sti.color};padding-left:${Math.round(20 * fs)}px">${sti.text}</div>` : '';
    return main + stiHtml;
  }).filter(Boolean).join('');
}

function stationHtml(id, entry) {
  const L = layoutFor(id);
  const radius = L.shape === 'circle' ? '9999px' : L.shape === 'square' ? '4px' : '14px';
  const sel = _selected.has(id);
  const fs = L.font || 1;
  const live = !!entry && (entryInservice(entry) || entry.status === 'inservice');
  const complete = !!entry && !live && entry.status === 'complete';
  // Empty (or any station while editing the layout) shows the editor's custom color.
  // In the live view, an occupied seat MATCHES the customer's status (C9 palette):
  // TEAL in service, GREEN complete/done (ready to pay), AMBER waiting.
  const accent = catColor(stationType(id));
  let bg = (L.fill || accent) + '17', border = L.outline || accent;
  if (entry && !floorEditMode) {
    // C9/D13 (recolored v4.79): In Service = green, Done/complete = blue, Waiting = amber.
    if (live) { bg = '#d8ecdf'; border = '#2a7a4f'; }
    else if (complete) { bg = '#d3e4ef'; border = '#1a5c7a'; }
    else { bg = '#ffe9c4'; border = '#d4860a'; }
  }
  let content;
  if (entry) {
    content = `<div class="${floorEditMode ? '' : 'floor-bubble cursor-pointer'} h-full w-full flex flex-col justify-center px-1.5 py-1 overflow-hidden" ${floorEditMode ? '' : `data-entry-id="${entry.id}"`}>
      <div class="flex items-start justify-between gap-1">
        ${entry.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:${Math.round(15*fs)}px;height:${Math.round(15*fs)}px;border-radius:4px;background:${entry.groupColor||'#888'};color:#fff;font-size:${Math.round(9*fs)}px;font-weight:800;flex-shrink:0;margin-top:1px">${_fpLetters.get(entry.groupId)||'•'}</span>` : ''}
        <div class="font-semibold" style="font-size:${Math.round(11 * fs)}px;color:#1f2937;flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.15">${escHtml(entry.name)}</div>
        <span class="flex-shrink-0" style="font-size:${Math.round(9 * fs)}px;color:#52606d" data-checkin-ts="${entryStatusSince(entry)}">${formatElapsed(entryStatusSince(entry))}</span>
      </div>
      <div class="overflow-hidden leading-tight">${custLines(entry, id, fs)}</div></div>`;
  } else {
    content = `<div class="h-full w-full flex items-center justify-center" style="font-size:${Math.round(12 * fs)}px;font-weight:800;color:${border};opacity:0.55">${escHtml(stationLabel(id))}</div>`;
  }
  return `<div class="floor-station absolute ${floorEditMode ? 'cursor-move' : ''}" data-station="${id}"
    style="left:${L.x}px;top:${L.y}px;width:${L.w}px;height:${L.h}px;box-sizing:border-box;border:2px solid ${border};border-radius:${radius};background:${bg};overflow:hidden;${sel ? 'outline:3px solid #1a5252;outline-offset:2px;' : ''}">
    ${entry ? `<div class="absolute" style="top:1px;left:5px;font-size:9px;font-weight:700;color:${border};opacity:0.65;pointer-events:none">${escHtml(stationLabel(id))}</div>` : ''}
    ${entry && !floorEditMode ? `<span class="material-symbols-outlined fp-grip" style="position:absolute;bottom:1px;right:2px">drag_indicator</span>` : ''}
    ${content}
  </div>`;
}

// Display-only row of today's staff (active rotation) with their status color code,
// centered under the floor. Reuses the turns-grid colors so it matches.
function renderFloorStaffRow() {
  const el = document.getElementById('floorplan-staff-row'); if (!el) return;
  const ids = getActiveTurnsOrder();
  if (!ids.length) { el.innerHTML = ''; return; }
  // Next walk-in: the available tech (live "Available") with the fewest turns; tie → first in order.
  let nextUpId = null, _nuTurns = Infinity;
  for (const id of ids) { if (getTechStatusColor(id).label !== 'Available') continue; const tt = getTechTurns(id).total; if (tt < _nuTurns) { _nuTurns = tt; nextUpId = id; } }
  const bubbles = ids.map(id => {
    const st = staffById(id); if (!st) return '';
    const c = getTechStatusColor(id);
    // Off's near-white fill needs a visible ring/initial color.
    const ringC = c.bg === '#f3f4f6' ? '#c2c8ce' : c.bg;
    // Live view: each tech is draggable onto a station to assign them to a service there that
    // has a seat but no tech yet (handled by the pointer-drag system below). Not in edit mode.
    const drag = floorEditMode ? '' : 'floor-tech';
    // Outline + soft transparent fill in the status color (photos keep the colored ring).
    const avatar = st.photo
      ? `<img src="${st.photo}" draggable="false" style="width:68px;height:68px;box-sizing:border-box;border-radius:50%;object-fit:cover;border:3px solid ${ringC};box-shadow:0 2px 5px rgba(0,0,0,.18)">`
      : `<div style="display:flex;align-items:center;justify-content:center;width:68px;height:68px;box-sizing:border-box;border-radius:50%;background:${ringC}22;border:3px solid ${ringC};color:${ringC};font-family:var(--font-headline);font-weight:700;font-size:26px;box-shadow:0 2px 5px rgba(0,0,0,.18)">${escHtml((st.name||'?').charAt(0).toUpperCase())}</div>`;
    const turns = getTechTurns(id).total;
    const turnsTxt = Number.isInteger(turns) ? String(turns) : turns.toFixed(1);
    const turnsBadge = `<span title="${turnsTxt} turns today" style="position:absolute;bottom:-3px;right:-3px;min-width:29px;height:29px;padding:0 4px;border-radius:15px;background:#1a5252;color:#fff;font-size:15px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid var(--surface-container-lowest,#fff);box-sizing:border-box">${turnsTxt}</span>`;
    const nextBadge = (!floorEditMode && id === nextUpId) ? `<span title="Next up" style="position:absolute;top:-7px;left:50%;transform:translateX(-50%);background:#1a5252;color:#fff;font-size:9px;font-weight:700;padding:1px 7px;border-radius:999px;white-space:nowrap;display:inline-flex;align-items:center;gap:2px;box-shadow:0 1px 3px rgba(0,0,0,.25)"><span class="material-symbols-outlined" style="font-size:11px">arrow_upward</span>Next</span>` : '';
    const grip = floorEditMode ? '' : `<span class="material-symbols-outlined fp-grip" style="position:absolute;top:-2px;left:-6px;background:var(--surface-container-lowest,#fff);border-radius:7px;padding:1px;box-shadow:0 1px 3px rgba(0,0,0,.25)">drag_indicator</span>`;
    return `<div class="flex flex-col items-center gap-1 ${drag}" data-tech-id="${id}" style="width:78px${floorEditMode ? '' : ';cursor:grab'}" ${floorEditMode ? '' : 'title="Tap for status · drag onto a station to assign"'}>
      <div style="position:relative">${avatar}${turnsBadge}${nextBadge}${grip}</div>
      <span style="font-size:13px;font-weight:700;color:var(--md-on-surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:76px">${escHtml(st.name.split(' ')[0])}</span>
      <span style="font-size:10px;font-weight:700;color:${c.bg === '#f3f4f6' ? '#9ca3af' : c.bg}">${c.label}</span>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="flex flex-wrap items-start justify-center gap-3 pt-3 border-t border-surface-container-high">${bubbles}</div>`;
}

export function renderFloorPlan() {
  const grid = document.getElementById('floorplan-grid');
  if (!grid) return;
  const { byStation, unplaced } = collectFloor();
  _fpLetters = partyLetterMap(q());
  renderFloorStaffRow();

  const modeLabel = document.getElementById('floorplan-mode-label');
  if (modeLabel) modeLabel.textContent = floorEditMode ? 'Editing layout — drag to move, tap to select, then style below' : 'Live';
  const editBtn = document.getElementById('floorplan-edit-btn');
  if (editBtn) editBtn.innerHTML = floorEditMode
    ? '<span class="material-symbols-outlined" style="font-size:16px">check</span> Done'
    : '<span class="material-symbols-outlined" style="font-size:16px">edit</span> Edit layout';
  document.getElementById('floorplan-reset-btn')?.classList.toggle('hidden', !floorEditMode);
  document.getElementById('floorplan-edit-tools')?.classList.toggle('hidden', !floorEditMode);
  const zl = document.getElementById('floorplan-zoom-label'); if (zl) zl.textContent = Math.round(_fpZoom * 100) + '%';
  renderFloorProps();

  const tray = document.getElementById('floorplan-tray');
  if (tray) {
    // Always render the tray box in live mode (even when empty) so the grid below
    // doesn't jump when guests get added/seated. Only hide it while editing layout.
    if (floorEditMode) tray.innerHTML = '';
    else if (unplaced.length === 0) tray.innerHTML = `<div class="bg-surface-container rounded-xl p-2">
      <div class="text-[11px] font-body font-semibold text-on-surface-variant">All guests seated — drag a guest here to un-seat.</div></div>`;
    else tray.innerHTML = `<div class="bg-surface-container rounded-xl p-2">
      <div class="text-[11px] font-body font-semibold text-on-surface-variant mb-1">Not seated — drag onto a station (${unplaced.length})</div>
      <div class="flex gap-1.5 flex-wrap">${unplaced.map(e => `<div class="floor-bubble cursor-pointer rounded-lg px-2 py-1 flex items-center gap-1" data-entry-id="${e.id}" style="background:${entryInservice(e) ? '#cfe0e0' : '#ffe9c4'};color:#1f2937;font-size:11px"><span class="material-symbols-outlined fp-grip">drag_indicator</span>${e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:${e.groupColor||'#888'};color:#fff;font-size:8px;font-weight:800;flex-shrink:0">${_fpLetters.get(e.groupId)||'•'}</span>` : ''}<span class="font-semibold">${escHtml(e.name)}</span></div>`).join('')}</div></div>`;
  }

  grid.style.position = 'relative';
  let maxRight = 0, maxBottom = 0;
  const stationIds = getStations();
  stationIds.forEach(id => { const L = layoutFor(id); maxRight = Math.max(maxRight, L.x + L.w); maxBottom = Math.max(maxBottom, L.y + L.h); });
  const cw = maxRight + GAP, ch = maxBottom + GAP;
  const stationsHtml = stationIds.map(id => stationHtml(id, byStation[id] || null)).join('');
  if (floorEditMode) {
    // Full size while arranging (drag stays precise). Cap the grid to the viewport so
    // it scrolls INTERNALLY — otherwise a station placed far down/right can't be reached.
    grid.style.overflow = 'auto';
    const availH = Math.max(280, window.innerHeight - grid.getBoundingClientRect().top - 16);
    grid.style.height = Math.min(ch * _fpZoom, availH) + 'px';
    // View zoom: scale the canvas VISUALLY only (every station's saved x/y/w/h is
    // untouched). A sizer wrapper carries the SCALED dimensions so the scroll area
    // matches what's shown (transform alone doesn't change layout size).
    grid.innerHTML = `<div style="position:relative;width:${cw * _fpZoom}px;height:${ch * _fpZoom}px">
      <div id="floorplan-canvas" style="position:absolute;top:0;left:0;width:${cw}px;height:${ch}px;transform-origin:top left;transform:scale(${_fpZoom})">${stationsHtml}</div></div>`;
  } else {
    // Live view: scale the whole canvas to fit the screen — no horizontal scroll —
    // and center it horizontally (transform-origin is top-left, so shift by the
    // leftover width). Keeps the iPad look; just stops it hugging the left on desktop.
    const availW = grid.clientWidth || 720;
    const availH = Math.max(280, window.innerHeight - grid.getBoundingClientRect().top - 16);
    const s = Math.min(1, availW / cw, availH / ch);
    const offsetX = Math.max(0, (availW - cw * s) / 2);
    grid.style.overflow = 'hidden';
    grid.style.height = (ch * s) + 'px';
    grid.innerHTML = `<div id="floorplan-canvas" style="position:relative;width:${cw}px;height:${ch}px;transform-origin:top left;transform:translateX(${offsetX}px) scale(${s})">${stationsHtml}</div>`;
  }
}

// ── Edit-mode properties panel ────────────────────
function renderFloorProps() {
  const el = document.getElementById('floorplan-props');
  if (!el) return;
  // Box stays visible the whole time you're editing (so the layout below doesn't
  // jump as you select/deselect); shows a hint when nothing is selected yet.
  if (!floorEditMode) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (_selected.size === 0) {
    el.innerHTML = `<div class="text-xs font-body text-on-surface-variant py-1">Tap a station to select it, then style it here. Shift-tap to select more than one.</div>`;
    return;
  }
  const ids = [..._selected];
  const ref = layoutFor(ids[0]);
  // Show the reference (first-selected) dimensions as exact numbers so two seats
  // can be compared at a glance; flag "mixed" when the selection isn't uniform.
  const dims = ids.map(id => layoutFor(id));
  const sameW = dims.every(d => Math.round(d.w) === Math.round(ref.w));
  const sameH = dims.every(d => Math.round(d.h) === Math.round(ref.h));
  const sameShape = dims.every(d => d.shape === ref.shape);
  const sameFont = dims.every(d => (d.font || 1) === (ref.font || 1));
  const numCls = 'w-12 text-center border border-surface-container-high rounded bg-transparent py-0.5 text-xs font-body';
  el.innerHTML = `
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      <span class="text-xs font-headline font-bold text-on-surface">${ids.length} selected</span>
      <button onclick="fpClearSelection()" class="text-xs text-primary underline">clear</button>
      ${ids.length >= 2 ? `<button onclick="fpMatchSize()" class="fp-step" style="width:auto;padding:0 10px" title="Make every selected station the same width, height & shape as the first one">Match size</button>` : ''}
    </div>
    <div class="flex items-center gap-3 flex-wrap text-xs font-body">
      <label class="flex items-center gap-1">Fill <input type="color" value="${ref.fill}" onchange="fpSetProp('fill',this.value)" class="w-7 h-7 rounded border border-surface-container-high bg-transparent"></label>
      <label class="flex items-center gap-1">Outline <input type="color" value="${ref.outline}" onchange="fpSetProp('outline',this.value)" class="w-7 h-7 rounded border border-surface-container-high bg-transparent"></label>
      <span class="flex items-center gap-1">W <button onclick="fpResize('w',-12)" class="fp-step">−</button><input type="number" value="${Math.round(ref.w)}" onchange="fpSetSize('w',this.value)" class="${numCls}"><button onclick="fpResize('w',12)" class="fp-step">+</button>${sameW?'':'<span class="text-[10px] text-outline">mixed</span>'}</span>
      <span class="flex items-center gap-1">H <button onclick="fpResize('h',-10)" class="fp-step">−</button><input type="number" value="${Math.round(ref.h)}" onchange="fpSetSize('h',this.value)" class="${numCls}"><button onclick="fpResize('h',10)" class="fp-step">+</button>${sameH?'':'<span class="text-[10px] text-outline">mixed</span>'}</span>
      <span class="flex items-center gap-1">Shape
        <button onclick="fpSetProp('shape','rounded')" class="fp-step ${sameShape&&ref.shape==='rounded'?'fp-on':''}">▢</button>
        <button onclick="fpSetProp('shape','square')" class="fp-step ${sameShape&&ref.shape==='square'?'fp-on':''}">◻</button>
        <button onclick="fpSetProp('shape','circle')" class="fp-step ${sameShape&&ref.shape==='circle'?'fp-on':''}">◯</button>
        ${sameShape?'':'<span class="text-[10px] text-outline">mixed</span>'}
      </span>
      <span class="flex items-center gap-1">Text <button onclick="fpTextSize(-0.1)" class="fp-step" style="font-size:11px">A−</button><input type="number" step="0.1" min="0.7" max="1.8" value="${(ref.font||1).toFixed(1)}" onchange="fpSetFont(this.value)" class="${numCls}"><button onclick="fpTextSize(0.1)" class="fp-step" style="font-size:15px">A+</button>${sameFont?'':'<span class="text-[10px] text-outline">mixed</span>'}</span>
    </div>`;
}
function applyToSelected(mut) {
  const next = { ...layout() };
  _selected.forEach(id => { next[id] = { ...layoutFor(id), ...mut(layoutFor(id)) }; });
  saveLayout(next);
  renderFloorPlan();
}
export function fpSetProp(prop, val) { applyToSelected(() => ({ [prop]: val })); }
export function fpResize(dim, delta) { applyToSelected(L => ({ [dim]: Math.max(48, (L[dim] || 0) + delta) })); }
export function fpSetSize(dim, val) { const n = parseInt(val, 10); if (!Number.isFinite(n)) return; applyToSelected(() => ({ [dim]: Math.max(48, n) })); }
// One click: make every selected station match the first-selected one's size & shape.
export function fpMatchSize() {
  const ids = [..._selected]; if (ids.length < 2) return;
  const ref = layoutFor(ids[0]);
  applyToSelected(() => ({ w: ref.w, h: ref.h, shape: ref.shape }));
}
export function fpTextSize(delta) { applyToSelected(L => ({ font: Math.min(1.8, Math.max(0.7, Math.round(((L.font || 1) + delta) * 100) / 100)) })); }
export function fpSetFont(val) { const n = parseFloat(val); if (!Number.isFinite(n)) return; applyToSelected(() => ({ font: Math.min(1.8, Math.max(0.7, Math.round(n * 100) / 100)) })); }
export function fpClearSelection() { _selected.clear(); renderFloorPlan(); }
export function fpSelectAll() { getStations().forEach(id => _selected.add(id)); renderFloorPlan(); }

// ── View zoom (edit mode) — visual only, never saved ──────────────────────────
const FP_ZMIN = 0.3, FP_ZMAX = 1.6;
export function fpZoom(dir) {
  _fpZoom = Math.min(FP_ZMAX, Math.max(FP_ZMIN, Math.round(_fpZoom * (dir > 0 ? 1.25 : 0.8) * 100) / 100));
  renderFloorPlan();
}
// Fit the whole layout into the visible area — one tap to recover a tile pushed far out.
export function fpZoomFit() {
  const grid = document.getElementById('floorplan-grid'); if (!grid) return;
  let maxR = 0, maxB = 0;
  getStations().forEach(id => { const L = layoutFor(id); maxR = Math.max(maxR, L.x + L.w); maxB = Math.max(maxB, L.y + L.h); });
  const cw = maxR + GAP, ch = maxB + GAP;
  const availW = grid.clientWidth || 720;
  const availH = Math.max(280, window.innerHeight - grid.getBoundingClientRect().top - 16);
  _fpZoom = Math.round(Math.max(FP_ZMIN, Math.min(FP_ZMAX, Math.min(availW / cw, availH / ch))) * 100) / 100;
  renderFloorPlan();
}

export function toggleFloorEdit() { floorEditMode = !floorEditMode; _selected.clear(); _fpZoom = 1; renderFloorPlan(); }
export function resetFloorLayout() {
  const doReset = () => { _selected.clear(); saveLayout({}); renderFloorPlan(); showToast('Floor layout reset'); };
  if (window.showWarnModal) window.showWarnModal('Reset layout?', 'Restore the default station arrangement, sizes, and colors?', doReset);
  else doReset();
}

// ── Commit: seat a customer (one per station) ─────
function seatCustomer(entryId, stationId) {
  const e = q().find(x => String(x.id) === String(entryId));
  if (!e) return;
  // A 'paid' broadcast (or other edit) from another device can land during the drag; re-dispatching
  // the whole entry would revert it. Bail if it's already checked out.
  if (isPaidStatus(e.status)) { showToast(`${e.name.split(' ')[0]} is already paid`); renderFloorPlan(); return; }
  const occupant = collectFloor().byStation[stationId];
  if (occupant && String(occupant.id) !== String(e.id)) { showToast(`${stationId} is taken by ${occupant.name}`); return; }
  e.station = stationId;                                    // seat the customer — works with OR without an assigned tech
  activeAssignments(e).forEach(a => { a.station = stationId; });   // keep per-service station in sync (no-op if none yet)
  dispatch('queue.upsert', { entry: e });
  renderFloorPlan();
  showToast(`Seated ${e.name.split(' ')[0]} at ${stationId}`);
}

// ── Assign a tech by dropping them on a station ───
// Stations that have a customer with a service seated here but no tech yet — the valid drop
// targets when dragging a tech from the staff row.
function validTechStations() {
  const { byStation } = collectFloor();
  const set = new Set();
  Object.entries(byStation).forEach(([sid, e]) => {
    if (activeAssignments(e).some(a => a.station === sid && !a.techId)) set.add(sid);
  });
  return set;
}
function assignTechToStation(techId, stationId) {
  const e = collectFloor().byStation[stationId];
  if (!e) { showToast(`No customer at ${stationLabel(stationId)}`); return; }
  if (isPaidStatus(e.status)) { showToast(`${e.name.split(' ')[0]} is already paid`); renderFloorPlan(); return; }
  // Capacity: how many DISTINCT techs are already on this customer at this station?
  const techsHere = new Set((e.assignments || []).filter(a => a.station === stationId && a.techId).map(a => a.techId));
  const cap = categoryMaxTechs(stationType(stationId));
  if (!techsHere.has(techId) && techsHere.size >= cap) {
    showToast(`${stationLabel(stationId)} is full (${cap} tech${cap !== 1 ? 's' : ''})`); renderFloorPlan(); return;
  }
  // Pool = the customer's services that still need a tech (any — incl. waiting / no station yet).
  const assignedSids = new Set((e.assignments || []).map(a => a.serviceId));
  const pool = [
    ...(e.assignments || []).filter(a => !a.techId && !isPaidStatus(getAssignmentStatus(e, a))).map(a => ({ serviceId: a.serviceId, assignment: a })),
    ...(e.services || []).filter(sid => !assignedSids.has(sid)).map(sid => ({ serviceId: sid, assignment: null })),
  ];
  if (pool.length === 0) { showToast('All services already have a tech'); renderFloorPlan(); return; }
  if (pool.length === 1) { _assignTechToService(e, techId, stationId, pool[0]); return; }
  _openServicePicker(e, techId, stationId, pool);   // 2+ → ask which
}
// Put `techId` on one of the customer's services at this station + start it (In Service). No price
// prompt — price is set later. (Front-desk whole-entry write; the queue.upsert per-assignment merge
// protects a concurrent tech change.)
function _assignTechToService(e, techId, stationId, item) {
  if (!e.assignments) e.assignments = [];
  let a = item.assignment;
  if (!a) { a = { serviceId: item.serviceId, station: '', status: 'waiting', cost: 0 }; e.assignments.push(a); }
  a.techId = techId;
  a.station = stationId;
  applyAssignmentStatus(a, 'inservice');   // start the service + bank timing + stamp a.updatedAt
  applyEntryStatus(e);                      // recompute entry status + statusSince
  dispatch('queue.upsert', { entry: e });
  renderFloorPlan(); window.renderQueue?.(); window.renderTurns?.();
}
// Lightweight picker (2+ un-teched services): tap a service to give it to the dragged tech.
function _openServicePicker(e, techId, stationId, pool) {
  document.getElementById('_floorSvcPicker')?.remove();
  const tech = staffById(techId);
  const m = document.createElement('div');
  m.id = '_floorSvcPicker';
  m.className = 'fixed inset-0 z-[80] flex items-center justify-center';
  m.style.cssText = 'background:rgba(15,26,26,.45)';
  const btns = pool.map((item, i) => {
    const s = svc(item.serviceId);
    return `<button data-i="${i}" class="w-full text-left px-4 py-3 rounded-xl border border-surface-container-high hover:bg-surface-container font-headline font-semibold text-on-surface flex items-center gap-2"><span class="material-symbols-outlined text-primary" style="font-size:18px">add_task</span>${escHtml(s ? s.label : item.serviceId)}</button>`;
  }).join('');
  m.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-5 w-72 shadow-2xl fade-up mx-4" onclick="event.stopPropagation()">
      <div class="text-base font-headline font-bold text-on-surface mb-0.5">Assign ${escHtml((tech?.name || 'tech').split(' ')[0])} to…</div>
      <div class="text-xs font-body text-on-surface-variant mb-3">${escHtml(e.name || 'Customer')} · ${escHtml(stationLabel(stationId))}</div>
      <div class="space-y-2">${btns}</div>
      <button id="_floorSvcCancel" class="w-full mt-3 py-2 rounded-xl text-on-surface-variant font-body">Cancel</button>
    </div>`;
  m.addEventListener('click', () => m.remove());
  m.querySelector('#_floorSvcCancel').addEventListener('click', () => m.remove());
  m.querySelectorAll('button[data-i]').forEach(btn => btn.addEventListener('click', () => {
    const item = pool[parseInt(btn.dataset.i, 10)];
    m.remove();
    _assignTechToService(e, techId, stationId, item);
  }));
  document.body.appendChild(m);
}

// ── Alignment snapping (snap a dragged station's edges/centers to others) ─────
function snapMove(primaryId, base, rawDx, rawDy, selectedSet) {
  const L = layoutFor(primaryId);
  const px = base.x + rawDx, py = base.y + rawDy;
  const myV = [px, px + L.w / 2, px + L.w];   // left, centerX, right
  const myH = [py, py + L.h / 2, py + L.h];   // top, centerY, bottom
  const TH = 7;
  let bdx = Infinity, bdy = Infinity, guideX = null, guideY = null;
  getStations().forEach(id => {
    if (selectedSet.has(id)) return;
    const o = layoutFor(id);
    const oV = [o.x, o.x + o.w / 2, o.x + o.w];
    const oH = [o.y, o.y + o.h / 2, o.y + o.h];
    myV.forEach(m => oV.forEach(ov => { const d = ov - m; if (Math.abs(d) <= TH && Math.abs(d) < Math.abs(bdx)) { bdx = d; guideX = ov; } }));
    myH.forEach(m => oH.forEach(oh => { const d = oh - m; if (Math.abs(d) <= TH && Math.abs(d) < Math.abs(bdy)) { bdy = d; guideY = oh; } }));
  });
  return { dx: rawDx + (bdx === Infinity ? 0 : bdx), dy: rawDy + (bdy === Infinity ? 0 : bdy), guideX: bdx === Infinity ? null : guideX, guideY: bdy === Infinity ? null : guideY };
}
function fpGuide(axis, pos) {
  const grid = document.getElementById('floorplan-canvas') || document.getElementById('floorplan-grid'); if (!grid) return;
  const gid = axis === 'v' ? 'fp-guide-v' : 'fp-guide-h';
  let g = document.getElementById(gid);
  if (pos === null) { if (g) g.style.display = 'none'; return; }
  if (!g) {
    g = document.createElement('div'); g.id = gid;
    g.style.cssText = axis === 'v'
      ? 'position:absolute;top:0;bottom:0;width:0;border-left:1px dashed #1a5252;pointer-events:none;z-index:50'
      : 'position:absolute;left:0;right:0;height:0;border-top:1px dashed #1a5252;pointer-events:none;z-index:50';
    grid.appendChild(g);
  }
  g.style.display = ''; if (axis === 'v') g.style.left = pos + 'px'; else g.style.top = pos + 'px';
}
function clearGuides() { fpGuide('v', null); fpGuide('h', null); }

// ── Drag (pointer events) ─────────────────────────
(function initFloorDrag() {
  const THRESH = 6;
  let startX = 0, startY = 0, pending = null, dragging = false, clone = null;
  let mode = null, dragEntryId = null, dragStation = null, dragTechId = null, moveStart = null, moveDelta = null;
  let isTouch = false, marqueeEl = null, marqueeStart = null;
  const closest = (el, sel) => { while (el && el !== document.body) { if (el.matches && el.matches(sel)) return el; el = el.parentElement; } return null; };
  function stationAt(x, y) { if (clone) clone.style.display = 'none'; const el = document.elementFromPoint(x, y); if (clone) clone.style.display = ''; return closest(el, '.floor-station'); }

  function onDown(e) {
    const panel = document.getElementById('panel-floorplan');
    if (!panel || !panel.classList.contains('active') || e.button) return;
    isTouch = e.pointerType === 'touch';
    if (floorEditMode) {
      const st = closest(e.target, '.floor-station');
      if (st) { mode = 'station'; dragStation = st.dataset.station; pending = st; }
      // Empty canvas: desktop draws a marquee; touch lets the gesture scroll natively
      // (and a touch with no movement is treated as a tap-to-clear in onUp). Guard: only when
      // the pointer is actually on the canvas. A tap on the edit toolbar above it (#floorplan-props
      // W/H steppers, colors, shape, font — or the zoom tools) is NOT a canvas gesture; without
      // this, pointerup ran "tap empty → clear selection" BEFORE the control's click, wiping
      // _selected so resize/recolor/reshape silently no-oped on the now-empty selection.
      else if (closest(e.target, '#floorplan-grid')) { mode = 'marquee'; marqueeStart = canvasPoint(e); }
      else return;
    } else {
      const techEl = closest(e.target, '.floor-tech');
      if (techEl) { mode = 'tech'; dragTechId = techEl.dataset.techId; pending = techEl; }
      else {
        const b = closest(e.target, '.floor-bubble'); if (!b) return;
        mode = 'bubble'; dragEntryId = b.dataset.entryId; pending = b;
      }
    }
    startX = e.clientX; startY = e.clientY;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  }
  function startDrag() {
    dragging = true;
    if (mode === 'station') {
      if (!_selected.has(dragStation)) { _selected.clear(); _selected.add(dragStation); renderFloorPlan(); }
      moveStart = {}; _selected.forEach(id => { const L = layoutFor(id); moveStart[id] = { x: L.x, y: L.y }; });
    } else {
      const rect = pending.getBoundingClientRect();
      clone = pending.cloneNode(true);
      Object.assign(clone.style, { position: 'fixed', zIndex: '9999', pointerEvents: 'none', width: rect.width + 'px', left: rect.left + 'px', top: rect.top + 'px', opacity: '0.9', transform: 'scale(1.03)', boxShadow: '0 6px 20px rgba(0,0,0,.25)' });
      document.body.appendChild(clone);
      pending.style.opacity = '0.4';
      // Dragging a tech: highlight the stations that have a service awaiting a tech.
      if (mode === 'tech') { const valid = validTechStations(); document.querySelectorAll('.floor-station').forEach(s => { if (valid.has(s.dataset.station)) s.style.outline = '3px dashed #1a5252'; }); }
    }
  }
  function onMove(e) {
    if (mode === 'marquee') {
      if (isTouch) return;   // touch: don't hijack the gesture — let the canvas scroll
      if (!marqueeEl) { if (Math.hypot(e.clientX - startX, e.clientY - startY) <= THRESH) return; startMarquee(); }
      e.preventDefault(); updateMarquee(e);
      return;
    }
    if (!dragging) { if (Math.hypot(e.clientX - startX, e.clientY - startY) > THRESH) startDrag(); else return; }
    e.preventDefault();
    if (mode === 'station') {
      const dx = (e.clientX - startX) / _fpZoom, dy = (e.clientY - startY) / _fpZoom;   // undo view zoom → canvas units
      const snap = snapMove(dragStation, moveStart[dragStation], dx, dy, _selected);
      moveDelta = { dx: snap.dx, dy: snap.dy };
      _selected.forEach(id => { const el = document.querySelector(`.floor-station[data-station="${id}"]`); if (el && moveStart[id]) { el.style.left = Math.max(0, moveStart[id].x + snap.dx) + 'px'; el.style.top = Math.max(0, moveStart[id].y + snap.dy) + 'px'; } });
      fpGuide('v', snap.guideX); fpGuide('h', snap.guideY);
    } else if (clone) {
      clone.style.left = (e.clientX - clone.offsetWidth / 2) + 'px'; clone.style.top = (e.clientY - clone.offsetHeight / 2) + 'px';
      document.querySelectorAll('.floor-station').forEach(s => { s.style.boxShadow = ''; });
      const tgt = stationAt(e.clientX, e.clientY); if (tgt) tgt.style.boxShadow = 'inset 0 0 0 3px #1a5252';
    }
  }
  function onUp(e) {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    const wasDragging = dragging; dragging = false;
    if (clone) { clone.remove(); clone = null; }
    if (pending && (mode === 'bubble' || mode === 'tech')) pending.style.opacity = '';
    document.querySelectorAll('.floor-station').forEach(s => { s.style.boxShadow = ''; s.style.outline = ''; });
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (mode === 'marquee') {
      if (marqueeEl) { commitMarquee(e.shiftKey); removeMarquee(); }                       // desktop box → select
      else if (Math.hypot(dx, dy) <= THRESH && _selected.size) { _selected.clear(); renderFloorPlan(); }   // tap empty → clear
      resetState(); return;
    }
    if (!wasDragging) {
      if (mode === 'bubble' && dragEntryId) window.showGroupAssignModal?.(dragEntryId);
      // Tapping a tech (no drag) opens the exact same tech-status menu as the turns grid.
      // showTechStatusMenu reads event.currentTarget for positioning, so hand it the tech el.
      else if (mode === 'tech' && dragTechId) window.showTechStatusMenu?.({ stopPropagation() {}, currentTarget: pending, clientX: e.clientX, clientY: e.clientY }, dragTechId);
      // Build a multi-selection: Shift-click (desktop) OR a plain tap (iPad has no Shift)
      // toggles this station; a plain mouse click selects only this one.
      else if (mode === 'station' && dragStation) {
        if (e.shiftKey || isTouch) { if (_selected.has(dragStation)) _selected.delete(dragStation); else _selected.add(dragStation); }
        else { _selected.clear(); _selected.add(dragStation); }
        renderFloorPlan();
      }
    } else if (mode === 'bubble') {
      const tgt = stationAt(e.clientX, e.clientY); if (tgt) seatCustomer(dragEntryId, tgt.dataset.station); else renderFloorPlan();
    } else if (mode === 'tech') {
      const tgt = stationAt(e.clientX, e.clientY); if (tgt) assignTechToStation(dragTechId, tgt.dataset.station); else renderFloorPlan();
    } else if (mode === 'station' && moveStart) {
      const d = moveDelta || { dx: dx / _fpZoom, dy: dy / _fpZoom };
      const next = { ...layout() };
      // Clamp BOTH x and y to ≥ 0 so a tile can't be dragged off the left/top edge and lost.
      _selected.forEach(id => { const s = moveStart[id]; if (s) next[id] = { ...layoutFor(id), x: Math.max(0, s.x + d.dx), y: Math.max(0, s.y + d.dy) }; });
      saveLayout(next); renderFloorPlan();
    }
    clearGuides();
    resetState();
  }
  function onCancel() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    if (clone) { clone.remove(); clone = null; }
    removeMarquee();
    document.querySelectorAll('.floor-station').forEach(s => { s.style.boxShadow = ''; s.style.outline = ''; });
    clearGuides();
    dragging = false; resetState();
  }
  function resetState() { pending = null; mode = null; dragEntryId = dragStation = dragTechId = null; moveStart = null; moveDelta = null; marqueeStart = null; }

  // ── Marquee (rubber-band) select — desktop only; coords are logical (pre-zoom) ──
  function startMarquee() {
    const c = document.getElementById('floorplan-canvas'); if (!c) return;
    marqueeEl = document.createElement('div');
    marqueeEl.style.cssText = 'position:absolute;border:1.5px dashed #1a5252;background:rgba(26,82,82,0.12);z-index:60;pointer-events:none';
    c.appendChild(marqueeEl);
  }
  function updateMarquee(e) {
    if (!marqueeEl || !marqueeStart) return;
    const p = canvasPoint(e), s = marqueeStart;
    const x1 = Math.min(s.x, p.x), y1 = Math.min(s.y, p.y), x2 = Math.max(s.x, p.x), y2 = Math.max(s.y, p.y);
    marqueeEl.style.left = x1 + 'px'; marqueeEl.style.top = y1 + 'px'; marqueeEl.style.width = (x2 - x1) + 'px'; marqueeEl.style.height = (y2 - y1) + 'px';
    const hit = new Set(stationsInRect(x1, y1, x2, y2));   // live highlight without re-rendering (keeps it snappy)
    document.querySelectorAll('.floor-station').forEach(el => {
      const on = hit.has(el.dataset.station) || _selected.has(el.dataset.station);
      el.style.outline = on ? '3px solid #1a5252' : ''; el.style.outlineOffset = on ? '2px' : '';
    });
  }
  function commitMarquee(additive) {
    const x1 = parseFloat(marqueeEl.style.left) || 0, y1 = parseFloat(marqueeEl.style.top) || 0;
    const x2 = x1 + (parseFloat(marqueeEl.style.width) || 0), y2 = y1 + (parseFloat(marqueeEl.style.height) || 0);
    const hit = stationsInRect(x1, y1, x2, y2);
    if (!additive) _selected.clear();
    hit.forEach(id => _selected.add(id));
    renderFloorPlan();
  }
  function removeMarquee() { if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; } }

  document.addEventListener('pointerdown', onDown);
  // Esc clears the selection while editing (desktop convenience; ignored elsewhere).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !floorEditMode || !_selected.size) return;
    if (!document.getElementById('panel-floorplan')?.classList.contains('active')) return;
    _selected.clear(); renderFloorPlan();
  });
})();
