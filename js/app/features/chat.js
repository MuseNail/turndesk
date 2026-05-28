// ── Staff chat ──────────────────────────────────────────────────────────────
// Real-time chat between logged-in front-desk users. Messages ride the existing
// config sync: they live in config.chat_log (capped) and broadcast to every device
// via dispatch('config.set'), so NO Worker change is needed. The unread badge +
// last-seen marker are device-local (localStorage), not synced.
//
// Caveat: config.set replaces the whole array (last-write-wins), so two people sending
// at the exact same instant could clobber one message. Fine for low-volume staff chat;
// a Worker-side append op would remove that risk (future — needs a wrangler deploy).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveUser } from '../session.js';
import { showToast } from '../utils.js';

const cfg = () => getState().config;
const CHAT_CAP = 100;
const SEEN_KEY = 'turndesk_chat_seen';   // device-local last-seen timestamp (ms)

// Auto-clear daily: the 4 AM reset wipes config.chat_log; this filter also hides anything
// before the salon day start (4 AM) so a device that was closed at 4 AM still shows a fresh
// chat. The stored array self-prunes to today's on the next send.
const DAY_START_HOUR = 4;
function dayStartTs() {
  const d = new Date(), c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR, 0, 0, 0);
  if (d.getTime() < c.getTime()) c.setDate(c.getDate() - 1);   // before 4 AM → still "yesterday"
  return c.getTime();
}
const messages = () => (Array.isArray(cfg().chat_log) ? cfg().chat_log : []).filter(m => (m.ts || 0) >= dayStartTs());
const _esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const seenTs = () => Number(localStorage.getItem(SEEN_KEY) || 0);
function markSeen() { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) {} }

let _chatOpen = false, _lastNotifiedTs = 0, _chatInit = false;

export function toggleChat() { _chatOpen ? closeChat() : openChat(); }
export function openChat() {
  _chatOpen = true;
  const p = document.getElementById('chat-panel'); if (p) { p.classList.remove('hidden'); p.style.display = 'flex'; }
  document.getElementById('chat-clear-btn')?.classList.toggle('hidden', getActiveUser()?.role !== 'admin');   // manager-only clear
  renderChat(); markSeen(); updateChatBadge();
  setTimeout(() => { document.getElementById('chat-input')?.focus(); const m = document.getElementById('chat-messages'); if (m) m.scrollTop = m.scrollHeight; }, 40);
}
export function closeChat() {
  _chatOpen = false;
  const p = document.getElementById('chat-panel'); if (p) { p.classList.add('hidden'); p.style.display = ''; }
}

export function sendChatMessage() {
  const input = document.getElementById('chat-input'); if (!input) return;
  const text = (input.value || '').trim(); if (!text) return;
  const u = getActiveUser();
  const msg = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), uid: u?.id || '', name: u?.name || 'Staff', text: text.slice(0, 1000), ts: Date.now() };
  dispatch('config.set', { key: 'chat_log', value: [...messages(), msg].slice(-CHAT_CAP) });
  input.value = '';
  _lastNotifiedTs = msg.ts; markSeen();
  renderChat(); updateChatBadge();
}
export function chatInputKey(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChatMessage(); } }

// Manager-only: wipe the chat for everyone (in addition to the automatic 4 AM clear).
export function clearChat() {
  if (getActiveUser()?.role !== 'admin') { showToast('Only a manager can clear the chat.'); return; }
  const doClear = () => { dispatch('config.set', { key: 'chat_log', value: [] }); markSeen(); renderChat(); updateChatBadge(); showToast('Chat cleared'); };
  if (window.showWarnModal) window.showWarnModal('Clear chat for everyone?', 'This permanently removes the chat history on all devices.', doClear);
  else doClear();
}

export function renderChat() {
  const box = document.getElementById('chat-messages'); if (!box) return;
  const myId = getActiveUser()?.id;
  const list = messages();
  if (!list.length) { box.innerHTML = '<div class="text-xs font-body text-on-surface-variant italic text-center py-8">No messages yet — say hello.</div>'; return; }
  box.innerHTML = list.map(m => {
    const mine = m.uid && m.uid === myId;
    const t = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};margin-bottom:8px">
      <div style="font-size:10px;color:#46555a;margin:0 6px 2px">${mine ? 'You' : _esc(m.name)} · ${t}</div>
      <div style="max-width:82%;padding:7px 11px;border-radius:14px;font-size:13px;line-height:1.35;white-space:pre-wrap;word-break:break-word;background:${mine ? '#1a5252' : '#d0d6da'};color:${mine ? '#fff' : '#0e1a1a'}">${_esc(m.text)}</div>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

export function updateChatBadge() {
  const badge = document.getElementById('chat-badge'); if (!badge) return;
  const myId = getActiveUser()?.id;
  const unread = messages().filter(m => m.ts > seenTs() && m.uid !== myId).length;
  if (unread > 0 && !_chatOpen) { badge.textContent = unread > 9 ? '9+' : String(unread); badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

// Called from the store subscription whenever config (incl. chat_log) syncs in — keeps the
// open panel live, surfaces a toast for a new incoming message, and updates the unread badge.
export function onChatSync() {
  const list = messages();
  const newest = list.length ? list[list.length - 1] : null;
  const myId = getActiveUser()?.id;
  if (!_chatInit) { _chatInit = true; _lastNotifiedTs = newest ? newest.ts : Date.now(); }   // baseline on load — don't toast history
  else if (newest && newest.ts > _lastNotifiedTs) {
    _lastNotifiedTs = newest.ts;
    // Only surface chat toasts on the dashboard — never on the customer-facing check-in screen.
    const onDashboard = document.getElementById('screen-desk')?.classList.contains('active');
    if (newest.uid !== myId && !_chatOpen && onDashboard) showToast(`💬 ${newest.name}: ${newest.text.slice(0, 40)}`);
  }
  if (_chatOpen) { renderChat(); markSeen(); }
  updateChatBadge();
}
