// ── Square config modal + Terminal pairing + customer-sync glue ─────────────
// Square location config is synced (config.square_config). Catalog pull/push was
// REMOVED (v4.23) — the app is the source of truth for services / items / fees.
// This module now only handles the Square connection, Terminal pairing, the SMS
// team-member picker, and the customer-directory sync (until customers move to the DO).

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, escHtml } from '../utils.js';
import { SQUARE_PROXY } from '../config.js';
import { importCustomersFromSquare } from './square-customers.js';

const cfg = () => getState().config;
const sqConfig = () => cfg().square_config || null;

export function showSquareModal() {
  const sc = sqConfig();
  if (sc) {
    document.getElementById('sq-location').value = sc.locationId || '';
    const sel = document.getElementById('sq-booking-member');
    if (sel && sel.options.length <= 1 && sc.locationId) loadSquareBookingTeamMembers();
    else if (sel && sc.bookingTeamMemberId) sel.value = sc.bookingTeamMemberId;
  }
  const m = document.getElementById('square-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}

export function saveSquareConfig() {
  const locationId = document.getElementById('sq-location').value.trim();
  if (!locationId) { showToast('Please enter your Location ID.'); return; }
  const sel = document.getElementById('sq-booking-member');
  const memberId   = sel?.value || '';
  const memberName = sel?.options[sel.selectedIndex]?.text || '';
  const value = { locationId, ...(memberId ? { bookingTeamMemberId: memberId, bookingTeamMemberName: memberName } : {}) };
  dispatch('config.set', { key: 'square_config', value });
  const m = document.getElementById('square-modal');
  m.classList.add('hidden'); m.style.display = '';
  updateSyncLabel('ok', 'Square synced');
  showToast('Square connection saved!');
}

export async function testSquareConnection() {
  if (!sqConfig()) { showToast('Save config first.'); return; }
  const status = document.getElementById('sq-status');
  status.classList.remove('hidden');
  status.textContent = 'Testing connection…';
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/locations`);
    if (res.ok) { status.textContent = '✓ Connected successfully!'; status.style.color = '#2a6868'; updateSyncLabel('ok', 'Square synced'); }
    else { const err = await res.json(); status.textContent = '✗ ' + (err.errors?.[0]?.detail || 'Connection failed — check your Location ID'); status.style.color = '#a83836'; updateSyncLabel('error', 'Square error'); }
  } catch (e) { status.textContent = '✗ Could not reach proxy — check Worker is deployed'; status.style.color = '#a83836'; }
}

// ── Square Terminal pairing ──────────────────────────────────────────────────
// Create a device code (product_type TERMINAL_API), the operator signs into the
// Square Terminal with that code, then we poll until it's PAIRED and store the
// device_id in config.square_config.terminalDeviceId (synced across devices).
export async function pairTerminal() {
  const sc = sqConfig();
  if (!sc?.locationId) { showToast('Save your Location ID first.'); return; }
  const el = document.getElementById('sq-terminal-status');
  if (el) el.textContent = 'Requesting a device code…';
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/devices/codes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'devcode-' + Date.now(), device_code: { name: 'Front Desk Terminal', location_id: sc.locationId, product_type: 'TERMINAL_API' } }),
    });
    const j = await res.json();
    if (!res.ok) { if (el) el.textContent = ''; showToast('Square: ' + (j.errors?.[0]?.detail || 'could not create a device code')); return; }
    const dc = j.device_code || {};
    if (el) el.innerHTML = `On the Square Terminal: <b>Sign in → Use a device code</b>, then enter:<div style="font-size:30px;font-weight:800;letter-spacing:5px;margin:8px 0;color:var(--primary,#1a5252)">${(dc.code || '').replace(/[^A-Z0-9]/g, '')}</div><span class="text-on-surface-variant">Waiting for the Terminal to pair… (code expires in 5 min)</span>`;
    _pollDeviceCode(dc.id, Date.now());
  } catch (e) { if (el) el.textContent = ''; showToast('Could not reach Square.'); }
}
function _pollDeviceCode(id, started) {
  const el = document.getElementById('sq-terminal-status');
  if (Date.now() - started > 5 * 60 * 1000) { if (el) el.textContent = 'Code expired — tap "Pair Terminal" to try again.'; return; }
  setTimeout(async () => {
    let dc = null;
    try { const r = await fetch(`${SQUARE_PROXY}/v2/devices/codes/${id}`); const j = await r.json(); dc = j.device_code || null; } catch (e) {}
    if (dc?.status === 'PAIRED' && dc.device_id) {
      dispatch('config.set', { key: 'square_config', value: { ...(sqConfig() || {}), terminalDeviceId: dc.device_id, terminalName: dc.name || '' } });
      if (el) el.textContent = '';
      showToast('Square Terminal paired ✓');
      renderTerminalStatus();
      return;
    }
    _pollDeviceCode(id, started);
  }, 3000);
}
export function unpairTerminal() {
  const sc = { ...(sqConfig() || {}) }; delete sc.terminalDeviceId; delete sc.terminalName;
  dispatch('config.set', { key: 'square_config', value: sc });
  renderTerminalStatus();
  showToast('Terminal unpaired.');
}
export function renderTerminalStatus() {
  const el = document.getElementById('sq-terminal-current'); if (!el) return;
  const id = sqConfig()?.terminalDeviceId;
  el.innerHTML = id
    ? `<span style="color:#2a6868;font-weight:700">✓ Terminal paired</span> · <span style="font-family:monospace;font-size:11px">${id}</span> · <button onclick="unpairTerminal()" class="text-error underline" style="font-size:12px">Unpair</button>`
    : `<span class="text-on-surface-variant">No Terminal paired yet.</span>`;
}

// Sync the customer directory from Square. (Catalog is app-owned and no longer pulled.)
// Customers move to the Durable Object in a later step; until then they load from Square.
export async function syncSquare() {
  if (!sqConfig()) { showSquareModal(); return; }
  await importCustomersFromSquare();   // one-time/again-safe import of Square customers into the DO
}

export function updateSyncLabel(state, label) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if (dot) dot.className = `sync-dot ${state}`;
  if (lbl) lbl.textContent = label;
}

// Load bookings-eligible team members into the Square modal picker.
export async function loadSquareBookingTeamMembers() {
  if (!sqConfig()) return;
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/team-members/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { filter: { status: 'ACTIVE' } }, limit: 200 }) });
    if (!res.ok) return;
    const members = (await res.json()).team_members || [];
    const sel = document.getElementById('sq-booking-member');
    if (!sel) return;
    sel.innerHTML = '<option value="">— None (no SMS reminders) —</option>' + members.map(m => {
      const name = [m.given_name, m.family_name].filter(Boolean).join(' ');
      const selected = m.id === sqConfig()?.bookingTeamMemberId ? 'selected' : '';
      return `<option value="${escHtml(m.id)}" ${selected}>${escHtml(name)}</option>`;
    }).join('');
    if (members.length === 0) showToast('No active team members found in Square.');
  } catch (e) { showToast('Could not load team members from Square.'); }
}
