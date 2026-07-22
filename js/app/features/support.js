// ── In-app help desk (staff → developer) ─────────────────────────────────────
// A "Help & Feedback" surface where salon staff file bug reports / questions /
// feedback to the TurnDesk developer and read replies. Tickets live in the Worker's
// reserved registry DO; the apptoken.js fetch wrapper attaches the §13 auth token +
// X-Salon to these same-origin calls, so the server derives the salon + submitter.
import { apiOrigin } from '../apiorigin.js';
import { APP_VERSION } from '../config.js';
import { showToast, escHtml } from '../utils.js';

const ORIGIN = apiOrigin();
const TYPES = [
  { v: 'bug', label: 'Report a problem', short: 'Problem', icon: '🐞' },
  { v: 'question', label: 'Ask a question', short: 'Question', icon: '❓' },
  { v: 'feedback', label: 'Send feedback', short: 'Feedback', icon: '💬' },
];
const MAX_MESSAGE = 5000, MAX_SUBJECT = 120;
const INP_STYLE = 'border-color:var(--surface-container-high,#e5e7eb);background:var(--surface-container-lowest,#fff);color:var(--on-surface,#111)';

let _tickets = [];
let _view = 'list';      // 'list' | 'compose' | 'thread'
let _openId = null;      // the ticket whose thread is showing (when _view==='thread')
let _pollTimer = null;   // refresh while the modal is open

const typeMeta = t => TYPES.find(x => x.v === t) || { icon: '•', short: t };
const fmtWhen = ts => { try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

async function api(path, opts) {
  const r = await fetch(ORIGIN + path, opts);
  let body = {}; try { body = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body };
}

async function loadTickets() {
  const r = await api('/support/tickets', { method: 'GET' });
  if (r.ok) _tickets = Array.isArray(r.body.tickets) ? r.body.tickets : [];
  return _tickets;
}

// True when the user is mid-entry in the modal — a background poll must NOT rebuild the
// DOM under them (it would wipe the compose fields / reply box and drop focus).
function isEditing() {
  const overlay = document.getElementById('support-modal');
  if (!overlay) return false;
  const a = document.activeElement;
  if (a && overlay.contains(a) && /INPUT|TEXTAREA/.test(a.tagName)) return true;
  return [...overlay.querySelectorAll('input,textarea')].some(el => el.type !== 'radio' && el.value.trim());
}

// ── Unread badge on the Settings nav button (dev replies the staff haven't seen) ──
function paintUnreadDot(n) {
  const btn = document.getElementById('nav-settings');
  if (!btn) return;
  let dot = btn.querySelector('.support-unread-dot');
  if (n > 0) {
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'support-unread-dot';
      dot.style.cssText = 'position:absolute;top:4px;right:8px;min-width:8px;height:8px;border-radius:9999px;background:#e5484d;box-shadow:0 0 0 2px var(--surface,#fff)';
      if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
      btn.appendChild(dot);
    }
  } else if (dot) dot.remove();
}
export async function pollSupportUnread() {
  try {
    await loadTickets();
    paintUnreadDot(_tickets.filter(t => t.unreadForSalon).length);
    if (document.getElementById('support-modal') && !isEditing()) renderModal();   // keep an open modal fresh, but never mid-typing
  } catch {}
}

// ── Modal ────────────────────────────────────────────────────────────────────
export function openSupport() {
  if (!document.getElementById('support-modal')) {
    const overlay = document.createElement('div');
    overlay.id = 'support-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,.5);padding:16px';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSupport(); });
    document.body.appendChild(overlay);
  }
  _view = 'list'; _openId = null;
  renderModal();
  loadTickets().then(() => { if (!isEditing()) renderModal(); });
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => loadTickets().then(() => { if (!isEditing()) renderModal(); }), 20000);
}
export function closeSupport() {
  document.getElementById('support-modal')?.remove();
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _view = 'list'; _openId = null;
  pollSupportUnread();   // refresh the nav dot on close
}

function renderModal() {
  const overlay = document.getElementById('support-modal');
  if (!overlay) return;
  let inner;
  if (_view === 'compose') inner = newHtml();
  else if (_view === 'thread') inner = threadHtml(_tickets.find(t => t.id === _openId));
  else inner = listHtml();
  overlay.innerHTML = `<div class="rounded-2xl w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden shadow-2xl" style="background:var(--surface,#fff)">${inner}</div>`;
  wire(overlay);
}

function listHtml() {
  const rows = _tickets.length === 0
    ? `<p class="text-sm text-on-surface-variant px-1 py-6 text-center">No messages yet. Tap “New message” to reach the TurnDesk team.</p>`
    : _tickets.map(t => {
        const m = typeMeta(t.type);
        const last = t.messages[t.messages.length - 1] || {};
        const dot = t.unreadForSalon ? '<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:#e5484d;margin-left:6px" title="New reply"></span>' : '';
        const statusPill = t.status === 'resolved'
          ? '<span class="text-[11px] px-2 py-0.5 rounded-full" style="background:#dcfce7;color:#166534">Resolved</span>'
          : t.status === 'replied'
            ? '<span class="text-[11px] px-2 py-0.5 rounded-full" style="background:#dbeafe;color:#1e40af">Replied</span>'
            : '<span class="text-[11px] px-2 py-0.5 rounded-full" style="background:#f1f5f9;color:#475569">Open</span>';
        return `<button data-open="${escHtml(t.id)}" class="w-full text-left px-4 py-3 rounded-xl border mb-2 hover:bg-surface-container transition-colors" style="border-color:var(--surface-container-high,#e5e7eb)">
          <div class="flex items-center gap-2">
            <span>${m.icon}</span>
            <span class="font-bold text-on-surface truncate flex-1">${escHtml(t.subject)}${dot}</span>
            ${statusPill}
          </div>
          <div class="text-xs text-on-surface-variant mt-1 truncate">${escHtml((last.from === 'dev' ? 'TurnDesk: ' : '') + (last.text || ''))}</div>
          <div class="text-[11px] text-on-surface-variant mt-0.5">${fmtWhen(t.updatedAt)}</div>
        </button>`;
      }).join('');
  return `
    <div class="flex items-center gap-3 px-5 py-4 border-b" style="border-color:var(--surface-container-high,#e5e7eb)">
      <span class="material-symbols-outlined text-primary">support_agent</span>
      <div class="flex-1"><div class="font-headline font-bold text-lg text-on-surface">Help &amp; Feedback</div>
      <div class="text-xs text-on-surface-variant">Reach the TurnDesk team — bugs, questions &amp; feedback</div></div>
      <button data-close class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined">close</span></button>
    </div>
    <div class="overflow-y-auto px-4 py-3 flex-1">${rows}</div>
    <div class="px-4 py-3 border-t" style="border-color:var(--surface-container-high,#e5e7eb)">
      <button data-new class="w-full py-3 rounded-xl font-bold" style="background:var(--primary,#2a7a4f);color:#fff">New message</button>
    </div>`;
}

function newHtml() {
  return `
    <div class="flex items-center gap-3 px-5 py-4 border-b" style="border-color:var(--surface-container-high,#e5e7eb)">
      <button data-back class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined">arrow_back</span></button>
      <div class="font-headline font-bold text-lg text-on-surface flex-1">New message</div>
      <button data-close class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined">close</span></button>
    </div>
    <div class="overflow-y-auto px-5 py-4 flex-1 space-y-4">
      <div>
        <label class="text-xs font-bold text-on-surface-variant">Type</label>
        <div class="flex gap-2 mt-1">${TYPES.map((t, i) => `<label class="flex-1 flex items-center gap-1 px-3 py-2 rounded-xl border cursor-pointer text-sm text-on-surface" style="border-color:var(--surface-container-high,#e5e7eb)"><input type="radio" name="sup-type" value="${t.v}" ${i === 0 ? 'checked' : ''}> ${t.icon} ${escHtml(t.short)}</label>`).join('')}</div>
      </div>
      <div>
        <label for="sup-subject" class="text-xs font-bold text-on-surface-variant">Subject</label>
        <input id="sup-subject" maxlength="${MAX_SUBJECT}" class="w-full mt-1 px-3 py-2 rounded-xl border text-sm" style="${INP_STYLE}" placeholder="A short summary">
      </div>
      <div>
        <label for="sup-message" class="text-xs font-bold text-on-surface-variant">Message</label>
        <textarea id="sup-message" maxlength="${MAX_MESSAGE}" rows="5" class="w-full mt-1 px-3 py-2 rounded-xl border text-sm" style="${INP_STYLE}" placeholder="What happened, or what would you like to tell us? (Please don't include card numbers.)"></textarea>
      </div>
    </div>
    <div class="px-4 py-3 border-t" style="border-color:var(--surface-container-high,#e5e7eb)">
      <button data-send-new class="w-full py-3 rounded-xl font-bold" style="background:var(--primary,#2a7a4f);color:#fff">Send</button>
    </div>`;
}

function threadHtml(t) {
  if (!t) { _view = 'list'; return listHtml(); }
  const m = typeMeta(t.type);
  const msgs = t.messages.map(msg => {
    const mine = msg.from === 'salon';
    return `<div style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:8px">
      <div style="max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;background:${mine ? 'var(--primary,#2a7a4f)' : 'var(--surface-container-high,#eef0f3)'};color:${mine ? '#fff' : 'var(--on-surface,#1a1d27)'}">
        <div>${escHtml(msg.text)}</div>
        <div style="font-size:10px;opacity:.7;margin-top:3px">${escHtml(msg.from === 'dev' ? (msg.author || 'TurnDesk') : (msg.author || 'You'))} · ${fmtWhen(msg.at)}</div>
      </div></div>`;
  }).join('');
  const closed = t.status === 'resolved';
  return `
    <div class="flex items-center gap-3 px-5 py-4 border-b" style="border-color:var(--surface-container-high,#e5e7eb)">
      <button data-back class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined">arrow_back</span></button>
      <div class="flex-1 min-w-0"><div class="font-bold text-on-surface truncate">${m.icon} ${escHtml(t.subject)}</div>
      <div class="text-[11px] text-on-surface-variant">${closed ? 'Resolved' : t.status === 'replied' ? 'TurnDesk replied' : 'Open'}</div></div>
      <button data-close class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined">close</span></button>
    </div>
    <div class="overflow-y-auto px-4 py-3 flex-1" style="background:var(--surface-container-lowest,#fafafa)">${msgs}</div>
    <div class="px-4 py-3 border-t flex gap-2" style="border-color:var(--surface-container-high,#e5e7eb)">
      <input id="sup-reply" maxlength="${MAX_MESSAGE}" class="flex-1 px-3 py-2 rounded-xl border text-sm" style="${INP_STYLE}" placeholder="Write a reply…">
      <button data-send-reply class="px-4 py-2 rounded-xl font-bold" style="background:var(--primary,#2a7a4f);color:#fff">Send</button>
    </div>`;
}

function wire(overlay) {
  overlay.querySelector('[data-close]')?.addEventListener('click', closeSupport);
  overlay.querySelector('[data-back]')?.addEventListener('click', () => { _view = 'list'; _openId = null; renderModal(); });
  overlay.querySelector('[data-new]')?.addEventListener('click', () => { _view = 'compose'; renderModal(); });
  overlay.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openThread(b.getAttribute('data-open'))));
  overlay.querySelector('[data-send-new]')?.addEventListener('click', sendNew);
  overlay.querySelector('[data-send-reply]')?.addEventListener('click', sendReply);
  overlay.querySelector('#sup-reply')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendReply(); });
}

async function openThread(id) {
  _openId = id; _view = 'thread';
  renderModal();
  const t = _tickets.find(x => x.id === id);
  if (t && t.unreadForSalon) {
    t.unreadForSalon = false;                       // optimistic
    api('/support/ticket/' + encodeURIComponent(id) + '/read', { method: 'POST' }).then(() => pollSupportUnread());
  }
}

async function sendNew() {
  const overlay = document.getElementById('support-modal'); if (!overlay) return;
  const type = overlay.querySelector('input[name="sup-type"]:checked')?.value || 'feedback';
  const subject = (overlay.querySelector('#sup-subject')?.value || '').trim();
  const message = (overlay.querySelector('#sup-message')?.value || '').trim();
  if (!subject) return showToast('Please add a subject.');
  if (!message) return showToast('Please add a message.');
  const btn = overlay.querySelector('[data-send-new]'); if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const r = await api('/support/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, subject, message, appVersion: APP_VERSION }) });
  if (r.ok && r.body.ticket) { showToast('Sent — thank you!'); await loadTickets(); _openId = r.body.ticket.id; _view = 'thread'; renderModal(); }
  else { showToast(r.body.error || 'Could not send — check the connection.'); if (btn) { btn.disabled = false; btn.textContent = 'Send'; } }
}

async function sendReply() {
  const overlay = document.getElementById('support-modal'); if (!overlay || _openId == null) return;
  const input = overlay.querySelector('#sup-reply');
  const message = (input?.value || '').trim();
  if (!message) return;
  if (input) input.disabled = true;
  const r = await api('/support/ticket/' + encodeURIComponent(_openId) + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  if (r.ok && r.body.ticket) {
    const i = _tickets.findIndex(t => t.id === _openId);
    if (i >= 0) _tickets[i] = r.body.ticket;
    renderModal();
  } else { showToast(r.body.error || 'Could not send.'); if (input) input.disabled = false; }
}
