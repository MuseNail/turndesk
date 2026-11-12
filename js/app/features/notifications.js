// ── Unified notification bell ────────────────────────────────────────────────
// ONE header bell aggregating every pending thing, each row tappable straight to its
// source (and tapping clears it). Strictly READ-ONLY on all state — the bell never
// dispatches. Replaces the scattered, unexplained dots (esp. the old Settings support dot).
//
// Every source is already PER-SALON in TurnDesk, so the bell shows only the current salon's
// items: failedOps() reads the salon-scoped dead-letter, chat/records come from the per-salon
// DO state, support tickets are salon-scoped server-side, and the clock is device-local.
import { getActiveUser } from '../session.js';
import { showUpdatePopup, escHtml } from '../utils.js';
import { failedOps } from '../sync.js';
import { chatUnreadCount } from './chat.js';
import { supportUnreadCount, supportSalonUnreadList } from './support.js';
import { clockNeedsAttention } from './timeclock.js';
import { buildNotifItems } from '../notif-util.js';

// ── Live source read ──────────────────────────────────────────────────────────
function gather() {
  const u = getActiveUser();
  if (!u || !u.id || u.id === 'fallback') return null;   // signed out → no bell
  const role = u.role;
  const caps = { isAdmin: role === 'admin', isManager: role === 'admin' || role === 'manager' };
  const counts = {
    failedWrites: failedOps().length,
    supportReply: supportUnreadCount(),
    chat:         chatUnreadCount(),
    clock:        clockNeedsAttention() ? 1 : 0,
    update:       (typeof window.updateAvailableVersion === 'function' && window.updateAvailableVersion()) ? 1 : 0,
  };
  return { counts, caps };
}

// ── Drill to source (tapping a row) ──────────────────────────────────────────
export function openNotifTarget(kind, id) {
  closeNotifPanel();
  switch (kind) {
    case 'recovery':
      window.showDashPanel?.('settings');
      setTimeout(() => window.settingsOpenLeaf?.('settings-recovery-section'), 30); break;
    case 'supportSalon':
      window.supportOpenThread?.(id); break;
    case 'chat':   window.toggleChat?.(); break;
    case 'clock':  window.onClockBtn?.(); break;
    case 'update': showUpdatePopup?.(typeof window.updateAvailableVersion === 'function' ? window.updateAvailableVersion() : ''); break;
  }
}

// ── Panel rows ────────────────────────────────────────────────────────────────
// Each source → one or more rows {icon, cls, title, sub, kind, id}. Support expands to one row
// per unread ticket so tapping a row deep-links into that thread and CLEARS its unread.
// Each row carries a category `cls` (danger|support|chat|task|update); the chip colors live in CSS so
// they flip correctly in dark mode (.notif-ico--<cls> + a html[data-appearance="dark"] override).
function rowsFor(item) {
  switch (item.id) {
    case 'failedWrites': return [{ icon: 'cloud_off', cls: 'danger', title: item.count === 1 ? 'A change didn\u2019t save' : `${item.count} changes didn\u2019t save`, sub: 'Data Recovery \u00b7 tap to resync', kind: 'recovery' }];
    case 'supportReply': return supportSalonUnreadList().map(t => ({ icon: 'forum', cls: 'support', title: 'Reply on your ticket', sub: t.subject || 'Help & Feedback', kind: 'supportSalon', id: t.id }));
    case 'chat': return [{ icon: 'chat', cls: 'chat', title: item.count === 1 ? '1 unread message' : `${item.count} unread messages`, sub: 'Team chat', kind: 'chat' }];
    case 'clock': return [{ icon: 'schedule', cls: 'task', title: 'Time-clock station changed', sub: 'Tap to review', kind: 'clock' }];
    case 'update': return [{ icon: 'system_update', cls: 'update', title: 'New version ready', sub: 'Tap to update the app', kind: 'update' }];
    default: return [];
  }
}

function _renderPanel(built) {
  const list = document.getElementById('notif-list');
  const empty = document.getElementById('notif-empty');
  const hcount = document.getElementById('notif-hdr-count');
  if (!list) return;
  const rows = built.items.flatMap(rowsFor);
  if (hcount) hcount.textContent = rows.length ? `${built.total} new` : 'all clear';
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  list.innerHTML = rows.map(r => `
    <button type="button" class="notif-row" onclick="openNotifTarget('${r.kind}'${r.id ? `,'${escAttrJs(r.id)}'` : ''})">
      <span class="notif-ico notif-ico--${r.cls}"><span class="material-symbols-outlined" style="font-size:18px" aria-hidden="true">${r.icon}</span></span>
      <span class="notif-text"><span class="notif-title">${escHtml(r.title)}</span><span class="notif-sub">${escHtml(r.sub)}</span></span>
      <span class="material-symbols-outlined notif-chev" aria-hidden="true">chevron_right</span>
    </button>`).join('');
}
function escAttrJs(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

// ── Badge + open/close ────────────────────────────────────────────────────────
let _nbTimer = null;
export function refreshNotifBell() {
  if (_nbTimer) return;                      // debounce: coalesce write/sync bursts to one repaint
  _nbTimer = setTimeout(() => { _nbTimer = null; _repaint(); }, 150);
}
function _repaint() {
  try {
    const data = gather();
    const built = data ? buildNotifItems(data.counts, data.caps) : { items: [], total: 0, hasDanger: false };
    const badge = document.getElementById('notif-bell-badge');
    const btn = document.getElementById('notif-bell-btn');
    if (badge) {
      badge.textContent = built.total > 99 ? '99+' : String(built.total);
      badge.classList.toggle('hidden', built.total <= 0);
      badge.style.background = built.hasDanger ? '#d11a2a' : '#2a7a4f';
    }
    if (btn) {
      btn.setAttribute('aria-label', built.total ? `Notifications, ${built.total} pending` : 'Notifications');
    }
    const panel = document.getElementById('notif-panel');
    if (panel && panel.classList.contains('open')) _renderPanel(built);
  } catch { /* a bell repaint must never throw into a caller */ }
}
export function toggleNotifPanel() {
  const p = document.getElementById('notif-panel'); if (!p) return;
  if (p.classList.toggle('open')) {
    const data = gather();
    _renderPanel(data ? buildNotifItems(data.counts, data.caps) : { items: [], total: 0, hasDanger: false });
    document.getElementById('notif-bell-btn')?.setAttribute('aria-expanded', 'true');
  } else {
    document.getElementById('notif-bell-btn')?.setAttribute('aria-expanded', 'false');
  }
}
export function closeNotifPanel() {
  document.getElementById('notif-panel')?.classList.remove('open');
  document.getElementById('notif-bell-btn')?.setAttribute('aria-expanded', 'false');
}
// Dismiss on outside click (mirror the Turns ⋯ More pattern: one listener, no stopPropagation).
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const p = document.getElementById('notif-panel');
    if (!p || !p.classList.contains('open')) return;
    if (e.target.closest?.('#notif-bell-wrap')) return;
    closeNotifPanel();
  });
}
