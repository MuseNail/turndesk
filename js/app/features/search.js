// ── Global search (A3, v4.77) ────────────────────────────────────────────────
// Header magnifier → overlay that searches the data already in the app (no network):
// customers, today's queue, recent transactions (90 days), gift cards, and today's
// not-yet-checked-in appointments. Tap a result to jump straight to it.
import { getState } from '../store.js';
import { escHtml, escAttrJs } from '../utils.js';

// DO customer entities (state.customers) carry firstName/lastName/phone — match the
// directory's real shape (square-customers.js rebuildDirectory), not the old Square
// given_name/phone_number fields. esc kept as an alias of the shared HTML escaper.
const esc = escHtml;
const nameOf  = c => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '';
const phoneOf = c => c.phone || c.phone_number || '';

export function openGlobalSearch() {
  closeGlobalSearch();
  const m = document.createElement('div');
  m.id = 'global-search-modal';
  m.className = 'fixed inset-0 z-[120] flex items-start justify-center bg-on-surface/40 px-4 pt-20';
  m.onclick = e => { if (e.target === m) closeGlobalSearch(); };
  m.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
    <div class="relative">
      <span class="material-symbols-outlined absolute left-4 top-3.5 text-primary" style="font-size:22px">search</span>
      <input id="gs-input" type="text" placeholder="Name, phone, or gift card #…" autocomplete="off"
        oninput="gsInput(this.value)"
        class="w-full border-0 border-b border-surface-container-high bg-transparent pl-12 pr-12 py-3.5 text-base font-body text-on-surface outline-none placeholder:text-outline-variant">
      <button onclick="closeGlobalSearch()" class="absolute right-3 top-3 w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">close</span></button>
    </div>
    <div id="gs-results" class="max-h-[60vh] overflow-y-auto no-scroll"></div>
  </div>`;
  document.body.appendChild(m);
  setTimeout(() => document.getElementById('gs-input')?.focus(), 60);
}
export function closeGlobalSearch() { document.getElementById('global-search-modal')?.remove(); }

let _gsTimer = null;
export function gsInput(val) {
  // Debounce: the scan touches customers + queue + 90 days of records + gift cards +
  // today's appointments — re-running it on every keystroke janks on a busy iPad.
  clearTimeout(_gsTimer);
  _gsTimer = setTimeout(() => _gsRender(val), 140);
}
function _gsRender(val) {
  const box = document.getElementById('gs-results'); if (!box) return;
  const qstr = String(val || '').trim();
  if (qstr.length < 2) { box.innerHTML = ''; return; }
  const groups = _gsSearch(qstr);
  if (!groups.length) { box.innerHTML = '<div class="px-5 py-4 text-sm font-body text-on-surface-variant">No matches.</div>'; return; }
  box.innerHTML = groups.map(g => `
    <div class="px-4 pt-2.5 pb-1 text-[10px] font-body font-bold uppercase tracking-widest text-outline bg-surface-container-low">${g.label}</div>
    ${g.rows.map(r => `<button onclick="${r.go}" class="w-full flex items-center gap-3 px-4 py-2.5 border-b border-surface-container hover:bg-surface-container-low transition-colors text-left">
      <span class="material-symbols-outlined text-primary flex-shrink-0" style="font-size:19px">${g.icon}</span>
      <span class="min-w-0 flex-1"><span class="block font-body font-semibold text-sm text-on-surface truncate">${r.title}</span>
        ${r.sub ? `<span class="block text-[11px] font-body text-on-surface-variant truncate">${r.sub}</span>` : ''}</span>
      <span class="material-symbols-outlined text-outline-variant flex-shrink-0" style="font-size:16px">chevron_right</span>
    </button>`).join('')}`).join('');
}

function _gsSearch(qstr) {
  const ql = qstr.toLowerCase(), digits = qstr.replace(/\D/g, '');
  const phoneQ = digits.length >= 3 ? digits : '';
  const nameHit  = s => s && String(s).toLowerCase().includes(ql);
  const phoneHit = p => phoneQ && String(p || '').replace(/\D/g, '').includes(phoneQ);
  const st = getState();
  const out = [];

  // Customers (directory)
  const custs = (st.customers || []).filter(Boolean).filter(c => nameHit(nameOf(c)) || phoneHit(phoneOf(c))).slice(0, 5);
  if (custs.length) out.push({ label: 'Customers', icon: 'person', rows: custs.map(c => ({
    title: esc(nameOf(c) || '(no name)'), sub: esc(phoneOf(c)),
    go: `gsGo('cust','${escAttrJs(String(c.id))}')`,
  })) });

  // In the queue today
  const qrows = (st.queue || []).filter(Boolean).filter(e => nameHit(e.name) || phoneHit(e.phone)).slice(0, 5);
  if (qrows.length) out.push({ label: 'In the queue today', icon: 'confirmation_number', rows: qrows.map(e => ({
    title: esc(e.name || '(no name)'),
    sub: esc(`${(e.services || []).length} service(s) · ${e.status === 'inservice' ? 'In Service' : e.status === 'complete' ? 'Done' : e.status === 'paid' || e.status === 'done' ? 'Paid' : 'Waiting'}`),
    go: `gsGo('queue','${escAttrJs(String(e.id))}')`,
  })) });

  // Today's appointments (not yet checked in — checked-in ones surface via the queue above)
  try {
    const appts = (window.apptsForReminders?.() || []).filter(a => nameHit(a.name)).slice(0, 4);
    if (appts.length) out.push({ label: "Today's appointments", icon: 'event', rows: appts.map(a => ({
      title: esc(a.name),
      sub: esc(`${new Date(a.startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${a.svc ? ' · ' + a.svc : ''}${a.techName ? ' · ' + a.techName : ''}`),
      go: `gsGo('appt','${escAttrJs(a.name)}')`,
    })) });
  } catch {}

  // Recent transactions (90 days)
  const cutoff = Date.now() - 90 * 86400000;
  const recs = (st.records || []).filter(Boolean).filter(r => {
    if (r.status === 'deleted') return false;
    const t = new Date(r.completedAt || r.checkinTime || 0).getTime();
    return t >= cutoff && (nameHit(r.name) || phoneHit(r.phone));
  }).sort((a, b) => new Date(b.completedAt || b.checkinTime) - new Date(a.completedAt || a.checkinTime)).slice(0, 5);
  if (recs.length) out.push({ label: 'Recent transactions', icon: 'receipt_long', rows: recs.map(r => {
    const d = new Date(r.completedAt || r.checkinTime);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { title: esc(`${r.name || '(no name)'} — $${(r.totalCost || 0).toFixed(2)}`),
      sub: esc(d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + (r.status === 'refund' ? ' · refund' : '')),
      go: `gsGo('txn','${day}')` };
  }) });

  // Gift cards (serial or recipient)
  const gcs = (st.giftcards || []).filter(Boolean).filter(g => {
    const serialHit = ql.length >= 2 && String(g.serial || '').toLowerCase().includes(ql);
    return serialHit || nameHit(g.to) || nameHit(g.from);
  }).slice(0, 4);
  if (gcs.length) out.push({ label: 'Gift cards', icon: 'card_giftcard', rows: gcs.map(g => ({
    title: esc(`GC${g.serial ? ' #' + g.serial : ''} — $${(+g.amount || 0).toFixed(2)}`),
    sub: esc([g.to ? 'to ' + g.to : '', g.from ? 'from ' + g.from : ''].filter(Boolean).join(' · ')),
    go: `gsGo('gc','${escAttrJs(String(g.id))}')`,
  })) });

  return out;
}

// Result tap → jump. One dispatcher keeps the inline onclicks tiny and safe.
export function gsGo(kind, a) {
  closeGlobalSearch();
  if (kind === 'cust')  { window.showEditCustomer?.(a); return; }
  if (kind === 'queue') { window.showDashPanel?.('queue'); window.showGroupAssignModal?.(a); return; }
  if (kind === 'txn')   { window.showDashPanel?.('transactions'); window.selectRangeDay?.(a); return; }
  if (kind === 'gc')    { window.showDashPanel?.('giftcards'); window.showEditGiftCard?.(a); return; }
  if (kind === 'appt')  {
    const hit = window.findTodayApptFor?.('', a);
    if (hit) window.calEventClick?.({ stopPropagation() {} }, hit.calId, hit.eventId, hit.name, '', true);
    else { window.showDashPanel?.('calendar'); }
    return;
  }
}
