// ── Universal activity log (Stage 3) ────────────────────────────────────────
// logAudit() records who/when/device/action for key events; it rides the synced
// 'audit.log' op into the Durable Object (each event its own append-only key), so
// a manager on ANY device sees every user's activity. renderActivityLog() shows the
// feed (server snapshot) with filter chips + search, merging in the older
// deletions/refunds that predate the log so nothing historical is lost.
import { getState } from '../store.js';
import { dispatch, DEVICE_ID } from '../sync.js';
import { getActiveUser } from '../session.js';
import { STATE_PROXY } from '../config.js';

let _auditCounter = 0;
export function logAudit(action, detail) {
  try {
    const u = getActiveUser && getActiveUser();
    const event = {
      id: `${Date.now()}-${DEVICE_ID}-${(++_auditCounter).toString(36)}`,
      at: new Date().toISOString(),
      action: action || 'Action',
      detail: detail || '',
      by: (u && u.name) || 'Unknown',
      role: (u && u.role) || '',
      device: DEVICE_ID,
    };
    dispatch('audit.log', { event });
  } catch (e) { /* logging must never break the action it's recording */ }
}

// ── Activity feed ─────────────────────────────────
let _auditFilter = 'all', _auditSearch = '';
const _CATS = [
  { id: 'all',      label: 'All',        match: () => true },
  { id: 'checkin',  label: 'Check-ins',  match: a => /check-?in/i.test(a) },
  { id: 'payment',  label: 'Payments',   match: a => /pay|paid|checkout/i.test(a) },
  { id: 'void',     label: 'Voids',      match: a => /void|reopen/i.test(a) },
  { id: 'delete',   label: 'Deletes',    match: a => /delete/i.test(a) },
  { id: 'refund',   label: 'Refunds',    match: a => /refund/i.test(a) },
  { id: 'edit',     label: 'Edits',      match: a => /edit|historical|update/i.test(a) },
  { id: 'login',    label: 'Logins',     match: a => /login|log ?in|sign ?in/i.test(a) },
  { id: 'system',   label: 'System',     match: a => /clear|reset|backup/i.test(a) },
];
export function setAuditFilter(id) { _auditFilter = id; renderActivityLog(true); }
export function auditSearch(v) { _auditSearch = (v || '').trim().toLowerCase(); _renderAuditList(); }

const _esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let _auditEvents = [];   // last-fetched merged event list

export async function renderActivityLog(skipFetch) {
  const el = document.getElementById('audit-log-content');
  if (!el) return;
  if (!skipFetch) {
    el.innerHTML = '<p class="text-sm text-on-surface-variant">Loading…</p>';
    _auditEvents = await _fetchMerged();
  }
  // chips + search + list container
  const chips = _CATS.map(c => `<button onclick="setAuditFilter('${c.id}')" class="chip${_auditFilter === c.id ? ' chip-on' : ''}">${c.label}</button>`).join('');
  el.innerHTML = `<div class="flex flex-wrap gap-1.5 mb-2">${chips}</div>
    <input type="text" placeholder="Search name, action, user…" oninput="auditSearch(this.value)" value="${_esc(_auditSearch)}" class="w-full mb-3 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-body focus:border-primary outline-none">
    <div id="audit-feed-list" class="space-y-1.5"></div>`;
  _renderAuditList();
}

async function _fetchMerged() {
  let audit = [], deletions = [], records = [];
  try {
    const res = await fetch(`${STATE_PROXY}/snapshot`, { cache: 'no-store' });
    if (res.ok) { const st = (await res.json()).state || {}; audit = st.audit || []; deletions = st.deletions || []; records = st.records || []; }
    else throw new Error('snapshot ' + res.status);
  } catch (e) {
    // offline → the synced local mirror
    const s = getState(); audit = s.audit || []; deletions = (s.deletions || []); records = s.records || [];
  }
  // Older deletions/refunds that predate the activity log → keep them visible (one-time
  // history) without double-listing anything the log already captures going forward.
  const earliest = audit.length ? new Date(audit[audit.length - 1].at).getTime() : Infinity;
  const recById = {}; records.forEach(r => { recById[String(r.id)] = r; });
  const derived = [];
  deletions.forEach(d => {
    if (!d || typeof d !== 'object') return;
    const at = d.at ? new Date(d.at).getTime() : 0;
    if (at >= earliest) return;
    const rec = recById[String(d.id)];
    derived.push({ at: d.at, action: 'Delete', by: d.by || '—', detail: `${rec?.name || '—'}${d.reason ? ' · ' + d.reason : ''}`, device: '' });
  });
  records.filter(r => r.status === 'refund').forEach(r => {
    const at = new Date(r.completedAt || r.checkinTime).getTime();
    if (at >= earliest) return;
    derived.push({ at: r.completedAt || r.checkinTime, action: 'Refund', by: r.loggedBy || '—', detail: `${r.name || '—'} · $${Math.abs(r.totalCost || 0).toFixed(2)}`, device: '' });
  });
  return [...audit, ...derived].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
}

function _renderAuditList() {
  const list = document.getElementById('audit-feed-list');
  if (!list) return;
  const cat = _CATS.find(c => c.id === _auditFilter) || _CATS[0];
  const rows = _auditEvents.filter(e => cat.match(e.action || '') && (!_auditSearch ||
    (`${e.action} ${e.detail} ${e.by}`).toLowerCase().includes(_auditSearch)));
  if (!rows.length) { list.innerHTML = '<p class="text-sm text-on-surface-variant py-4 text-center opacity-70">No matching activity.</p>'; return; }
  list.innerHTML = rows.slice(0, 300).map(e => {
    const dt = e.at ? new Date(e.at) : null;
    const when = dt && !isNaN(dt) ? `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '—';
    const color = /delete/i.test(e.action) ? '#fa746f' : /refund/i.test(e.action) ? '#f5c870' : /pay|paid/i.test(e.action) ? '#2a7a4f' : /check-?in/i.test(e.action) ? '#1a5c7a' : '#6b7280';
    return `<div class="bg-surface-container rounded-xl px-4 py-2.5 border border-surface-container-high">
      <div class="flex items-center justify-between gap-2 mb-0.5">
        <div class="flex items-center gap-2 min-w-0"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 text-white" style="background:${color}">${_esc(e.action)}</span><span class="font-semibold text-on-surface text-sm truncate">${_esc(e.detail) || '—'}</span></div>
        <span class="text-[11px] text-outline flex-shrink-0">${when}</span>
      </div>
      <div class="text-[11px] font-body text-on-surface-variant">By ${_esc(e.by)}${e.role ? ' (' + _esc(e.role) + ')' : ''}</div>
    </div>`;
  }).join('');
}
