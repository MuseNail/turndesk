// ── Utilities (pure-ish helpers + clock/toast/numpad) ───────────────────────
// Ported from the original utils.js. No global mutable app state lives here.
// Functions used by inline HTML handlers are exported and attached to window in main.js.
import { getState } from './store.js';

// Numpad price entry mode: whole dollars (digits build $, dot adds optional cents) vs the
// default cents accumulator. Read from synced config; store.js has no imports so no cycle.
const _wholeDollars = () => !!getState().config?.numpad_whole_dollars;

// ── Ticket total (single source of truth) ────────
// A ticket's true total = its parts: services + retail items + fees − discount.
// Used at pay-time, in reports, and by the heal — so a stale cached `totalCost`
// can never disagree with what was actually rung up. (Refunds have no parts; their
// stored negative total is authoritative — callers must skip refunds.)
export function ticketTotal(r) {
  const svc   = (r.assignments || []).reduce((s, a) => s + (a.cost || 0), 0);
  const items = (r.items || []).reduce((s, i) => s + ((i.price || 0) * (i.qty || 0)), 0);
  const fees  = (r.fees || []).reduce((s, f) => s + (f.amount || 0), 0);
  return Math.max(0, svc + items + fees - (r.discount || 0));
}

// ── HTML / attribute escapers for untrusted data ─────────────────────────────
// Square/Google customer + catalog data is externally sourced (online booking, import)
// and gets interpolated into innerHTML and inline on*= handlers. escHtml for HTML-text/
// attribute context; escAttrJs for a value placed inside a single-quoted JS string that
// itself sits inside a double-quoted on*= attribute (JS-string escape first, then HTML-
// escape so the browser's attribute decode yields a clean JS literal).
export const escHtml = s => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const escAttrJs = s => (s == null ? '' : String(s)).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Pill switch in-place flip ────────────────────
// Flip a single .mswitch toggle's visual state WITHOUT re-rendering its whole list.
// Rebuilding a list on every tap recreated the row + button under the user's finger —
// which on a touchscreen drops taps (feels slow / "doesn't work") and snaps the :active
// press + the knob's slide into a visible "bounce." `el` is the control passed as `this`
// from the inline onclick: either the .mswitch track itself (role-permission toggles) or a
// wrapper that contains it (services / staff / calendar). An optional label <span> inside
// the wrapper recolors with the state.
export function setSwitchVisual(el, on) {
  if (!el) return;
  const track = el.classList?.contains('mswitch') ? el : el.querySelector('.mswitch');
  if (!track) return;
  const knob = track.firstElementChild, label = el.querySelector('span');
  if (label) { label.classList.toggle('text-primary', on); label.classList.toggle('text-outline-variant', !on); }
  track.classList.toggle('bg-primary', on);
  track.classList.toggle('bg-surface-container-high', !on);
  knob?.classList.toggle('left-7', on);
  knob?.classList.toggle('left-0.5', !on);
}

// ── Clock ────────────────────────────────────────
export function startClock() {
  function tick() {
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const m = now.getMinutes().toString().padStart(2, '0');
    const clockEl = document.getElementById('clock-display');
    if (clockEl) clockEl.textContent = `${h}:${m}`;

    const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const dateEl = document.getElementById('date-display');
    if (dateEl) dateEl.textContent = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
  }
  tick();
  setInterval(tick, 1000);
}

export function updateDeskDate() {
  const now = new Date();
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const el = document.getElementById('desk-date');
  if (el) el.textContent = `${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()}`;
}

// ── Auto Capitalize ───────────────────────────────
export function autoCapitalize(input) {
  const val = input.value;
  if (!val) return;
  input.value = val.replace(/(?:^|\s|-)\S/g, c => c.toUpperCase());
}

// ── Local Date Helper ─────────────────────────────
// Always local date (not UTC) so end-of-day in US timezones keeps the right date.
export function localDateStr(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
export function todayStr() { return localDateStr(new Date()); }
// Shared label for every date-picker button across the app (Turns / Queue / Reports / Transactions /
// Calendar). Only TODAY gets a word ("Today · Tue, Jun 9"); every other day shows just the date
// ("Mon, Jun 8") — no "Yesterday" — so the button stays a constant width. Accepts a Date, a
// YYYY-MM-DD string, or null (= today).
export function dateBtnLabel(dateOrStr) {
  const d = dateOrStr instanceof Date ? new Date(dateOrStr) : dateOrStr ? new Date(dateOrStr + 'T12:00:00') : new Date();
  const short = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  return Math.round((dd - t) / 86400000) === 0 ? `Today · ${short}` : short;
}

// Day-rollover gate decision (pure, testable). Given the SHARED last-rollover marker (a localDateStr
// from synced config) and today's date string, returns what the rollover should do:
//   'seed'     — marker absent → set it to today, clear NOTHING (so first run / upgrade never wipes)
//   'rollover' — a genuinely new day across all devices → archive + clear the roster ONCE
//   'skip'     — already rolled over today → leave the roster/breaks/chat alone
// Reading the marker from synced state (not a per-device flag) is what stops a device first opened
// mid-day from re-clearing the technicians the front desk already set up. See main.js.
export function rolloverAction(globalLast, today) {
  if (!globalLast) return 'seed';
  if (globalLast !== today) return 'rollover';
  return 'skip';
}

// ── Deduplication helper ──────────────────────────
export function dedupByLabel(arr) {
  const seen = new Set();
  return (arr || []).filter(item => {
    const key = (item.label || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Sort helper ───────────────────────────────────
// Alphabetical by .name (case-insensitive). For display/selection lists only —
// not for custom-ordered data (turns rotation, calendar column order).
export function byName(a, b) { return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }); }

// Map each distinct party groupId (first-seen order) → a letter A,B,C… so members of
// the same check-in can be tagged at-a-glance (live queue/turns + history).
export function partyLetterMap(items) {
  const m = new Map(); let i = 0;
  (items || []).forEach(e => { const g = e && e.groupId; if (g && !m.has(g)) { m.set(g, String.fromCharCode(65 + (i % 26))); i++; } });
  return m;
}

// ── Elapsed Time Timer ────────────────────────────
let _elapsedTimer = null;
export function startElapsedTimer() {
  if (_elapsedTimer) return;
  _elapsedTimer = setInterval(updateElapsedTimes, 10000);
  updateElapsedTimes();
}
export function updateElapsedTimes() {
  const now = Date.now();
  document.querySelectorAll('[data-checkin-ts]').forEach(el => {
    const ts = parseInt(el.dataset.checkinTs);
    if (!ts) return;
    const mins = Math.floor((now - ts) / 60000);
    if (mins < 1) el.textContent = 'just now';
    else if (mins < 60) el.textContent = mins + 'm';
    else el.textContent = Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  });
}
export function formatElapsed(checkinTime) {
  const ts = checkinTime instanceof Date ? checkinTime.getTime() : new Date(checkinTime).getTime();
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

// Collision-proof id for queue entries + records. The old `Date.now()*1000 + random(0-999)`
// could collide: a whole party is created in the same millisecond, so two guests had only a
// 1-in-1000 random to tell them apart (and two devices at the same instant could clash too) —
// a collision silently overwrote one entry (store is keyed by id). Device id + time + a
// per-session counter makes every id unique within a party AND across devices.
let _idCounter = 0;
export function newEntryId() {
  let dev = '';
  try { dev = localStorage.getItem('turndesk_device_id') || ''; } catch {}
  if (!dev) dev = 'd' + Math.random().toString(36).slice(2, 6);
  return `${dev}-${Date.now()}-${(++_idCounter).toString(36)}`;
}

// Second token on a queue/turns card's time line: while waiting/in-service/complete
// it's a LIVE elapsed timer (data-checkin-ts is ticked by updateElapsedTimes); once
// PAID, the time stops mattering — show the checkout time (when it was marked paid)
// instead of an ever-growing elapsed.
export function statusTimeHtml(sinceMs, isPaid) {
  if (isPaid) return `<span style="white-space:nowrap">✓ ${new Date(sinceMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
  return `<span data-checkin-ts="${sinceMs}">${formatElapsed(sinceMs)}</span>`;
}

// ── Phone Formatting ─────────────────────────────
export function formatPhone(input) {
  let digits = input.value.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1); // strip US country code (+1) so E.164 numbers don't render as (1xx) xxx-xxxx
  digits = digits.slice(0, 10);
  let formatted = '';
  if (digits.length === 0)      formatted = '';
  else if (digits.length <= 3)  formatted = `(${digits}`;
  else if (digits.length <= 6)  formatted = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  else                          formatted = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  input.value = formatted;
}

// ── Numeric Keypad ────────────────────────────────
let _numpadTarget = null, _numpadRaw = '', _numpadMode = 'cost';
let _numpadHostObs = null;

// ── Money-field calculator (mode 'cost') ─────────────────────────────────────
// The money numpad doubles as an adding machine: digits build a plain-dollar operand ("40", "12.50")
// and the operator keys (+ − × ÷) chain them with LEFT-TO-RIGHT running evaluation (40 + 5 × 2 = 90,
// like a cash register), keeping a small receipt tape. The field updates live to the running result,
// so any close path keeps it (no "=" needed). _numpadRaw holds the operand currently being typed.
let _calcAcc = null;    // running accumulated result (null until the first operator commits)
let _calcOp = null;     // pending operator: '+' '-' '*' '/'
let _calcTape = [];      // committed receipt lines, e.g. ['40.00', '+ 5.00']
const _isCalc = () => _numpadMode === 'cost';
const _opSym = op => ({ '+': '+', '-': '−', '*': '×', '/': '÷' }[op] || op);
const _operandVal = () => parseFloat(_numpadRaw || '0') || 0;
function _applyOp(a, op, b) { a = a || 0; if (op === '+') return a + b; if (op === '-') return a - b; if (op === '*') return a * b; if (op === '/') return b === 0 ? a : a / b; return b; }
// The live evaluated value = acc combined with the operand being typed (rounded to cents).
function _calcValue() {
  let v;
  if (_calcOp === null) v = _operandVal();                 // no operator yet → just the operand
  else if (_numpadRaw === '') v = _calcAcc;                // operator pressed, awaiting the next operand
  else v = _applyOp(_calcAcc, _calcOp, _operandVal());
  return Math.round((v || 0) * 100) / 100;
}
function _calcReset() { _calcAcc = null; _calcOp = null; _calcTape = []; }
// Commit the current operand under the pending operator, then arm `op` as the next operator.
function _calcPushOp(op) {
  if (_numpadRaw === '' && _calcAcc === null) { _calcOp = op; return; }   // leading operator → just arm it
  if (_calcAcc === null) { _calcAcc = _operandVal(); _calcTape = [_operandVal().toFixed(2)]; }
  else if (_numpadRaw !== '') { _calcTape.push(`${_opSym(_calcOp)} ${_operandVal().toFixed(2)}`); _calcAcc = _applyOp(_calcAcc, _calcOp, _operandVal()); }
  _calcOp = op;
  _numpadRaw = '';
}
// Auto-close the numpad if the modal/popup that owns the field it's editing closes
// (gets `hidden`, display:none, or removed) — so closing a modal also dismisses the
// numpad without needing to hit OK. Watches the field's nearest containing modal.
function _watchNumpadHost(inputEl) {
  if (_numpadHostObs) { _numpadHostObs.disconnect(); _numpadHostObs = null; }
  const host = inputEl?.closest?.('[id$="-modal"], .fixed');
  if (!host || host.id === 'numpad-modal') return;
  const check = () => {
    if (host.classList.contains('hidden') || host.style.display === 'none' || !host.isConnected) _closeNumpadModal();
  };
  _numpadHostObs = new MutationObserver(check);
  _numpadHostObs.observe(host, { attributes: true, attributeFilter: ['class', 'style'] });
  if (host.parentElement) _numpadHostObs.observe(host.parentElement, { childList: true });
}

// On a touch device the on-screen numpad replaces the OS keyboard; on a desktop (pointer:fine) the
// native input is used instead. A device can opt INTO the on-screen numpad anyway (desktop testing,
// or a desktop with a touchscreen) by setting localStorage turndesk_numpad_force = '1' — off by default,
// so prod behavior is unchanged.
const _numpadForced = () => { try { return localStorage.getItem('turndesk_numpad_force') === '1'; } catch { return false; } };
export function openNumpad(inputEl, label, mode) {
  if (window.matchMedia('(pointer: fine)').matches && !_numpadForced()) return;
  _numpadMode = mode === 'percent' ? 'percent' : (mode === 'int' ? 'int' : 'cost'); _numpadTarget = inputEl;
  const existing = (inputEl.value || '').replace(/[^0-9.]/g, '');
  if (_numpadMode === 'percent') {
    // A percent is a plain whole/decimal value (20 → 20%), NOT a cents accumulator.
    _numpadRaw = existing && !isNaN(parseFloat(existing)) ? String(parseFloat(existing)) : '';
    document.getElementById('numpad-plus-key').textContent = '';
  } else if (_numpadMode === 'int') {
    // A plain whole count (bill quantity) — no decimals, no cents accumulator.
    const n = parseInt(existing.replace(/\./g, ''), 10);
    _numpadRaw = isFinite(n) && n > 0 ? String(n) : '';
    document.getElementById('numpad-plus-key').textContent = '';
  } else {
    // Money mode = the calculator: plain-dollar operand entry ("45", "12.50") + operators with a tape.
    _numpadRaw = existing && !isNaN(parseFloat(existing)) ? String(parseFloat(existing)) : '';
    _calcReset();
    document.getElementById('numpad-plus-key').textContent = '+';
  }
  document.getElementById('numpad-label').textContent = label || (_numpadMode === 'percent' ? 'Percent' : _numpadMode === 'int' ? 'Count' : 'Cost');
  document.getElementById('numpad-dot-key').textContent  = _numpadMode === 'int' ? '' : '.';
  // Operator rail + receipt tape only in money mode (hidden for percent/int).
  const ops = document.getElementById('numpad-ops'); if (ops) ops.style.display = _isCalc() ? 'flex' : 'none';
  const tape = document.getElementById('numpad-tape'); if (tape) tape.classList.toggle('hidden', !_isCalc());
  const clr = document.getElementById('numpad-clear-btn'); if (clr) clr.style.display = '';   // AC is for amounts, not phone
  _numpadUpdateDisplay();
  _setNumpadChrome(false);   // amounts: dimmed modal (no autocomplete to preserve)
  const m = document.getElementById('numpad-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  inputEl.blur();
  _watchNumpadHost(inputEl);
}

// Phone numpad is a FLOATING panel (no full-screen backdrop) and updates the input
// live as you type, so the customer autocomplete stays visible and tappable above
// it. iPad's native "tel" keyboard is the full QWERTY, so this gives a clean numpad.
export function openPhoneNumpad(inputEl, label) {
  if (window.matchMedia('(pointer: fine)').matches && !_numpadForced()) return;
  _numpadMode = 'phone'; _numpadTarget = inputEl;
  _numpadRaw = (inputEl.value || '').replace(/\D/g, '').slice(0, 10);
  document.getElementById('numpad-label').textContent = label || 'Phone Number';
  document.getElementById('numpad-dot-key').textContent  = '';
  document.getElementById('numpad-plus-key').textContent = '';
  // No AC in phone mode — it crowded the number on the iPad; the backspace key handles edits.
  const clr = document.getElementById('numpad-clear-btn'); if (clr) clr.style.display = 'none';
  _numpadUpdateDisplay();
  _setNumpadChrome(true);   // floating: lets the autocomplete show + be tapped
  const m = document.getElementById('numpad-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  inputEl.blur();
  _watchNumpadHost(inputEl);
  setTimeout(_numpadMirrorAc, 0);   // field may already hold digits — show matches immediately
}

// Floating = no dim backdrop, clicks pass through everywhere except the panel
// itself (so the autocomplete dropdown stays interactive). Modal = the original
// dimmed bottom sheet used for amounts.
function _setNumpadChrome(floating) {
  const m = document.getElementById('numpad-modal'); if (!m) return;
  const panel = m.firstElementChild;
  if (floating) { m.classList.remove('bg-on-surface/40'); m.style.pointerEvents = 'none'; if (panel) panel.style.pointerEvents = 'auto'; }
  else { m.classList.add('bg-on-surface/40'); m.style.pointerEvents = ''; if (panel) panel.style.pointerEvents = ''; }
}
// Live-write the phone field as digits are typed so the autocomplete filters.
function _numpadSyncPhone() {
  if (!_numpadTarget) return;
  _numpadTarget.value = _numpadRaw;   // acSearch → formatPhone reformats on input
  _numpadTarget.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(_numpadMirrorAc, 0);     // after acSearch has rendered the field's dropdown
}
// Mirror the field's autocomplete matches INTO the numpad sheet. The field's own dropdown
// renders inside its host modal's stacking context (e.g. z-50), so the z-90 numpad sheet
// covers it on a tablet — the operator had to close the numpad to see/tap a match. The
// cloned items keep their inline onmousedown="acFill…" handlers; #numpad-ac then dismisses
// the numpad (dismiss, not confirm — confirming would clobber the picked value).
function _numpadMirrorAc() {
  const strip = document.getElementById('numpad-ac'); if (!strip) return;
  if (_numpadMode !== 'phone' || !_numpadTarget || !_numpadTarget.isConnected) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
  const src = _numpadTarget.closest('.ac-input-wrap')?.querySelector('.autocomplete-list')
           || _numpadTarget.parentElement?.querySelector('.autocomplete-list');
  const has = src && !src.classList.contains('hidden') && src.innerHTML.trim();
  strip.innerHTML = has ? src.innerHTML : '';
  strip.classList.toggle('hidden', !has);
}
// Live-write amount/percent fields as digits are typed (mirrors _numpadSyncPhone), writing
// exactly what numpadConfirm would. This makes the running total update as you type AND makes
// the ✓ optional: the value already lives in the field, so any close path (tap-away, switching
// fields, Save) keeps it — no confirm tap required, and switching fields can't drop a value.
function _numpadSyncAmount() {
  if (!_numpadTarget || _numpadMode === 'phone') return;
  if (_numpadMode === 'int') {
    const n = parseInt(_numpadRaw || '0', 10) || 0;
    _numpadTarget.value = n > 0 ? String(n) : '';
    _numpadTarget.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (_numpadMode === 'percent') {
    const v = parseFloat(_numpadRaw);
    _numpadTarget.value = !isNaN(v) && v > 0 ? String(v) : '';
  } else {
    const v = _calcValue();   // money mode: the live running result
    _numpadTarget.value = v > 0 ? String(v) : '';
  }
  _numpadTarget.dispatchEvent(new Event('input', { bubbles: true }));
}
// Hide the numpad WITHOUT writing back (used when an autocomplete pick already set
// the field — confirming would clobber it with the partial typed digits).
export function dismissNumpad() { _closeNumpadModal(); }

function _numpadUpdateDisplay() {
  const el = document.getElementById('numpad-display');
  if (_numpadMode === 'int') {
    el.textContent = _numpadRaw || '0';
    return;
  }
  if (_numpadMode === 'phone') {
    const d = _numpadRaw;
    let f = '';
    if (d.length === 0) f = '';
    else if (d.length <= 3) f = '(' + d;
    else if (d.length <= 6) f = '(' + d.slice(0,3) + ') ' + d.slice(3);
    else f = '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6,10);
    el.textContent = f || '—';
  } else if (_numpadMode === 'percent') {
    el.textContent = (_numpadRaw || '0') + '%';
  } else {
    // Money mode = the calculator: big display shows the running value; the tape shows the steps.
    el.textContent = '$' + _calcValue().toFixed(2);
    const tape = document.getElementById('numpad-tape');
    if (tape) {
      const lines = [..._calcTape];
      if (_numpadRaw !== '') lines.push((_calcOp && _calcAcc !== null ? _opSym(_calcOp) + ' ' : '') + _numpadRaw);   // live current operand
      tape.innerHTML = lines.length > 1 ? lines.map(l => `<div>${l}</div>`).join('') : '';
      tape.scrollTop = tape.scrollHeight;
    }
  }
}

export function numpadKey(key) {
  if (_numpadMode === 'phone') {
    if (key === '.' || key === '+') return;
    if (_numpadRaw.length >= 10) return;
    if (key === '00') {
      if (_numpadRaw.length + 2 <= 10) _numpadRaw += '00';
      else if (_numpadRaw.length + 1 <= 10) _numpadRaw += '0';
    } else { _numpadRaw += key; }
    _numpadUpdateDisplay(); _numpadSyncPhone();
    return;
  }
  if (_numpadMode === 'int') {
    if (key === '.' || key === '+') return;
    let raw = _numpadRaw;
    if (key === '00') { if (raw === '' || raw === '0') return; raw += '00'; }
    else { raw = raw === '0' ? key : raw + key; }
    if (raw.length > 4) return;   // cap at 9999 of a single denomination
    _numpadRaw = raw; _numpadUpdateDisplay(); _numpadSyncAmount();
    return;
  }
  if (_numpadMode === 'percent') {
    if (key === '+') return;
    let raw = _numpadRaw;
    if (key === '.') { if (raw.includes('.')) return; raw = (raw === '' ? '0' : raw) + '.'; }
    else if (key === '00') { if (raw === '' || raw === '0') return; raw += '00'; }
    else { raw = raw === '0' ? key : raw + key; }
    if (raw.replace('.', '').length > 4) return;
    _numpadRaw = raw; _numpadUpdateDisplay(); _numpadSyncAmount();
    return;
  }
  // Money mode = the calculator. Operators chain operands (left-to-right running eval); digits and
  // the dot build the current plain-dollar operand (max 2 decimals), same as whole-dollar entry.
  if (key === '+' || key === '-' || key === '*' || key === '/') { _calcPushOp(key); _numpadUpdateDisplay(); _numpadSyncAmount(); return; }
  let raw = _numpadRaw;
  if (key === '.') { if (raw.includes('.')) return; raw = (raw === '' ? '0' : raw) + '.'; }
  else if (key === '00') {
    if (raw.includes('.')) { const dec = raw.split('.')[1] || ''; if (dec.length === 0) raw += '00'; else if (dec.length === 1) raw += '0'; }
    else if (raw !== '' && raw !== '0') raw += '00';
  } else {
    if (raw.includes('.')) { const [i, d = ''] = raw.split('.'); if (d.length >= 2) return; raw = i + '.' + d + key; }
    else raw = raw === '0' ? key : raw + key;
  }
  if (raw.split('.')[0].length > 6) return;
  _numpadRaw = raw; _numpadUpdateDisplay(); _numpadSyncAmount();
}
export function numpadClear() { _numpadRaw = ''; if (_isCalc()) _calcReset(); _numpadUpdateDisplay(); if (_numpadMode === 'phone') _numpadSyncPhone(); else _numpadSyncAmount(); }

export function numpadBackspace() { _numpadRaw = _numpadRaw.slice(0, -1); _numpadUpdateDisplay(); if (_numpadMode === 'phone') _numpadSyncPhone(); else _numpadSyncAmount(); }

export function numpadConfirm() {
  if (_numpadTarget) {
    if (_numpadMode === 'phone') {
      const d = _numpadRaw;
      let f = '';
      if (d.length === 10) f = '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
      else if (d.length > 0) f = d;
      _numpadTarget.value = f;
    } else if (_numpadMode === 'int') {
      const n = parseInt(_numpadRaw || '0', 10) || 0;
      _numpadTarget.value = n > 0 ? String(n) : '';
    } else if (_numpadMode === 'percent') {
      const v = parseFloat(_numpadRaw);
      _numpadTarget.value = !isNaN(v) && v > 0 ? String(v) : '';
    } else {
      const v = _calcValue();   // money mode: the final running result
      _numpadTarget.value = v > 0 ? String(v) : '';
    }
    _numpadTarget.dispatchEvent(new Event('input', { bubbles: true }));
  }
  _closeNumpadModal();
}
export function closeNumpad() { numpadConfirm(); }
// Commit an OPEN numpad's typed value into its field. Called before saving/paying so a
// fee/cost typed as the "last step" isn't lost (the numpad otherwise only writes the
// value on its ✓, and closing the host modal discards it). No-op if nothing's open.
export function commitNumpad() {
  const m = document.getElementById('numpad-modal');
  if (m && !m.classList.contains('hidden')) numpadConfirm();
}

// ── Desktop "silent calculator" on amount fields (QuickBooks-style) ──────────
// Type an arithmetic expression into any money/amount field ("40+5*2") and it evaluates when you
// leave the field. LEFT-TO-RIGHT running eval — same as the on-screen numpad, so iPad and desktop
// agree (40+5*2 = 90, not 50). Safe: a hand-written tokenizer, never eval(). Returns null when the
// value isn't an expression (a plain number is left untouched).
export function evalAmountExpression(str) {
  const norm = String(str == null ? '' : str).replace(/×/g, '*').replace(/÷/g, '/').replace(/[^0-9.+\-*/]/g, '');
  if (!/\d\s*[+\-*/]/.test(norm)) return null;   // needs a number followed by an operator → it's an expression
  const tokens = norm.match(/(\d+\.?\d*|\.\d+|[+\-*/])/g);
  if (!tokens) return null;
  let acc = parseFloat(tokens[0]); if (isNaN(acc)) return null;
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i], n = parseFloat(tokens[i + 1]);
    if (isNaN(n)) break;
    acc = op === '+' ? acc + n : op === '-' ? acc - n : op === '*' ? acc * n : op === '/' ? (n === 0 ? acc : acc / n) : acc;
  }
  return Math.round(acc * 100) / 100;
}
// An amount-style field = the money/percent inputs the numpad serves (inputmode none/decimal), never
// a phone field. These are the fields the desktop calculator + select-on-focus apply to.
export const isAmountField = el => !!el && el.tagName === 'INPUT' && el.type !== 'tel' && ['none', 'decimal'].includes((el.getAttribute('inputmode') || '').toLowerCase());
// Build the running tape (left-to-right) for the live popup: lines like ['40','+ 5','× 2'] + result.
function _calcSteps(str) {
  const norm = String(str == null ? '' : str).replace(/×/g, '*').replace(/÷/g, '/').replace(/[^0-9.+\-*/]/g, '');
  const tokens = norm.match(/(\d+\.?\d*|\.\d+|[+\-*/])/g);
  if (!tokens) return null;
  let acc = parseFloat(tokens[0]); if (isNaN(acc)) return null;
  const lines = [tokens[0]];
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i], n = parseFloat(tokens[i + 1]); if (isNaN(n)) break;
    acc = op === '+' ? acc + n : op === '-' ? acc - n : op === '*' ? acc * n : op === '/' ? (n === 0 ? acc : acc / n) : acc;
    lines.push(_opSym(op) + ' ' + tokens[i + 1]);
  }
  return { lines, result: Math.round(acc * 100) / 100 };
}
function _hideCalcPop() { const p = document.getElementById('amt-calc-pop'); if (p) p.style.display = 'none'; }
// QuickBooks-style adding-machine tape: a small popup under the field, live as you type an expression.
function _showCalcPop(el) {
  if (!/\d\s*[+\-*/×÷]/.test(el.value)) { _hideCalcPop(); return; }   // only once it's an expression
  const steps = _calcSteps(el.value); if (!steps) { _hideCalcPop(); return; }
  let pop = document.getElementById('amt-calc-pop');
  if (!pop) {
    pop = document.createElement('div'); pop.id = 'amt-calc-pop';
    pop.style.cssText = 'position:fixed;z-index:300;pointer-events:none;background:var(--surface-container-lowest,#fff);border:1px solid var(--outline-variant,#c2cacd);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:7px 12px;font-family:Inter,sans-serif;font-variant-numeric:tabular-nums;text-align:right;min-width:110px';
    document.body.appendChild(pop);
  }
  pop.innerHTML = steps.lines.map(l => `<div style="font-size:12px;color:var(--on-surface-variant,#5a6b70);line-height:1.55">${l}</div>`).join('')
    + `<div style="border-top:1px solid var(--outline-variant,#c2cacd);margin-top:3px;padding-top:3px;font-size:15px;font-weight:700;color:var(--primary,#1a5252)">$${steps.result.toFixed(2)}</div>`;
  pop.style.display = 'block';
  const r = el.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 6)) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
}
// Commit an expression in the field to its result; fire `input` so downstream totals recompute.
function _commitAmount(el) {
  const result = evalAmountExpression(el.value);
  if (result == null || String(result) === el.value) return false;
  el.value = String(result);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
// Confirm a running calc in an amount field (commit + hide the tape). Called by the global Enter
// handler (main.js) so calc-confirm and modal-save Enter behaviour live in ONE place. Returns true
// if a calc was committed (so Enter knows NOT to also save/close the modal).
export function commitAmountField(el) {
  if (!isAmountField(el) || evalAmountExpression(el.value) == null) return false;
  _commitAmount(el); _hideCalcPop();
  setTimeout(() => { try { el.select(); } catch {} }, 0);
  return true;
}
// Install once. Desktop money fields behave like the QuickBooks register amount field:
//  • focus selects the existing value (type to replace),
//  • typing an expression shows a live adding-machine tape popup,
//  • Tab/click-away or Enter commits the result.
// Inert on touch (the numpad serves those fields; it writes plain numbers → no operator → no popup).
let _amountCalcInstalled = false;
export function initAmountFieldCalc() {
  if (_amountCalcInstalled) return; _amountCalcInstalled = true;
  let _selectPending = null;
  document.addEventListener('focusin', e => {
    if (!isAmountField(e.target)) return;
    const el = e.target; _selectPending = el;
    setTimeout(() => { if (document.activeElement === el) { try { el.select(); } catch {} } }, 0);   // highlight existing value
  });
  // A click after focus would collapse the selection — stop it so the value stays highlighted.
  document.addEventListener('mouseup', e => { if (e.target === _selectPending) { e.preventDefault(); _selectPending = null; } });
  document.addEventListener('input', e => { if (isAmountField(e.target)) _showCalcPop(e.target); });
  document.addEventListener('focusout', e => { if (isAmountField(e.target)) { _commitAmount(e.target); _hideCalcPop(); } });
  // NB: Enter is handled by the single global handler in main.js wireKeyboard (calc-confirm vs
  // modal-save), so the two don't both fire and save+close while a calc is mid-entry.
}
function _closeNumpadModal() {
  if (_numpadHostObs) { _numpadHostObs.disconnect(); _numpadHostObs = null; }
  const m = document.getElementById('numpad-modal');
  m.classList.add('hidden'); m.style.display = '';
  const strip = document.getElementById('numpad-ac'); if (strip) { strip.classList.add('hidden'); strip.innerHTML = ''; }
  _numpadTarget = null; _numpadRaw = '';
  // A numpad key fires on pointerdown and closes the pad synchronously, so the trailing
  // tap (pointerup → click) lands on whatever is now revealed at that spot — e.g. the
  // Assign & Price modal's "Save All" button at the same bottom-center position — and
  // fires it, auto-saving/closing the host. Swallow that one ghost click in a short window
  // so confirming a price just confirms the price.
  function _swallowGhostClick(e) { e.stopPropagation(); e.preventDefault(); document.removeEventListener('click', _swallowGhostClick, true); }
  document.addEventListener('click', _swallowGhostClick, true);
  setTimeout(() => document.removeEventListener('click', _swallowGhostClick, true), 300);
}

// ── Toast ────────────────────────────────────────
let _toastTimer;
export function showToast(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-text').textContent = msg;
  toast.classList.remove('hidden');
  toast.style.display = 'flex';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.classList.add('hidden'); toast.style.display = ''; }, 3000);
}

// ── Global listeners (run once on import) ─────────────────────────────────────
// Close autocomplete dropdowns on outside click — but NOT when tapping the floating
// phone numpad, so digit keys can filter the list instead of dismissing it.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ac-input-wrap') && !e.target.closest('#numpad-modal')) {
    document.querySelectorAll('.autocomplete-list').forEach(d => { d.innerHTML = ''; d.classList.add('hidden'); });
  }
});

// ── Minimal .xlsx writer (multi-sheet Excel export, zero dependencies) ────────
// sheets = [{ name, rows: [[cell, …], …] }] → Blob. Strings become inline-string
// cells, finite numbers become numeric cells (so Excel can sum them), null/'' is
// skipped. The container is a STORED (uncompressed) zip built by hand — small
// payroll workbooks don't need deflate, and Excel/Sheets/Numbers all open it.
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function _crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const _xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function _colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function _sheetXml(rows) {
  const body = rows.map((row, ri) => {
    const cells = (row || []).map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = _colLetter(ci) + (ri + 1);
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${_xmlEsc(v)}</t></is></c>`;
    }).join('');
    return cells ? `<row r="${ri + 1}">${cells}</row>` : '';
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
// Excel sheet-name rules: no \ / ? * [ ] :, max 31 chars, unique, non-empty.
function _sheetNames(sheets) {
  const seen = new Set();
  return sheets.map((s, i) => {
    let n = String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    let base = n, k = 2;
    while (seen.has(n.toLowerCase())) { n = (base.slice(0, 28) + ' ' + k++).slice(0, 31); }
    seen.add(n.toLowerCase());
    return n;
  });
}
export function xlsxBlob(sheets) {
  const enc = new TextEncoder();
  const names = _sheetNames(sheets);
  const files = [];
  const add = (path, xml) => files.push({ path, data: enc.encode(xml) });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((_, i) => `<sheet name="${_xmlEsc(names[i])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, _sheetXml(s.rows || [])));

  // STORED zip: local headers + central directory + EOCD.
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const parts = [], central = [];
  let offset = 0;
  files.forEach(f => {
    const nameB = enc.encode(f.path), crc = _crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameB, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + size;
  });
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ── App-update popup (shared by the dashboard, Staff, and Reports apps) ──────────
// A deliberately prominent modal so a published update is never missed (the small
// version badge alone was getting overlooked). "Update now" clears the SW + caches
// and reloads to the freshest files — no app data is touched (state lives in the DO).
export async function hardReloadApp() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) {}
  location.reload();
}

export function showUpdatePopup(version) {
  if (document.getElementById('app-update-popup')) return;   // already showing
  const overlay = document.createElement('div');
  overlay.id = 'app-update-popup';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,.55);padding:20px';
  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;border-radius:18px;max-width:360px;width:100%;padding:26px 24px;box-shadow:0 18px 50px rgba(0,0,0,.32);text-align:center;font-family:system-ui,-apple-system,sans-serif';
  card.innerHTML =
    '<div style="font-size:42px;line-height:1;margin-bottom:10px">🔄</div>' +
    '<div style="font-size:19px;font-weight:800;color:#1a1d27;margin-bottom:6px">Update available</div>' +
    '<div style="font-size:14px;color:#5b606e;line-height:1.5;margin-bottom:20px">Version ' + version + ' is ready. Tap Update to get the latest version.<br><b>Your data is safe</b> — nothing is deleted.</div>' +
    '<button id="app-update-now" style="display:block;width:100%;padding:14px;border:0;border-radius:12px;background:#2a7a4f;color:#fff;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:9px">Update now</button>' +
    '<button id="app-update-later" style="display:block;width:100%;padding:11px;border:0;border-radius:12px;background:transparent;color:#7a7f8c;font-size:14px;font-weight:600;cursor:pointer">Later</button>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector('#app-update-now').addEventListener('click', (e) => { e.target.textContent = 'Updating…'; hardReloadApp(); });
  card.querySelector('#app-update-later').addEventListener('click', () => overlay.remove());
}
