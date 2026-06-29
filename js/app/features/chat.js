// ── Staff chat ──────────────────────────────────────────────────────────────
// A small messaging surface for staff: a "Team" group channel + private 1:1 DMs,
// with @mentions. Messages live in config.chat_log and sync to every device.
// Sending uses the 'chat.append' op: the DO appends the single message to its own
// stored array (serialized, idempotent by id) so two people sending at once can't
// clobber each other — unlike a whole-array config.set. Unread (per conversation)
// and last-seen markers are device-local (localStorage), not synced.
//
// Identity: a "person id" (pid) is namespaced — 'fd:<id>' (front-desk user) or
// 'tech:<id>' (technician) — so DMs/mentions can target either kind across the
// dashboard and the staff app. On the dashboard "me" is the signed-in front-desk
// user; the staff app sets its own identity via setChatIdentity().
//
// Push: on an @mention or DM, pushNotify() pings the recipient's phone via the
// Worker's /push/notify fan-out (recipients subscribe by pid in the staff app).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveUser } from '../session.js';
import { showToast } from '../utils.js';
import { PUSH_PROXY } from '../config.js';

const cfg = () => getState().config;
const CHAT_CAP = 300;
const SEEN_KEY = 'muse_chat_seen';   // device-local { channelKey: lastSeenMs }

// ── Identity ──────────────────────────────────────────────────────────────────
// The dashboard defaults "me" to the active front-desk user. The staff app calls
// setChatIdentity('tech:<id>' or 'fd:<id>', name) so its surface speaks as that person.
let _identity = null;   // { pid, name } override; null → derive from the dashboard session
export function setChatIdentity(pid, name) { _identity = pid ? { pid, name: name || 'Staff' } : null; }
const myPid  = () => _identity ? _identity.pid  : (getActiveUser() ? 'fd:' + getActiveUser().id : '');
const myName = () => _identity ? _identity.name : (getActiveUser()?.name || 'Staff');

// Everyone reachable in chat: front-desk users + active technicians.
export function chatPeople() {
  const c = cfg();
  const fds = (c.fd_users || []).map(u => ({ pid: 'fd:' + u.id, name: u.name || 'Front desk', kind: 'fd' }));
  const inactive = new Set(c.inactive_staff || []);
  const techs = (c.staff || []).filter(s => !inactive.has(s.id)).map(s => ({ pid: 'tech:' + s.id, name: s.name || 'Tech', kind: 'tech' }));
  return [...fds, ...techs];
}
const personName = pid => chatPeople().find(p => p.pid === pid)?.name || 'Someone';
const firstName  = pid => personName(pid).split(' ')[0];

// ── Channels / messages ───────────────────────────────────────────────────────
const TEAM = 'team';        // everyone (front desk + techs)
const FD_TEAM = 'team-fd';  // dedicated front-desk-only group; every message pings all FD members
const dmKey = (a, b) => 'dm:' + [a, b].sort().join('~');
const dmParts = ch => ch.slice(3).split('~');
const dmInvolves = (ch, pid) => ch.startsWith('dm:') && dmParts(ch).includes(pid);
const dmOther = (ch, me) => { const p = dmParts(ch); return p[0] === me ? p[1] : p[0]; };
const isGroupCh = ch => ch === TEAM || ch === FD_TEAM;
const amFd = () => myPid().startsWith('fd:');                       // front-desk identity → sees the Front Desk channel
const fdMemberPids = () => (cfg().fd_users || []).map(u => 'fd:' + u.id);

// Auto-clear daily at the 4 AM salon-day start (mirrors the rest of the app).
const DAY_START_HOUR = 4;
function dayStartTs() {
  const d = new Date(), c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR, 0, 0, 0);
  if (d.getTime() < c.getTime()) c.setDate(c.getDate() - 1);
  return c.getTime();
}
const allMsgs = () => (Array.isArray(cfg().chat_log) ? cfg().chat_log : []).filter(m => (m.ts || 0) >= dayStartTs());
const chOf = m => m.ch || 'team';   // legacy messages had no channel → Team
const msgsFor = ch => allMsgs().filter(m => chOf(m) === ch);
const teamMsgs = () => msgsFor('team');

const _esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Highlight @mentions of known people in message text.
function withMentions(text) {
  let out = _esc(text);
  chatPeople().forEach(p => {
    const f = _esc(firstName(p.pid));
    if (!f) return;
    out = out.replace(new RegExp('@' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'),
      '<span class="chat-tag">@' + f + '</span>');
  });
  return out;
}

// ── Unread (device-local, per channel) ────────────────────────────────────────
function seenMap() { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } }
function markSeen(ch) { try { const m = seenMap(); m[ch] = Date.now(); localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) {} }
function unreadFor(ch) { const s = seenMap()[ch] || 0, me = myPid(); return msgsFor(ch).filter(m => m.ts > s && m.uid !== me).length; }
function totalUnread() {
  const me = myPid();
  let n = unreadFor(TEAM) + (amFd() ? unreadFor(FD_TEAM) : 0);
  dmConversations().forEach(c => { n += unreadFor(dmKey(me, c.pid)); });
  return n;
}

// DM conversations involving me, newest first.
function dmConversations() {
  const me = myPid(); if (!me) return [];
  const map = new Map();
  allMsgs().forEach(m => {
    const ch = chOf(m); if (!dmInvolves(ch, me)) return;
    const other = dmOther(ch, me);
    const cur = map.get(other);
    if (!cur || m.ts > cur.lastTs) map.set(other, { pid: other, name: personName(other), lastTs: m.ts, lastText: m.text, lastMine: m.uid === me });
  });
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
}

// ── Panel state ───────────────────────────────────────────────────────────────
let _open = false, _view = 'list', _maxed = false, _atOpen = false, _draft = '', _pendMentions = [];
let _lastNotifiedTs = 0, _chatInit = false, _emojiOpen = false, _deskNotify = false;

// Common emojis for the composer picker — curated (no external library / build step).
const CHAT_EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','🥰','😎','🤩','🥳','😅','😴','🤔','😬','😭','😡','👍','👎','🙏','👏','🙌','💪','👋','🙋','💅','💆','💋','💯','🔥','⭐','✨','🎉','❤️','💕','✅','❌','⏰','📅','☕'];

export function toggleChat() { _open ? closeChat() : openChat(); }
export function openChat() {
  _open = true; _view = 'list'; _atOpen = false; _draft = '';
  // Opening the chat counts as seeing the group channels (their previews show in the
  // list) — clears the lingering group-badge. DMs keep their unread dot until opened.
  markSeen(TEAM); if (amFd()) markSeen(FD_TEAM);
  const p = document.getElementById('chat-panel'); if (p) { p.classList.remove('hidden'); p.style.display = 'flex'; }
  render(); updateChatBadge();
}
export function closeChat() {
  _open = false; _atOpen = false;
  const p = document.getElementById('chat-panel'); if (p) { p.classList.add('hidden'); p.style.display = ''; }
}
export function chatBack() { _view = 'list'; _atOpen = false; _emojiOpen = false; _draft = ''; render(); }
export function chatToggleMax() { _maxed = !_maxed; render(); }
export function chatNewMessage() { _view = 'new'; _atOpen = false; _emojiOpen = false; render(); }
export function chatToggleMentions() { _atOpen = !_atOpen; if (_atOpen) _emojiOpen = false; render(); }
export function chatToggleEmoji() { _emojiOpen = !_emojiOpen; if (_emojiOpen) _atOpen = false; render(); }
// Insert an emoji at the cursor WITHOUT re-rendering, so the picker stays open and the
// phone keyboard never closes (the same constraint that drove the incremental sync).
export function chatInsertEmoji(em) {
  const input = document.getElementById('chat-input'); if (!input) return;
  if ((input.value || '').length + em.length > 1000) return;
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + em + input.value.slice(e);
  _draft = input.value;
  const pos = s + em.length;
  try { input.focus({ preventScroll: true }); input.setSelectionRange(pos, pos); } catch (_) {}
}
export function chatDraft(v) { _draft = v; }

// ── Desktop notifications (front-desk dashboard) ──────────────────────────────
// The dashboard opts in (main.js) so new chat messages can pop a Windows/desktop
// notification. The staff app does NOT opt in — it already gets Web Push, so we'd
// otherwise double-notify. Fires a system Notification while the page is alive (no
// service-worker push needed); the always-on front-desk PC keeps the app running.
export function initChatDeskNotify() { _deskNotify = true; }
const deskNotifySupported = () => _deskNotify && typeof Notification !== 'undefined';
export async function enableDeskChatNotify() {
  if (typeof Notification === 'undefined') { showToast('This browser doesn’t support notifications'); return; }
  if (Notification.permission === 'denied') { showToast('Notifications are blocked — turn them on in the browser’s site settings (lock icon → Notifications → Allow), then try again'); return; }
  let perm = Notification.permission;
  if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch (e) {} }
  showToast(perm === 'granted' ? 'Desktop notifications on ✓' : 'Notifications not turned on');
  if (perm === 'granted') render();
}
function _fireDeskNotification(who, msg, nch) {
  try {
    const n = new Notification(who, {
      body: (msg.text || '').slice(0, 140), tag: 'muse-chat', renotify: true,
      icon: '/turndesk/icons/icon-192.png',
    });
    n.onclick = () => {
      try { window.focus(); } catch (e) {}
      openChat(); chatOpen(nch.startsWith('dm:') ? 'dm:' + msg.uid : nch);
      try { n.close(); } catch (e) {}
    };
  } catch (e) {}
}

const channelOfView = () => _view.startsWith('dm:') ? dmKey(myPid(), _view.slice(3)) : (isGroupCh(_view) ? _view : null);

export function chatOpen(view) {
  _view = view; _atOpen = false; _emojiOpen = false; _draft = ''; _pendMentions = [];
  const ch = channelOfView(); if (ch) markSeen(ch);
  render(); updateChatBadge();
}
export function chatPickMention(pid) {
  if (!_pendMentions.includes(pid)) _pendMentions.push(pid);
  const input = document.getElementById('chat-input');
  _draft = ((input?.value || _draft || '').replace(/\s*$/, '') + ' @' + firstName(pid) + ' ').replace(/^\s+/, '');
  _atOpen = false; render();
  setTimeout(() => { const i = document.getElementById('chat-input'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 30);
}

export function sendChatMessage() {
  const input = document.getElementById('chat-input'); if (!input) return;
  const text = (input.value || '').trim(); if (!text) return;
  const me = myPid(); if (!me) { showToast('Sign in to chat.'); return; }
  let ch = TEAM, to = '', mentions = [];
  if (_view.startsWith('dm:')) { to = _view.slice(3); ch = dmKey(me, to); }
  else if (_view === FD_TEAM) { ch = FD_TEAM; }
  else { mentions = _pendMentions.filter(pid => text.includes('@' + firstName(pid))); }
  const msg = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), uid: me, name: myName(), text: text.slice(0, 1000), ts: Date.now(), ch };
  if (to) msg.to = to;
  if (mentions.length) msg.mentions = mentions;
  dispatch('chat.append', { message: msg });   // DO-side atomic append — no whole-array clobber
  _draft = ''; _pendMentions = []; _atOpen = false; _emojiOpen = false; _lastNotifiedTs = msg.ts;
  markSeen(ch); render(); updateChatBadge();
  // Push: DM → the recipient; Front Desk channel → every FD member; Team → @mentioned only.
  let targets, title;
  if (to) { targets = [to]; title = myName(); }
  else if (ch === FD_TEAM) { targets = fdMemberPids(); title = myName() + ' · Front Desk'; }
  else { targets = mentions; title = myName() + ' · Team'; }
  pushNotify(targets, title, text);
}
// Ping recipients' phones via the Worker push fan-out (/push/notify accepts person ids;
// the staff app subscribes each person under their pid — tech:<id> / fd:<id>). Target the
// pid only: a tech's device is registered under BOTH tech:<id> and the raw techId, so also
// sending to the raw id delivered the SAME push twice (the "coming in twice" bug). Best-effort.
function pushNotify(pids, title, text) {
  const me = myPid();
  const uniq = [...new Set((pids || []).filter(p => p && p !== me))];
  if (!uniq.length) return;
  fetch(PUSH_PROXY + '/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ techIds: uniq, title: String(title).slice(0, 80), body: String(text).slice(0, 200), tag: 'muse-chat' }),
  }).catch(() => {});
}
export function chatInputKey(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChatMessage(); } }

// Manager-only: wipe the chat for everyone (in addition to the automatic 4 AM clear).
export function clearChat() {
  if (getActiveUser()?.role !== 'admin') { showToast('Only a manager can clear the chat.'); return; }
  const doClear = () => { dispatch('config.set', { key: 'chat_log', value: [] }); render(); updateChatBadge(); showToast('Chat cleared'); };
  if (window.showWarnModal) window.showWarnModal('Clear chat for everyone?', 'This permanently removes the chat history on all devices.', doClear);
  else doClear();
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const AV_COLORS = ['#1a5252', '#7a4ea0', '#c77700', '#2a7a4f', '#b5306e', '#3a6ea5', '#9a6b00'];
const avColor = pid => AV_COLORS[Math.abs([...String(pid)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % AV_COLORS.length];
const initial = n => (n || '?').charAt(0).toUpperCase();
const timeStr = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function applySize(p) {
  if (_maxed) { p.style.width = 'min(440px,calc(100vw - 24px))'; p.style.height = 'min(660px,calc(100vh - 80px))'; }
  else { p.style.width = '360px'; p.style.height = '520px'; }
}
function header(title, icon, withBack) {
  const maxIcon = _maxed ? 'close_fullscreen' : 'open_in_full';
  const clearBtn = (_view === 'team' && getActiveUser()?.role === 'admin')
    ? `<button onclick="clearChat()" title="Clear chat for everyone" class="chat-hbtn"><span class="material-symbols-outlined" style="font-size:18px">delete</span></button>` : '';
  return `<div class="chat-head">
    ${withBack ? `<button onclick="chatBack()" class="chat-hbtn" title="Back"><span class="material-symbols-outlined" style="font-size:22px">arrow_back</span></button>` : ''}
    <div class="chat-title"><span class="material-symbols-outlined" style="font-size:20px;color:var(--primary,#1a5252)">${icon}</span> ${_esc(title)}</div>
    ${clearBtn}
    <button onclick="chatToggleMax()" class="chat-hbtn" title="${_maxed ? 'Restore size' : 'Maximize'}"><span class="material-symbols-outlined" style="font-size:18px">${maxIcon}</span></button>
    <button onclick="closeChat()" class="chat-hbtn" title="Close"><span class="material-symbols-outlined" style="font-size:20px">close</span></button>
  </div>`;
}
function listView() {
  const me = myPid();
  const groupRow = (ch, name, bg, icon) => {
    const u = unreadFor(ch), msgs = msgsFor(ch), last = msgs[msgs.length - 1];
    const prev = last ? _esc((last.uid === me ? 'You: ' : (firstName(last.uid) + ': ')) + last.text) : 'No messages yet';
    return `<div class="chat-conv" onclick="chatOpen('${ch}')">
      <div class="chat-av" style="background:${bg}"><span class="material-symbols-outlined" style="font-size:20px">${icon}</span></div>
      <div class="chat-cmid"><div class="chat-cname">${name}</div><div class="chat-cprev">${prev}</div></div>
      ${u ? `<span class="chat-unread">${u > 9 ? '9+' : u}</span>` : ''}
    </div>`;
  };
  const teamRow = groupRow(TEAM, 'Team', '#1a5252', 'groups')
    + (amFd() ? groupRow(FD_TEAM, 'Front Desk', '#7a4ea0', 'support_agent') : '');
  const dms = dmConversations().map(c => {
    const u = unreadFor(dmKey(me, c.pid));
    return `<div class="chat-conv" onclick="chatOpen('dm:${c.pid}')">
      <div class="chat-av" style="background:${avColor(c.pid)}">${initial(c.name)}</div>
      <div class="chat-cmid"><div class="chat-cname">${_esc(c.name)}</div><div class="chat-cprev">${_esc((c.lastMine ? 'You: ' : '') + c.lastText)}</div></div>
      <div class="chat-cright"><span class="chat-ctime">${timeStr(c.lastTs)}</span>${u ? `<span class="chat-unread">${u > 9 ? '9+' : u}</span>` : ''}</div>
    </div>`;
  }).join('');
  const notifBar = (deskNotifySupported() && Notification.permission !== 'granted')
    ? `<div class="chat-notifbar" onclick="enableDeskChatNotify()"><span class="material-symbols-outlined" style="font-size:18px">notifications_active</span><span>Turn on desktop notifications for new messages</span></div>` : '';
  return header('Chat', 'forum', false)
    + `<div class="chat-body">
        ${notifBar}
        <div class="chat-seclbl">Group</div>${teamRow}
        ${dms ? `<div class="chat-seclbl">Direct messages</div>${dms}` : ''}
      </div>
      <div class="chat-composer"><button onclick="chatNewMessage()" class="chat-cbtn at" title="New message"><span class="material-symbols-outlined" style="font-size:19px">edit_square</span></button>
        <input readonly onclick="chatNewMessage()" placeholder="Start a new message…" class="chat-input"></div>`;
}
function newView() {
  const rows = chatPeople().filter(p => p.pid !== myPid()).map(p =>
    `<div class="chat-conv" onclick="chatOpen('dm:${p.pid}')">
      <div class="chat-av" style="background:${avColor(p.pid)}">${initial(p.name)}</div>
      <div class="chat-cmid"><div class="chat-cname">${_esc(p.name)}</div></div>
      <span class="chat-role">${p.kind === 'tech' ? 'Tech' : 'Front desk'}</span>
    </div>`).join('') || `<div class="chat-empty">No one to message yet.</div>`;
  return header('New message', 'edit_square', true) + `<div class="chat-body"><div class="chat-seclbl">Pick someone</div>${rows}</div>`;
}
// Just the contents of .chat-msgs (hint + message bubbles) for the current thread —
// so onChatSync can refresh the message list WITHOUT rebuilding the composer/input
// (rebuilding the input drops focus and closes the phone keyboard mid-typing).
function threadBodyHtml() {
  const me = myPid(), isGroup = isGroupCh(_view), isFdTeam = _view === FD_TEAM;
  const other = isGroup ? null : _view.slice(3);
  const list = msgsFor(channelOfView());
  const body = list.length ? list.map(m => {
    const mine = m.uid === me;
    return `<div class="chat-msg ${mine ? 'me' : ''}"><div class="chat-meta">${isGroup ? (mine ? 'You' : _esc(firstName(m.uid) || m.name)) + ' · ' : ''}${timeStr(m.ts)}</div><div class="chat-bub ${mine ? 'mine' : 'other'}">${withMentions(m.text)}</div></div>`;
  }).join('') : `<div class="chat-empty">${isGroup ? 'No messages yet — say hello.' : 'No messages yet. Say hi to ' + _esc(firstName(other)) + '.'}</div>`;
  const hint = isFdTeam ? '<div class="chat-dmhint">Front-desk team · every message pings the front desk</div>'
             : isGroup  ? '' : `<div class="chat-dmhint">Private message to ${_esc(personName(other))} · will ping their phone</div>`;
  return hint + body;
}
// Refresh ONLY the open thread's messages (preserves the composer/input + keyboard).
// Returns false if there's no open thread to refresh (caller falls back to full render).
function refreshThreadMessages() {
  const p = document.getElementById('chat-panel'); if (!p) return false;
  if (_view === 'list' || _view === 'new') return false;
  const box = p.querySelector('.chat-msgs'); if (!box) return false;
  box.innerHTML = threadBodyHtml();
  const sc = p.querySelector('.chat-body'); if (sc) { const toB = () => { sc.scrollTop = sc.scrollHeight; }; toB(); requestAnimationFrame(toB); }
  return true;
}
function threadView() {
  const me = myPid(), isGroup = isGroupCh(_view), isFdTeam = _view === FD_TEAM;
  const other = isGroup ? null : _view.slice(3);
  const ch = channelOfView();
  const list = msgsFor(ch);
  const body = list.length ? list.map(m => {
    const mine = m.uid === me;
    return `<div class="chat-msg ${mine ? 'me' : ''}">
      <div class="chat-meta">${isGroup ? (mine ? 'You' : _esc(firstName(m.uid) || m.name)) + ' · ' : ''}${timeStr(m.ts)}</div>
      <div class="chat-bub ${mine ? 'mine' : 'other'}">${withMentions(m.text)}</div>
    </div>`;
  }).join('') : `<div class="chat-empty">${isGroup ? 'No messages yet— say hello.' : 'No messages yet. Say hi to ' + _esc(firstName(other)) + '.'}</div>`;
  const atPop = (_atOpen && isGroup) ? `<div class="chat-atpop">${chatPeople().filter(p => p.pid !== me).map(p =>
    `<div class="chat-atrow" onclick="chatPickMention('${p.pid}')"><div class="chat-av sm" style="background:${avColor(p.pid)}">${initial(p.name)}</div>${_esc(p.name)}<span class="chat-role">${p.kind === 'tech' ? 'Tech' : 'Front desk'}</span></div>`).join('')}</div>` : '';
  const emojiPop = _emojiOpen ? `<div class="chat-emojipop">${CHAT_EMOJIS.map(e => `<button type="button" class="chat-emoji" onclick="chatInsertEmoji('${e}')">${e}</button>`).join('')}</div>` : '';
  const dmHint = isFdTeam ? '<div class="chat-dmhint">Front-desk team &middot; every message pings the front desk</div>' : isGroup ? '' : `<div class="chat-dmhint">Private message to ${_esc(personName(other))}${' '}· will ping their phone</div>`;
  const ph = isFdTeam ? 'Message the front desk' : isGroup ?'Message the team…' : 'Message ' + _esc(firstName(other)) + '…';
  return header(isFdTeam ? 'Front Desk' : isGroup ? 'Team' : personName(other), isFdTeam ? 'support_agent' : isGroup ? 'groups' : 'person', true)
    + `<div class="chat-body"><div class="chat-msgs">${threadBodyHtml()}</div></div>`
    + `<div class="chat-composer">${atPop}${emojiPop}
        ${isGroup ? `<button onclick="chatToggleMentions()" class="chat-cbtn at" title="Mention someone"><span class="material-symbols-outlined" style="font-size:19px">alternate_email</span></button>` : ''}
        <button onclick="chatToggleEmoji()" class="chat-cbtn at" title="Emoji"><span class="material-symbols-outlined" style="font-size:20px">mood</span></button>
        <input id="chat-input" class="chat-input" maxlength="1000" autocomplete="off" placeholder="${ph}" oninput="chatDraft(this.value)" onkeydown="chatInputKey(event)">
        <button onclick="sendChatMessage()" class="chat-cbtn send" title="Send"><span class="material-symbols-outlined" style="font-size:18px">send</span></button>
      </div>`;
}
function render() {
  const p = document.getElementById('chat-panel'); if (!p || !_open) return;
  applySize(p);
  p.innerHTML = _view === 'list' ? listView() : _view === 'new' ? newView() : threadView();
  const input = document.getElementById('chat-input');
  if (input && _view !== 'list' && _view !== 'new') {
    input.value = _draft;
    const box = p.querySelector('.chat-body');   // the scroll container (overflow-y:auto), NOT .chat-msgs
    const toBottom = () => { if (box) box.scrollTop = box.scrollHeight; };
    toBottom();                       // sync
    requestAnimationFrame(toBottom);  // after layout/paint (heights settled)
    // focus without yanking the view, then pin to the latest message once more
    setTimeout(() => { try { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } catch (e) {} toBottom(); }, 30);
  }
}
// Back-compat alias (older callers / store subscription used renderChat()).
export function renderChat() { render(); }

export function updateChatBadge() {
  const badge = document.getElementById('chat-badge'); if (!badge) return;
  const n = totalUnread();
  if (n > 0 && !_open) { badge.textContent = n > 9 ? '9+' : String(n); badge.classList.remove('hidden'); }
  else { badge.textContent = ''; badge.classList.add('hidden'); }
}

// Called from the store subscription when config (incl. chat_log) syncs in.
export function onChatSync() {
  const list = allMsgs();
  const newest = list.length ? list[list.length - 1] : null;
  const me = myPid();
  if (!_chatInit) { _chatInit = true; _lastNotifiedTs = newest ? newest.ts : Date.now(); }
  else if (newest && newest.ts > _lastNotifiedTs) {
    _lastNotifiedTs = newest.ts;
    // Dashboard: only on the desk screen (never the customer kiosk). Staff/reports
    // apps have no #screen-desk, so allow the toast there.
    const deskEl = document.getElementById('screen-desk');
    const onSurface = deskEl ? deskEl.classList.contains('active') : true;
    const nch = chOf(newest);
    const toMe = nch.startsWith('dm:') ? dmInvolves(nch, me) : (nch === FD_TEAM ? amFd() : true);
    if (me && newest.uid !== me && toMe) {
      const who = firstName(newest.uid) || newest.name;
      const tag = nch.startsWith('dm:') ? '💬 ' : '';
      if (!_open && onSurface) showToast(`${tag}${who}: ${newest.text.slice(0, 40)}`);
      // Desktop system notification (dashboard opt-in). Fire when the app is backgrounded
      // (they're in another window) or on the desk screen with chat closed — never while the
      // customer kiosk is foregrounded, so chat never flashes in front of a customer.
      if (deskNotifySupported() && Notification.permission === 'granted'
          && (document.hidden || (!_open && onSurface))) {
        _fireDeskNotification(who, newest, nch);
      }
    }
  }
  if (_open) {
    const ch = channelOfView(); if (ch) markSeen(ch);
    // Incremental message refresh keeps the composer/input alive (phone keyboard stays
    // open while typing); fall back to a full render for the list/new views.
    if (!refreshThreadMessages()) render();
  }
  updateChatBadge();
}
