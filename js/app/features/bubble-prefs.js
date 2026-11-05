// ── Bubble-info toggles (W2-6) ──────────────────────────────────────────────
// Per-USER, SYNCED preference to hide three bits of customer-card clutter —
// service time / technician / service — across the Floor plan, Queue, and Turns
// board. Follows the chat_seen_<pid> / fd_clock_<id> precedent: a per-user config
// key (bubble_prefs_fd:<id>) so a person's choice follows them to any device they
// sign in on, and never touches anyone else. Default (missing key) = everything
// shown, so nothing changes for anyone until they opt in.
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveUser } from '../session.js';

// The dashboard user is always a front-desk user, so the pid mirrors chat.js: fd:<id>.
export function bubblePrefsKey() { const u = getActiveUser(); return u ? 'bubble_prefs_fd:' + u.id : null; }

// Pure: read the three hide-flags out of a config map for a given storage key. A
// null key (signed out) or a missing key → everything shown. true in the stored
// object = HIDDEN.
export function readBubblePrefs(config, key) {
  const p = (key && config && config[key]) || {};
  return { hideTime: !!p.time, hideTech: !!p.tech, hideSvc: !!p.svc };
}

export function getBubblePrefs() { return readBubblePrefs(getState().config, bubblePrefsKey()); }

// Pure: the ordered inline text parts for the floor's one-service line (custLines is
// the only caller — the queue/turns surfaces compose class-tagged spans inline; this
// is extracted for DOM-free unit testing of the tricky orphan-separator / Wait-suffix
// edges). Joined with ' · ' by the caller. The status dot, avatar and the separate
// service-time sub-row are rendered outside this. cost (Comp or $NN) is NOT one of the
// three toggles — it shows whenever present. "Wait" (unassigned) is tech-slot info, so
// it rides the technician toggle. Pushes only truthy parts so there is never a stray
// or leading separator, even with everything hidden.
export function bubbleLineParts({ svcLabel, techFirst, costStr, hasTech }, { hideSvc, hideTech } = {}) {
  const parts = [];
  if (!hideSvc && svcLabel) parts.push(svcLabel);
  if (!hideTech && hasTech && techFirst) parts.push(techFirst);
  if (costStr) parts.push(costStr);
  if (!hideTech && !hasTech) parts.push('Wait');
  return parts;
}

const _anyHidden = () => { const p = getBubblePrefs(); return p.hideTime || p.hideTech || p.hideSvc; };

// ── Toolbar button (rendered in the floor-group subnav by main.js) ──────────────
export function bubbleInfoButtonHtml() {
  const on = _anyHidden();
  return `<button id="bubble-info-btn" onclick="openBubbleInfoPopover(this)" title="Show or hide details on the customer cards" class="btn-secondary" style="position:relative">
    <span class="material-symbols-outlined" style="font-size:16px">view_agenda</span> Card info
    <span id="bubble-info-dot" style="position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:var(--primary,#1a5252);${on ? '' : 'display:none'}"></span>
  </button>`;
}
function _repaintDot() { const d = document.getElementById('bubble-info-dot'); if (d) d.style.display = _anyHidden() ? '' : 'none'; }

// ── Popover (3 toggles) ─────────────────────────────────────────────────────────
// A full-screen fixed container with a transparent backdrop that closes on an
// outside tap; the card is anchored under the button. The container id is in
// MODAL_CLOSERS (main.js) so a nav/panel switch force-hides it — no orphaned,
// mis-anchored popover eating taps after a tab change, and no leaked listeners.
const POP_ID = 'bubble-info-popover';
function _row(key, icon, label) {
  const hidden = getBubblePrefs()[key === 'time' ? 'hideTime' : key === 'tech' ? 'hideTech' : 'hideSvc'];
  return `<label style="display:flex;align-items:center;gap:10px;min-height:44px;padding:0 14px;cursor:pointer;color:var(--on-surface)">
    <input type="checkbox" onchange="toggleBubblePref('${key}')" ${hidden ? '' : 'checked'} style="width:18px;height:18px;accent-color:var(--primary,#1a5252);flex-shrink:0">
    <span class="material-symbols-outlined" style="font-size:18px;color:var(--on-surface-variant)">${icon}</span>
    <span style="font-size:14px">${label}</span>
  </label>`;
}
function _ensurePopover() {
  let el = document.getElementById(POP_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = POP_ID; el.className = 'hidden';
  el.style.cssText = 'position:fixed;inset:0;z-index:90';
  el.innerHTML = `<div data-bip-backdrop style="position:absolute;inset:0"></div>
    <div id="bubble-info-card" style="position:absolute;min-width:208px;background:var(--surface-container-lowest,#fff);border:1px solid var(--surface-container-high,#d7dddd);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,0.22);padding:8px 0;overflow:hidden">
      <div style="font-size:11px;font-weight:700;color:var(--on-surface-variant);padding:2px 14px 6px;text-transform:uppercase;letter-spacing:.04em">Show on cards</div>
      <div id="bubble-info-rows"></div>
    </div>`;
  el.querySelector('[data-bip-backdrop]').addEventListener('click', closeBubbleInfoPopover);
  document.body.appendChild(el);
  return el;
}
export function openBubbleInfoPopover(btnEl) {
  const el = _ensurePopover();
  el.querySelector('#bubble-info-rows').innerHTML = _row('time', 'schedule', 'Service time') + _row('tech', 'person', 'Technician') + _row('svc', 'spa', 'Service');
  el.classList.remove('hidden');
  // Anchor the card under the button (fall back to top-right if we can't measure it).
  const card = el.querySelector('#bubble-info-card');
  const b = btnEl?.getBoundingClientRect?.();
  if (b) {
    const w = card.offsetWidth || 208;
    card.style.top = Math.round(b.bottom + 6) + 'px';
    card.style.left = Math.round(Math.min(b.left, window.innerWidth - w - 8)) + 'px';
    card.style.right = 'auto';
  } else { card.style.top = '64px'; card.style.right = '16px'; card.style.left = 'auto'; }
}
export function closeBubbleInfoPopover() {
  const el = document.getElementById(POP_ID);
  if (el) { el.classList.add('hidden'); el.style.display = ''; }
}
export function toggleBubblePref(which) {
  const key = bubblePrefsKey(); if (!key) return;
  const cur = { ...(getState().config[key] || {}) };
  cur[which] = !cur[which];
  dispatch('config.set', { key, value: cur });   // synced + per-key LWW; onStateChange re-renders the active board
  _repaintDot();                                  // the subnav is NOT rebuilt by onStateChange — repaint the dot directly
}
