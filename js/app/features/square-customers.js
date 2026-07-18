// ── Square customers: directory, autocomplete, upsert, staff import ─────────
// Customers are owned by Square — kept as a device-local cache (localStorage
// 'turndesk_customers'), NOT in the DO store. Staff import writes config.staff.

import { getState, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, formatPhone, autoCapitalize, dismissNumpad, escHtml, escAttrJs } from '../utils.js';
import { SQUARE_PROXY } from '../config.js';
import { scopedKey } from '../apptoken.js';   // per-salon key isolation — the customer cache holds PII, must never bleed across salons

const cfg = () => getState().config;
// Manual customer notes are app-owned + synced (config.customer_notes) — kept
// SEPARATE from Square's own `note` field, which the app does NOT write. This
// app-owned note is what the check-in popup shows. Notes are keyed by PHONE
// (normalized digits) so a Square customer-ID change (merge/recreate) can't
// orphan them; notePhoneKey() is the single canonical normalization.
export const notePhoneKey = phone => (phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
const isPhoneKey   = key => /^\d{7,15}$/.test(key);
export const customerNote = phone => ((cfg().customer_notes || {})[notePhoneKey(phone)] || '').trim();
// Compact note indicator for a customer card (turn board / floor tile / queue row): prefers the
// visit note, falls back to the permanent customer note; the tooltip carries both in full. Editing
// still happens by tapping the card (opens Assign & Price, which has both editors). '' when neither.
export function cardNotePreview(phone, txnNote, opts = {}) {
  const perm = customerNote(phone);
  const visit = (txnNote || '').trim();
  // visitOnly (tight floor tiles): show ONLY when THIS visit has a note, so the icon isn't
  // on every regular who has a permanent note — keeps it a meaningful "note for today" signal.
  const primary = opts.visitOnly ? visit : (visit || perm);
  if (!primary) return '';
  const full = [!opts.visitOnly && perm && 'Customer note: ' + perm, visit && 'Visit: ' + visit].filter(Boolean).join('  ·  ');
  if (opts.iconOnly) return `<span title="${escHtml(full)}" style="flex-shrink:0;font-size:${opts.fontSize || 10}px" aria-label="Has a note">📝</span>`;
  return `<div class="text-[10px] leading-tight text-on-surface-variant truncate mt-0.5" title="${escHtml(full)}">📝 ${escHtml(primary)}</div>`;
}

export let squareCustomers   = [];
export let customerDirectory = [];

// Unsaved-changes guard for the Edit Customer modal (3b): snapshot the fields when it opens,
// warn before discarding if they changed.
let _editCustSnapshot = '';
const _editCustSig = () => ['edit-cust-first','edit-cust-last','edit-cust-phone','edit-cust-email','edit-cust-notes'].map(id => (document.getElementById(id)?.value || '').trim()).join('');

// ── Directory source: the synced DO store (state.customers) ──────────────────
// The directory is now app-owned (a DO entity), not Square. We derive the two legacy
// shapes every reader already expects — customerDirectory ({squareId,firstName,...}) and
// squareCustomers ({id,given_name,...}) — from getState().customers, and rebuild them on
// every store change. Pre-import fallback: if the DO has no customers yet (right after the
// migration deploy, before "Import from Square" has run), use the last cached Square list so
// check-in autocomplete isn't empty; once the DO is seeded the store wins and we refresh the
// offline cache from it. The customer's `id` IS the directory's `squareId` field (kept for
// reader compatibility); a customer also carries a separate `squareId` link when known.
function _storeCustomers() {
  const fromStore = getState().customers || [];
  if (fromStore.length) return { list: fromStore, fromStore: true };
  try {
    const cached = JSON.parse(localStorage.getItem(scopedKey('turndesk_customers')) || '[]');
    return { list: cached.map(c => ({ id: c.squareId, firstName: c.firstName || '', lastName: c.lastName || '', phone: c.phone || '', email: c.email || '', squareId: c.squareId })), fromStore: false };
  } catch { return { list: [], fromStore: false }; }
}
function rebuildDirectory() {
  const { list, fromStore } = _storeCustomers();
  customerDirectory = list.map(c => ({ squareId: c.id, firstName: c.firstName || '', lastName: c.lastName || '', phone: c.phone || '', email: c.email || '', note: '', sqLink: c.squareId || null }));
  squareCustomers = list.filter(c => c.firstName).map(c => ({
    id: c.id, given_name: c.firstName || '', family_name: c.lastName || '',
    phone: c.phone || '', display: [c.firstName, c.lastName].filter(Boolean).join(' '),
  }));
  if (fromStore) { try { localStorage.setItem(scopedKey('turndesk_customers'), JSON.stringify(customerDirectory)); } catch (e) {} }
  window.renderCustomersTab?.();   // live-refresh the Customers tab if it's the open panel
}
rebuildDirectory();
subscribe(rebuildDirectory);   // keep the directory in lockstep with the synced store

// Fetch the full Square customer list (paginated) — used ONLY by the one-time import into the
// DO. Returns an array of {id,firstName,lastName,phone,email} (Square id), or null on a failed
// or partial pull (so the import never seeds from incomplete data).
export async function fetchSquareCustomers() {
  let all = [], cursor = null;
  try {
    do {
      const url = `${SQUARE_PROXY}/v2/customers?limit=100&sort_field=CREATED_AT&sort_order=DESC${cursor ? '&cursor=' + cursor : ''}`;
      const res = await fetch(url);
      if (!res.ok) { showToast('Square fetch failed (HTTP ' + res.status + ') — try again'); return null; }
      const data = await res.json();
      all = all.concat(data.customers || []);
      cursor = data.cursor || null;
    } while (cursor);
  } catch (e) { showToast('Could not reach Square'); return null; }
  return all
    .filter(c => c.given_name && c.given_name.trim() !== '-' && c.given_name.trim() !== '')
    .map(c => ({
      id: c.id, firstName: c.given_name?.trim() || '', lastName: (c.family_name || '').trim().replace(/^-$/, ''),
      phone: c.phone_number || '', email: c.email_address || '',
    }));
}

// One-time (re-runnable) import of the Square customer list into the DO customer store. Each
// customer becomes a DO entity keyed by its Square id (so re-running updates rather than dups);
// a customer already in the store (by id OR phone) is updated, not duplicated. Idempotent.
export async function importCustomersFromSquare() {
  if (!cfg().square_config) { showToast('Square not configured.'); return; }
  showToast('Fetching customers from Square…');
  const sq = await fetchSquareCustomers();
  if (!sq) return;                              // already toasted
  if (!sq.length) { showToast('No customers found in Square.'); return; }
  if (!confirm(`Import ${sq.length} customer${sq.length !== 1 ? 's' : ''} from Square into the app directory?\n\nSafe to run again later — existing customers are updated, not duplicated.`)) return;
  const have = getState().customers || [];
  const byId = new Set(have.map(c => String(c.id)));
  const byPhone = new Map(have.map(c => [notePhoneKey(c.phone), c]).filter(([k]) => k));
  let added = 0, updated = 0;
  const toUpsert = sq.map(c => {
    const pk = notePhoneKey(c.phone);
    const match = byId.has(String(c.id)) ? have.find(x => String(x.id) === String(c.id)) : (pk ? byPhone.get(pk) : null);
    if (match) updated++; else added++;
    return { id: match ? match.id : c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: c.email, squareId: c.id, createdAt: match?.createdAt || Date.now() };
  });
  // Send in BULK chunks with a yield between each — one apply (saveCache + re-render) per chunk
  // instead of per customer, so a big directory can't freeze the tab. Each chunk is also one
  // outbox entry + one WebSocket message + one DO mutation.
  const CHUNK = 200;
  for (let i = 0; i < toUpsert.length; i += CHUNK) {
    dispatch('customer.bulkUpsert', { customers: toUpsert.slice(i, i + CHUNK) });
    showToast(`Importing… ${Math.min(i + CHUNK, toUpsert.length)}/${toUpsert.length}`);
    await new Promise(r => setTimeout(r, 30));   // let the UI breathe + paint progress
  }
  showToast(`Imported from Square: ${added} added, ${updated} updated ✓`);
  window.logAudit?.('Customer import', `${added} added · ${updated} updated from Square`);
  window.renderCustomersTab?.();
}

export function filterCustomers(query, field) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase().replace(/\D/g, '');
  return squareCustomers.filter(c => {
    if (field === 'phone') {
      const phone = c.phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
      return phone.includes(q) && q.length >= 3;
    }
    if (field === 'first') {
      // Match on first name, last name, or the full "First Last" — phone stays the
      // identity key; this only widens what the name box autocompletes on.
      const ql = query.toLowerCase().trim();
      return c.given_name.toLowerCase().startsWith(ql)
        || (c.family_name || '').toLowerCase().startsWith(ql)
        || c.display.toLowerCase().includes(ql);
    }
    return false;
  }).slice(0, 6);
}

export function fillFromCustomer(customer, guestIdx, prefix, phoneId, firstId, lastId) {
  const phoneEl = document.getElementById(phoneId);
  const firstEl = document.getElementById(firstId);
  const lastEl  = document.getElementById(lastId);
  const digits = customer.phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1').slice(0, 10);
  const formatted = digits.length === 10 ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}` : customer.phone;
  if (phoneEl) phoneEl.value = formatted;
  if (firstEl) firstEl.value = customer.given_name;
  if (lastEl)  lastEl.value  = customer.family_name;
  dismissNumpad();   // a pick already set the phone — close the floating numpad without clobbering it
  [`ac-phone-${guestIdx}`, `ac-first-${guestIdx}`, `mac-phone-${guestIdx}`, `mac-first-${guestIdx}`].forEach(id => {
    const el = document.getElementById(id); if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
  });
  // On a DASHBOARD check-in (manual-add uses `manual-*` field ids) — NOT the
  // customer-facing check-in screen — open the note editor for a returning
  // customer chosen from autofill, so the front desk can read AND add/update a
  // note in the moment (pre-filled with any existing note).
  if (/^manual-/.test(firstId || '') && customer.phone) {
    showCustomerNote(customer.phone, [customer.given_name, customer.family_name].filter(Boolean).join(' '), customerNote(customer.phone));
  } else if (/^first-\d+$/.test(firstId || '') && customer.phone) {
    // Customer-facing KIOSK check-in: reveal the per-guest "customer note (kept on file)"
    // textarea, pre-filled with this returning customer's saved note (phone-keyed).
    fillCiCustNote(guestIdx, customer.phone);
  }
}
// Customer note lives as a SIDE PANEL beside the dashboard check-in (#manual-note-panel),
// not a screen-covering modal: it opens when a returning customer is picked, auto-saves
// as you type, the Save button saves without closing the check-in, and it closes (after
// flushing) when the check-in window closes.
let _notePhoneKey = null, _noteSaveTimer = null;
export function showCustomerNote(phone, name, note) {
  const nameEl = document.getElementById('customer-note-name');
  const editEl = document.getElementById('customer-note-edit');
  const panel = document.getElementById('manual-note-panel');
  if (!panel || !editEl) return;
  _notePhoneKey = notePhoneKey(phone) || null;
  if (nameEl) nameEl.textContent = name || '';
  editEl.value = note || '';
  panel.classList.remove('hidden');
  window.renderCustomerHistory?.(phone, name, 'ci-history');
}
function _persistCustomerNote() {
  if (!_notePhoneKey) return;
  const editEl = document.getElementById('customer-note-edit'); if (!editEl) return;
  const val = editEl.value.trim();
  const notes = { ...(cfg().customer_notes || {}) };
  if (val) notes[_notePhoneKey] = val; else delete notes[_notePhoneKey];
  dispatch('config.set', { key: 'customer_notes', value: notes });
}
// Auto-save shortly after typing stops (debounced — no dispatch per keystroke).
export function autoSaveCustomerNote() { clearTimeout(_noteSaveTimer); _noteSaveTimer = setTimeout(_persistCustomerNote, 600); }
// "Save note" button — save now, but DON'T close the check-in window.
export function saveCustomerNoteInline() { clearTimeout(_noteSaveTimer); _persistCustomerNote(); showToast('Note saved'); }
// Called when the check-in (manual-add) modal closes: flush any pending edit, then hide.
export function closeCustomerNote() {
  clearTimeout(_noteSaveTimer); _persistCustomerNote();
  const panel = document.getElementById('manual-note-panel'); if (panel) panel.classList.add('hidden');
  _notePhoneKey = null;
}

// ── Kiosk per-guest "customer note (kept on file)" ────────────────────────────
// The customer-facing kiosk has no side panel, so the persistent customer note lives inline in
// each guest card (#ci-cust-note-wrap-<idx>). Shown + pre-filled when a returning customer is
// picked; auto-saved (debounced) to config.customer_notes keyed by the live phone field.
const _ciNoteTimers = {};
export function fillCiCustNote(idx, phone) {
  const wrap = document.getElementById('ci-cust-note-wrap-' + idx);
  const ta = document.getElementById('ci-cust-note-' + idx);
  if (!wrap || !ta) return;
  ta.value = customerNote(phone);
  ta.dataset.phoneKey = notePhoneKey(phone) || '';
  wrap.classList.remove('hidden');
}
function _persistCiCustNote(idx) {
  const ta = document.getElementById('ci-cust-note-' + idx); if (!ta) return;
  // Prefer the live phone field (it may have been edited after the autofill pick).
  const key = notePhoneKey(document.getElementById('phone-' + idx)?.value || '') || ta.dataset.phoneKey || '';
  if (!key) return;
  const val = ta.value.trim();
  const notes = { ...(cfg().customer_notes || {}) };
  if (val) notes[key] = val; else delete notes[key];
  dispatch('config.set', { key: 'customer_notes', value: notes });
}
export function ciCustNoteInput(idx) { clearTimeout(_ciNoteTimers[idx]); _ciNoteTimers[idx] = setTimeout(() => _persistCiCustNote(idx), 600); }
export function flushCiCustNote(idx) { clearTimeout(_ciNoteTimers[idx]); _persistCiCustNote(idx); }

export function buildDropdown(customers, dropdownId, guestIdx, phoneId, firstId, lastId, maskPhone = false) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;
  if (customers.length === 0) { dropdown.classList.add('hidden'); return; }
  dropdown.innerHTML = customers.map((c, i) => {
    const digits = c.phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1').slice(0, 10);
    // Check-in kiosk only (maskPhone): hide all but the last 4 digits so a customer typing at
    // the front desk can't read other customers' full numbers in the suggestion list. The full
    // number still fills the form on select (fillFromCustomer receives c.phone unchanged).
    let displayPhone = digits.length === 10 ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}` : c.phone;
    if (maskPhone && digits.length >= 4) displayPhone = `(***) ***-${digits.slice(-4)}`;
    return `
    <div class="autocomplete-item" data-ac-idx="${i}" onmousedown="fillFromCustomer(
      {id:'${escAttrJs(c.id)}',phone:'${escAttrJs(c.phone)}',given_name:'${escAttrJs(c.given_name)}',family_name:'${escAttrJs(c.family_name)}'},
      ${guestIdx}, '', '${phoneId}', '${firstId}', '${lastId}'
    )">
      <div class="ac-name">${escHtml(c.display) || '—'}</div>
      <div class="ac-phone">${escHtml(displayPhone) || 'No phone'}</div>
    </div>`;
  }).join('');
  dropdown.classList.remove('hidden');
  const input = document.getElementById(phoneId) || document.getElementById(firstId);
  if (input) {
    // Open the list upward when the anchor sits low in the viewport, so its lowest rows
    // aren't clipped by the check-in kiosk's scroll container / fixed footer. Both edges
    // are rewritten every show so the direction never sticks from a prior render.
    const r = input.getBoundingClientRect();
    const needed = Math.min(dropdown.scrollHeight, 220) + 4 + 120;   // list height + gap + footer clearance
    const up = (window.innerHeight - r.bottom) < needed;
    dropdown.style.top = up ? 'auto' : 'calc(100% + 4px)';
    dropdown.style.bottom = up ? 'calc(100% + 4px)' : 'auto';
    _attachAcKeyNav(input, dropdown, idx => fillFromCustomer(
      { id: customers[idx].id, phone: customers[idx].phone, given_name: customers[idx].given_name, family_name: customers[idx].family_name },
      guestIdx, '', phoneId, firstId, lastId));
  }
}

function _attachAcKeyNav(input, dropdown, onSelect) {
  let activeIdx = -1;
  function highlight(idx) { dropdown.querySelectorAll('.autocomplete-item').forEach((el, i) => el.classList.toggle('ac-highlighted', i === idx)); activeIdx = idx; }
  function handler(e) {
    if (dropdown.classList.contains('hidden')) { input.removeEventListener('keydown', handler); return; }
    const items = dropdown.querySelectorAll('.autocomplete-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(activeIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); e.stopPropagation(); onSelect(activeIdx); input.removeEventListener('keydown', handler); }
    else if (e.key === 'Escape') { dropdown.classList.add('hidden'); input.removeEventListener('keydown', handler); }
  }
  input._acKeyHandler && input.removeEventListener('keydown', input._acKeyHandler);
  input._acKeyHandler = handler;
  input.addEventListener('keydown', handler);
}
export { _attachAcKeyNav };

// Customer-facing + front-desk autocomplete entry points (inline oninput).
export function acSearch(input, idx, field) {
  if (field === 'phone') formatPhone(input);
  const results = filterCustomers(input.value, field);
  const dropId = field === 'phone' ? `ac-phone-${idx}` : `ac-first-${idx}`;
  buildDropdown(results, dropId, idx, `phone-${idx}`, `first-${idx}`, `last-${idx}`, true);   // check-in screen: mask phones in the suggestion list
  const other = document.getElementById(field === 'phone' ? `ac-first-${idx}` : `ac-phone-${idx}`);
  if (other) { other.innerHTML = ''; other.classList.add('hidden'); }
}
export function acSearchManual(input, idx, field) {
  if (field === 'phone') formatPhone(input);
  const results = filterCustomers(input.value, field);
  const dropId = field === 'phone' ? `mac-phone-${idx}` : `mac-first-${idx}`;
  buildDropdown(results, dropId, idx, `manual-phone-${idx}`, `manual-first-${idx}`, `manual-last-${idx}`);
  const other = document.getElementById(field === 'phone' ? `mac-first-${idx}` : `mac-phone-${idx}`);
  if (other) { other.innerHTML = ''; other.classList.add('hidden'); }
}
// Add Historical modal autocomplete — a single full-name field + phone (no first/last split),
// so it can't reuse buildDropdown's first/last fill. Reuses filterCustomers; fills hist-name
// (full display) + hist-phone on pick. The global outside-click handler (utils.js) closes it.
export function histAcSearch(input, field) {
  if (field === 'phone') formatPhone(input);
  const results = filterCustomers(input.value, field);
  const drop = document.getElementById(field === 'phone' ? 'hist-ac-phone' : 'hist-ac-name');
  const other = document.getElementById(field === 'phone' ? 'hist-ac-name' : 'hist-ac-phone');
  if (other) { other.innerHTML = ''; other.classList.add('hidden'); }
  if (!drop) return;
  if (!results.length) { drop.innerHTML = ''; drop.classList.add('hidden'); return; }
  drop.innerHTML = results.map(c => {
    const d = (c.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1').slice(0, 10);
    const ph = d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (c.phone || '');
    return `<div class="autocomplete-item" onmousedown="fillHistCustomer('${escAttrJs(c.display || '')}','${escAttrJs(c.phone || '')}')">
      <div class="ac-name">${escHtml(c.display) || '—'}</div><div class="ac-phone">${escHtml(ph) || 'No phone'}</div></div>`;
  }).join('');
  drop.classList.remove('hidden');
}
export function fillHistCustomer(name, phone) {
  const n = document.getElementById('hist-name'); if (n) n.value = name;
  const p = document.getElementById('hist-phone');
  if (p) { const d = (phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1').slice(0, 10); p.value = d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (phone || ''); }
  ['hist-ac-name', 'hist-ac-phone'].forEach(id => { const el = document.getElementById(id); if (el) { el.innerHTML = ''; el.classList.add('hidden'); } });
}

// ── Customers tab (dedicated panel; replaces the old directory modal) ─────────
// Back-compat shims: the Settings "Customer Directory" leaf + main.js closeAllModals
// still reference these names. showCustomerDir now just navigates to the tab.
export function showCustomerDir() { window.showDashPanel?.('customers'); }
export function closeCustomerDir() {}   // no-op: the modal is gone (kept so closeAllModals is safe)
export function syncSquareCustomers() { importCustomersFromSquare(); }   // legacy name → the one-time import

// Per-customer lifetime stats (visits / last visit / total spent), derived from transaction
// records in ONE pass and keyed by phone (records link to customers by phone).
function _custStatsByPhone() {
  const m = new Map();
  (getState().records || []).forEach(r => {
    if (r.status === 'deleted') return;
    const pk = notePhoneKey(r.phone);
    if (!pk) return;
    let s = m.get(pk); if (!s) { s = { visits: 0, last: 0, spent: 0 }; m.set(pk, s); }
    s.visits++;
    const t = new Date(r.checkinTime || r.completedAt || 0).getTime(); if (t > s.last) s.last = t;
    const amt = Number(r.totalCost) || 0; if (r.status !== 'refund' && amt > 0) s.spent += amt;
  });
  return m;
}

const CUST_PAGE_SIZE = 200;
let _custPage = 0;

// Display-only phone formatter: a standard US 10-digit number (or 11 with a leading 1) renders as
// "(555) 123-4567"; anything non-standard shows as-is. Stored data is NOT changed — only display.
function _fmtPhoneDisplay(p) {
  const d = (p || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '—');
}

export function filterCustomersTab(query) { _custPage = 0; renderCustomersTab(query); }   // new search → back to page 1
export function renderCustomerDir(query) { _custPage = 0; renderCustomersTab(query); }     // legacy alias (cleanup back-button, saveEditCustomer)
export function custPage(delta) { _custPage += delta; renderCustomersTab(); }              // pager Prev/Next (clamped in render)

export function renderCustomersTab(query) {
  const host = document.getElementById('customers-content');
  if (!host) return;   // tab not open
  // query==null → a background re-render (store sync): keep the live search box + current page.
  const q = (query == null ? (document.getElementById('customers-search')?.value || '') : query).trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const total = customerDirectory.length;
  if (total === 0) {
    host.innerHTML = `<div class="text-center py-16 text-on-surface-variant font-body">
      <span class="material-symbols-outlined" style="font-size:48px;opacity:.4">contacts</span>
      <div class="mt-3 text-lg font-headline font-bold text-on-surface">No customers yet</div>
      <div class="text-sm mt-1">Tap <b>Import from Square</b> to bring in your existing customers, or <b>Add Customer</b> to start one.</div></div>`;
    return;
  }
  const stats = _custStatsByPhone();
  const sorted = [...customerDirectory].sort((a, b) => ([a.firstName, a.lastName].join(' ')).localeCompare([b.firstName, b.lastName].join(' ')));
  const filtered = sorted.filter(c => {
    if (!q) return true;
    if (([c.firstName, c.lastName].join(' ')).toLowerCase().includes(q)) return true;
    if ((c.email || '').toLowerCase().includes(q)) return true;
    if (qDigits && (c.phone || '').replace(/\D/g, '').includes(qDigits)) return true;
    return false;
  });
  // Paginate at 200/page. Clamp the page so a shrinking list (e.g. after a delete) never lands
  // on an empty page; flipping pages walks the full alphabetical list A→Z.
  const pages = Math.max(1, Math.ceil(filtered.length / CUST_PAGE_SIZE));
  _custPage = Math.min(Math.max(_custPage, 0), pages - 1);
  const start = _custPage * CUST_PAGE_SIZE;
  const pageRows = filtered.slice(start, start + CUST_PAGE_SIZE);
  const rows = pageRows.map(c => {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown';
    const s = stats.get(notePhoneKey(c.phone)) || { visits: 0, last: 0, spent: 0 };
    const last = s.last ? new Date(s.last).toLocaleDateString() : '—';
    return `<tr onclick="showEditCustomer('${escAttrJs(c.squareId)}')" class="cursor-pointer hover:bg-surface-container transition-colors">
      <td class="font-headline font-semibold text-on-surface">${escHtml(name)}</td>
      <td>${escHtml(_fmtPhoneDisplay(c.phone))}</td>
      <td class="text-on-surface-variant">${escHtml(c.email || '—')}</td>
      <td class="text-right">${s.visits || '—'}</td>
      <td>${last}</td>
      <td class="text-right">${s.spent ? '$' + s.spent.toFixed(0) : '—'}</td>
    </tr>`;
  }).join('');
  const from = filtered.length ? start + 1 : 0, to = start + pageRows.length;
  const btn = (label, delta, disabled) => `<button onclick="custPage(${delta})" ${disabled ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg border border-surface-container-high text-sm font-body font-semibold disabled:opacity-40 disabled:cursor-default hover:bg-surface-container transition-colors">${label}</button>`;
  const pager = pages > 1 ? `<div class="flex items-center justify-center gap-3 mt-3">
      ${btn('‹ Prev', -1, _custPage === 0)}
      <span class="text-sm font-body text-on-surface-variant">Page ${_custPage + 1} of ${pages}</span>
      ${btn('Next ›', 1, _custPage >= pages - 1)}
    </div>` : '';
  host.innerHTML = `
    <div class="text-[11px] font-body text-on-surface-variant mb-2">Showing ${from}–${to} of ${filtered.length} customer${filtered.length !== 1 ? 's' : ''}${q ? ' (filtered)' : ''}</div>
    <div class="overflow-auto max-h-[calc(100vh-240px)]"><table class="data-table w-full text-sm">
      <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="text-right">Visits</th><th>Last visit</th><th class="text-right">Total</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="text-center py-6 text-on-surface-variant">No matches.</td></tr>'}</tbody>
    </table></div>
    ${pager}`;
}

// New blank-customer entry — opens the shared edit modal in "add" mode (no id).
export function showAddCustomer() {
  ['edit-cust-id', 'edit-cust-square-id', 'edit-cust-first', 'edit-cust-last', 'edit-cust-phone', 'edit-cust-email', 'edit-cust-notes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const t = document.getElementById('edit-customer-title'); if (t) t.textContent = 'Add Customer';
  const hist = document.getElementById('edit-cust-history'); if (hist) hist.innerHTML = '<div class="text-xs text-on-surface-variant py-2">No visits yet.</div>';
  const del = document.getElementById('edit-cust-delete-btn'); if (del) del.classList.add('hidden');
  _editCustSnapshot = _editCustSig();
  const m = document.getElementById('edit-customer-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}

// Export the full directory to CSV (UTF-8 BOM + CRLF so Excel opens it cleanly).
export function exportCustomersCSV() {
  const rows = [['First', 'Last', 'Phone', 'Email', 'Note']];
  customerDirectory.forEach(c => rows.push([c.firstName || '', c.lastName || '', c.phone || '', c.email || '', (customerNote(c.phone) || '').replace(/[\r\n]+/g, ' ')]));
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = 'muse-customers.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${customerDirectory.length} customers`);
}

// ── Customer cleanup / dedup ────────────────────────────────────────────────────
const _custPhoneKey = c => (c.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
const _custNameKey  = c => [c.firstName, c.lastName].filter(Boolean).join(' ').trim().toLowerCase().replace(/\s+/g, ' ');
// Pure: group directory customers into review sets — profiles sharing a phone, and profiles
// sharing an identical name. Only sets with 2+ members are returned (sorted largest first).
// Notes/visit history are phone-keyed app-side, so merging by deleting extra profiles loses nothing.
export function findDuplicateGroups(directory) {
  const group = keyFn => {
    const m = new Map();
    (directory || []).forEach(c => { const k = keyFn(c); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(c); });
    return [...m.entries()].filter(([, a]) => a.length > 1).map(([key, customers]) => ({ key, customers }))
      .sort((a, b) => b.customers.length - a.customers.length);
  };
  return { byPhone: group(_custPhoneKey), byName: group(_custNameKey) };
}
// Delete a customer from the app directory (the DO is the source of truth). Best-effort also
// removes the linked Square profile (kept until Helcim). `id` is the DO customer id.
export async function deleteSquareCustomer(id) {
  if (!id) return false;
  const c = customerDirectory.find(x => x.squareId === id);
  dispatch('customer.delete', { id });          // authoritative removal (the rebuild drops it from the caches)
  const sqId = c?.sqLink;
  if (sqId && cfg().square_config) {
    try { await fetch(`${SQUARE_PROXY}/v2/customers/${sqId}`, { method: 'DELETE' }); } catch (e) {}
  }
  return true;
}
// Merge = keep one profile, delete the rest. (Square has no merge API; notes/history are phone-keyed
// so the surviving profile keeps everything.) Returns the count successfully removed.
export async function mergeCustomers(keepId, removeIds) {
  let removed = 0;
  for (const id of (removeIds || [])) { if (id && id !== keepId && await deleteSquareCustomer(id)) removed++; }
  return removed;
}

// ── Cleanup UI (rendered into the directory modal's list) ───────────────────────
const _cEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _cName = c => _cEsc([c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)');
// Which cleanup criteria sections are expanded (device-local UI state).
const _cleanupOpen = { phone: true, name: true, nophone: false };
export function cleanupToggleSection(key) {
  if (key in _cleanupOpen) _cleanupOpen[key] = !_cleanupOpen[key];
  renderCustomerCleanup();
}
export function openCustomerCleanup() { renderCustomerCleanup(); }
export function renderCustomerCleanup() {
  const list = document.getElementById('customers-content'); if (!list) return;
  const { byPhone, byName } = findDuplicateGroups(customerDirectory);
  const noPhone = customerDirectory.filter(c => !_custPhoneKey(c));
  const memberRow = (c, ids) => `<div class="flex items-center justify-between gap-2 px-3 py-2 border-t border-surface-container first:border-t-0">
      <button type="button" onclick="showEditCustomer('${c.squareId}')" title="Open profile — notes, visits, edit" class="min-w-0 text-left group"><div class="text-sm font-body font-semibold text-on-surface truncate group-hover:text-primary">${_cName(c)}</div><div class="text-[11px] text-on-surface-variant truncate">${_cEsc(c.phone || 'no phone')}${c.email ? ' · ' + _cEsc(c.email) : ''}</div></button>
      <span class="flex gap-1.5 flex-shrink-0 items-center">
        <button onclick="cleanupMergeGroup('${c.squareId}','${ids}')" class="text-[11px] font-body font-bold text-on-primary bg-primary rounded-lg px-2.5 py-1">Keep, merge rest</button>
        <button onclick="cleanupDeleteCustomer('${c.squareId}')" title="Delete just this one" class="text-on-surface-variant hover:text-error flex items-center"><span class="material-symbols-outlined" style="font-size:18px">delete</span></button>
      </span></div>`;
  const groupCard = g => { const ids = g.customers.map(c => c.squareId).join(','); return `<div class="rounded-xl border border-surface-container-high mb-2 overflow-hidden"><div class="px-3 py-1.5 bg-surface-container text-[11px] font-body font-semibold text-on-surface-variant">${_cEsc(g.key)} · ${g.customers.length} profiles</div>${g.customers.map(c => memberRow(c, ids)).join('')}</div>`; };
  const section = (key, title, hint, html, n) => {
    const open = _cleanupOpen[key];
    return `<div class="mt-3 border-t border-surface-container-high pt-2">
      <button onclick="cleanupToggleSection('${key}')" class="w-full flex items-center justify-between gap-2 py-1 text-left">
        <span class="text-xs font-headline font-bold text-on-surface uppercase tracking-widest">${title} <span class="text-on-surface-variant">(${n})</span></span>
        <span class="material-symbols-outlined text-on-surface-variant" style="font-size:22px">${open ? 'expand_less' : 'expand_more'}</span>
      </button>
      ${open ? `<div class="text-[11px] text-on-surface-variant mb-2 mt-1">${hint}</div>${html || '<div class="text-xs text-on-surface-variant italic py-1">None. ✓</div>'}` : ''}</div>`;
  };
  const noPhoneBtn = noPhone.length ? `<button onclick="cleanupDeleteAllNoPhone()" class="mb-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error/10 text-error text-xs font-body font-bold hover:bg-error/20 transition-colors"><span class="material-symbols-outlined" style="font-size:16px">delete_sweep</span> Delete all ${noPhone.length} no-phone customer${noPhone.length !== 1 ? 's' : ''}</button>` : '';
  const noPhoneHtml = noPhoneBtn + noPhone.slice(0, 300).map(c => `<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-surface-container-high mb-1"><button type="button" onclick="showEditCustomer('${c.squareId}')" title="Open profile — notes, visits, edit" class="min-w-0 text-left group"><div class="text-sm font-body font-semibold text-on-surface truncate group-hover:text-primary">${_cName(c)}</div><div class="text-[11px] text-on-surface-variant truncate">no phone${c.email ? ' · ' + _cEsc(c.email) : ''}</div></button><button onclick="cleanupDeleteCustomer('${c.squareId}')" title="Delete" class="text-on-surface-variant hover:text-error flex items-center flex-shrink-0"><span class="material-symbols-outlined" style="font-size:18px">delete</span></button></div>`).join('');
  list.innerHTML = `
    <div class="flex items-center justify-between mb-2"><button onclick="renderCustomerDir('')" class="flex items-center gap-1 text-sm font-body font-semibold text-primary"><span class="material-symbols-outlined" style="font-size:18px">arrow_back</span> All customers</button><span class="text-[11px] text-on-surface-variant">${customerDirectory.length} total</span></div>
    ${section('phone', 'Same phone', 'Profiles sharing a phone — usually one person (or family on one number). Tap "Keep, merge rest" on the right profile; the others are deleted (notes &amp; history stay, since they’re phone-keyed).', byPhone.map(groupCard).join(''), byPhone.length)}
    ${section('name', 'Same name', 'Identical name — could be the same person twice, or two different people. Review before merging.', byName.map(groupCard).join(''), byName.length)}
    ${section('nophone', 'No phone', 'No phone on file. Delete placeholder/junk entries — or clear them all with one tap.', noPhoneHtml, noPhone.length)}`;
}
export async function cleanupMergeGroup(keepId, idsCsv) {
  const ids = (idsCsv || '').split(',').filter(Boolean);
  const removeIds = ids.filter(id => id !== keepId);
  if (!removeIds.length) return;
  const keep = customerDirectory.find(c => c.squareId === keepId);
  const keepName = keep ? ([keep.firstName, keep.lastName].filter(Boolean).join(' ') || 'this customer') : 'this customer';
  if (!confirm(`Keep "${keepName}" and delete the other ${removeIds.length} profile${removeIds.length !== 1 ? 's' : ''} from the directory?\n\nNotes & visit history are phone-keyed, so they stay with the kept profile. Past sales are not deleted.`)) return;
  showToast('Merging…');
  const n = await mergeCustomers(keepId, removeIds);
  showToast(`Merged — removed ${n} duplicate${n !== 1 ? 's' : ''}`);
  window.logAudit?.('Customer merge', `kept ${keepName}, removed ${n}`);
  renderCustomerCleanup();
}
export async function cleanupDeleteCustomer(id) {
  const c = customerDirectory.find(x => x.squareId === id);
  const nm = c ? ([c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)') : 'this customer';
  if (!confirm(`Delete "${nm}" from the directory? Past sales are not deleted — the profile is just removed.`)) return;
  if (await deleteSquareCustomer(id)) { showToast('Customer deleted'); window.logAudit?.('Customer delete', nm); renderCustomerCleanup(); }
}
// Bulk-delete every customer with no phone number on file (placeholder/junk). Uses the bulk op
// (one apply per chunk) so a large set can't freeze the tab; best-effort Square cleanup runs in
// the background. Past sales are unaffected (records aren't deleted).
export async function cleanupDeleteAllNoPhone() {
  const noPhone = customerDirectory.filter(c => !_custPhoneKey(c));
  if (!noPhone.length) { showToast('No no-phone customers to delete.'); return; }
  if (!confirm(`Delete all ${noPhone.length} customer${noPhone.length !== 1 ? 's' : ''} with no phone number?\n\nThis can't be undone. Past sales are not affected.`)) return;
  const ids = noPhone.map(c => c.squareId);
  const sqLinks = noPhone.map(c => c.sqLink).filter(Boolean);
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    dispatch('customer.bulkDelete', { ids: ids.slice(i, i + CHUNK) });
    await new Promise(r => setTimeout(r, 20));
  }
  showToast(`Deleted ${ids.length} no-phone customer${ids.length !== 1 ? 's' : ''}`);
  window.logAudit?.('Customer cleanup', `deleted ${ids.length} no-phone`);
  // Best-effort Square cleanup (kept until Helcim) — fire-and-forget so it never blocks the UI.
  if (cfg().square_config && sqLinks.length) {
    (async () => { for (const sid of sqLinks) { try { await fetch(`${SQUARE_PROXY}/v2/customers/${sid}`, { method: 'DELETE' }); } catch (e) {} } })();
  }
  renderCustomerCleanup();
}

export function showEditCustomer(id) {
  const c = customerDirectory.find(x => x.squareId === id);   // .squareId here = the DO customer id
  if (!c) return;
  document.getElementById('edit-cust-id').value        = c.squareId;     // DO id
  document.getElementById('edit-cust-square-id').value = c.sqLink || '';  // linked Square id (for the dual-write)
  document.getElementById('edit-cust-first').value     = c.firstName;
  document.getElementById('edit-cust-last').value      = c.lastName;
  document.getElementById('edit-cust-phone').value     = c.phone;
  document.getElementById('edit-cust-email').value     = c.email;
  document.getElementById('edit-cust-notes').value     = customerNote(c.phone);   // app-owned manual note, keyed by phone
  const t = document.getElementById('edit-customer-title'); if (t) t.textContent = 'Edit Customer';
  const del = document.getElementById('edit-cust-delete-btn'); if (del) del.classList.remove('hidden');
  // Local visit history (derived from transaction records) — kept in reports.js to avoid
  // a circular import; safe no-op if reports hasn't loaded.
  window.renderCustomerHistory?.(c.phone, [c.firstName, c.lastName].filter(Boolean).join(' '));
  _editCustSnapshot = _editCustSig();   // baseline for the unsaved-changes guard
  const m = document.getElementById('edit-customer-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}
export async function deleteCustomerFromEdit() {
  const id = document.getElementById('edit-cust-id').value;
  if (!id) return;
  const c = customerDirectory.find(x => x.squareId === id);
  const nm = c ? ([c.firstName, c.lastName].filter(Boolean).join(' ') || 'this customer') : 'this customer';
  if (!confirm(`Delete "${nm}"? Removes them from the directory. Past sales are not affected.`)) return;
  await deleteSquareCustomer(id);
  window.logAudit?.('Customer delete', nm);
  showToast('Customer deleted');
  closeEditCustomer(true);
  renderCustomersTab();
}
export function closeEditCustomer(force) {
  // Warn before discarding unsaved edits (incl. the note). `force === true` skips it — used by
  // Save (already persisted). Esc / backdrop tap / the X button all route through here.
  if (force !== true && _editCustSig() !== _editCustSnapshot) {
    window.showWarnModal?.('Discard unsaved changes?', "Your edits to this customer (including the note) haven't been saved. Discard them?", () => closeEditCustomer(true));
    return;
  }
  _editCustSnapshot = '';
  const m = document.getElementById('edit-customer-modal');
  m.classList.add('hidden'); m.style.display = '';
}

export async function saveEditCustomer() {
  const id0    = document.getElementById('edit-cust-id').value;            // DO id ('' = adding)
  const sqLink0 = document.getElementById('edit-cust-square-id').value || null;
  const first = document.getElementById('edit-cust-first').value.trim();
  const last  = document.getElementById('edit-cust-last').value.trim();
  const phone = document.getElementById('edit-cust-phone').value.trim();
  const email = document.getElementById('edit-cust-email').value.trim();
  const note  = document.getElementById('edit-cust-notes').value.trim();
  if (!first) { showToast('First name is required.'); return; }

  const existing = id0 ? (getState().customers || []).find(c => String(c.id) === String(id0)) : null;
  const id = id0 || ('cust-' + (notePhoneKey(phone) || (Date.now() + '-' + Math.floor(Math.random() * 1e4))));

  // Square dual-write (kept until Helcim): PUT the linked profile, else create one and capture
  // the link. Best-effort — the DO write below is the source of truth and always happens.
  let sqLink = sqLink0 || existing?.squareId || null;
  if (cfg().square_config && phone) {
    try {
      if (sqLink) {
        await fetch(`${SQUARE_PROXY}/v2/customers/${sqLink}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ given_name: first, family_name: last, phone_number: phone, email_address: email }) });
      } else {
        const r = await fetch(`${SQUARE_PROXY}/v2/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: 'muse-cust-' + id, given_name: first, family_name: last, phone_number: phone, email_address: email }) });
        if (r.ok) sqLink = (await r.json())?.customer?.id || null;
      }
    } catch (e) { /* best-effort; DO is the source of truth */ }
  }

  dispatch('customer.upsert', { customer: { id, firstName: first, lastName: last, phone, email, squareId: sqLink, createdAt: existing?.createdAt || Date.now() } });

  // Manual note → app-owned synced store, keyed by phone (kept out of Square's note).
  const phoneKey = notePhoneKey(phone);
  if (phoneKey) {
    const notes = { ...(cfg().customer_notes || {}) };
    if (note) notes[phoneKey] = note; else delete notes[phoneKey];
    dispatch('config.set', { key: 'customer_notes', value: notes });
  } else if (note) {
    showToast('Add a phone number to save a note');
  }

  // Keep matching queue entries' display name in sync (match by phone).
  const fullName = last ? `${first} ${last}` : first;
  getState().queue.forEach(e => {
    if (e.phone && phone && e.phone.replace(/\D/g, '').endsWith(phone.replace(/\D/g, ''))) {
      dispatch('queue.upsert', { entry: { ...e, name: fullName } });
    }
  });
  window.renderQueue?.(); window.renderTurns?.();

  window.logAudit?.('Customer ' + (existing ? 'edit' : 'add'), `${fullName || '—'}${phone ? ' · ' + phone : ''}`);
  showToast(existing ? 'Customer updated ✓' : 'Customer added ✓');
  closeEditCustomer(true);   // already saved — skip the unsaved-changes guard
  renderCustomersTab();
}

export async function squarePullStaff() {
  if (!cfg().square_config) { showToast('Square not configured.'); return; }
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/team-members/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { filter: { status: 'ACTIVE' } }, limit: 200 }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const e = await res.json(); detail = e.errors?.[0]?.detail || e.errors?.[0]?.category || detail; } catch {}
      showToast(`Square team members: ${detail}`); return;
    }
    const members = (await res.json()).team_members || [];
    const staff = [...cfg().staff];
    let added = 0;
    members.forEach(m => {
      const name = [m.given_name, m.family_name].filter(Boolean).join(' ');
      if (!name) return;
      const id = `sq-staff-${m.id}`;
      if (!staff.find(s => s.id === id || s.name.toLowerCase() === name.toLowerCase())) {
        staff.push({ id, name, commission: null, squareTeamMemberId: m.id });
        added++;
      }
    });
    if (added > 0) { dispatch('config.set', { key: 'staff', value: staff }); window.renderStaffList?.(); showToast(`${added} staff imported from Square`); }
    else showToast('Staff already up to date');
  } catch (e) { showToast('Could not sync staff from Square'); }
}

// Creates/updates a Square customer on check-in (requires a phone number).
// Returns the Square customer id (existing or newly created), or null when there's nothing to
// link (no name / no phone / Square not reachable). The pay flow uses the returned id to attach
// the sale to the customer in Square (customer_id on the checkout + payment).
// On a GROUP check-in, party guests often share ONE phone (e.g. a mom's number entered for her
// daughter too). Upserting each member would repeatedly update the SAME Square profile, so its
// name flip-flops between the party members (the "Patti → Patti Daughter", "Abby 1" mess). Upsert
// only the FIRST member per distinct phone, so a shared phone yields one stable customer.
export function upsertPartyCustomers(entries) {
  const seen = new Set();
  (entries || []).forEach(e => {
    if (e.skipSquare) return;
    const key = (e.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
    if (key) { if (seen.has(key)) return; seen.add(key); }
    squareUpsertCustomer(e);
  });
}

// Ensure this entry's customer exists in the app's DO directory (found by phone; created if new).
// The DO is the source of truth. Avoids flip-flopping the name on a shared phone (upsertPartyCustomers
// already dedups by phone). When the linked Square id becomes known, attaches it. Returns the DO id.
export function ensureCustomerInStore(entry, squareLink, opts = {}) {
  if (!entry || !entry.name || entry.name.trim() === '-') return null;
  const pk = notePhoneKey(entry.phone);
  if (!pk) return null;   // no phone → can't key reliably (Square also skips these)
  const parts = entry.name.trim().split(/\s+/);
  const firstName = parts[0] || '', lastName = parts.slice(1).join(' ') || '';
  const existing = (getState().customers || []).find(c => notePhoneKey(c.phone) === pk);
  if (existing) {
    // No name churn by default (shared phones). opts.updateName = an explicit, confirmed
    // correction → write the new name (and email) onto the stored record.
    const patch = {};
    if (squareLink && existing.squareId !== squareLink) patch.squareId = squareLink;
    if (opts.updateName) {
      if (firstName && firstName !== existing.firstName) patch.firstName = firstName;
      if (lastName !== (existing.lastName || '')) patch.lastName = lastName;
      const email = (entry.email || '').trim();
      if (email && email !== (existing.email || '')) patch.email = email;
    }
    if (Object.keys(patch).length) dispatch('customer.upsert', { customer: { ...existing, ...patch } });
    return existing.id;
  }
  const id = 'cust-' + pk;
  dispatch('customer.upsert', { customer: { id, firstName, lastName, phone: entry.phone, email: (entry.email || '').trim(), squareId: squareLink || null, createdAt: Date.now() } });
  return id;
}

// For the check-in "Update saved info?" prompt: when this entry's phone already
// matches a saved customer whose name/email DIFFERS, return the before/after so the
// caller can confirm before changing the directory. Returns null when there's no
// saved match (a new customer) or nothing changed (no prompt needed).
export function customerNeedsUpdate(entry) {
  if (!entry || !entry.name || entry.name.trim() === '-') return null;
  const pk = notePhoneKey(entry.phone);
  if (!pk) return null;
  const existing = (getState().customers || []).find(c => notePhoneKey(c.phone) === pk);
  if (!existing) return null;
  const parts = entry.name.trim().split(/\s+/);
  const firstName = parts[0] || '', lastName = parts.slice(1).join(' ') || '';
  const email = (entry.email || '').trim();
  const nameDiff = (firstName && firstName !== existing.firstName) || lastName !== (existing.lastName || '');
  const emailDiff = email && email !== (existing.email || '');
  if (!nameDiff && !emailDiff) return null;
  return {
    existing,
    oldName: [existing.firstName, existing.lastName].filter(Boolean).join(' ') || '—',
    newName: [firstName, lastName].filter(Boolean).join(' '),
  };
}

// On check-in/pay: capture the customer in the app directory (always), and — until the Helcim
// cutover — mirror to Square so a card charge can be linked. Returns the SQUARE customer id (for
// attaching the sale in Square), or null. The DO directory is updated regardless of Square.
export async function squareUpsertCustomer(entry, opts = {}) {
  if (!entry.name || entry.name.trim() === '-') return null;
  const parts = entry.name.trim().split(/\s+/);
  const firstName = parts[0] || '', lastName = parts.slice(1).join(' ') || '';
  const rawPhone = (entry.phone || '').replace(/\D/g, '');
  if (!rawPhone) return null;

  ensureCustomerInStore(entry, undefined, opts); // app directory first — independent of Square
  if (!cfg().square_config) return null;        // Square dual-write only when configured

  let squareId = null;
  try {
    // Prefer the Square link already on the DO customer (by phone); else search Square by phone.
    const known = (getState().customers || []).find(c => notePhoneKey(c.phone) === notePhoneKey(entry.phone));
    if (known?.squareId) squareId = known.squareId;
    if (!squareId) {
      try {
        const phoneE164 = `+1${rawPhone.replace(/^1(\d{10})$/, '$1')}`;
        const sr = await fetch(`${SQUARE_PROXY}/v2/customers/search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: { filter: { phone_number: { exact: phoneE164 } } } }),
        });
        if (sr.ok) squareId = (await sr.json())?.customers?.[0]?.id || null;
      } catch (e) {}
    }
    const payload = { given_name: firstName, family_name: lastName, phone_number: entry.phone };
    if (squareId) {
      await fetch(`${SQUARE_PROXY}/v2/customers/${squareId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } else {
      const res = await fetch(`${SQUARE_PROXY}/v2/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: `muse-customer-${rawPhone}`, ...payload }) });
      if (res.ok) squareId = (await res.json())?.customer?.id || null;
      else console.warn('[Square] Customer create failed:', res.status);
    }
    if (squareId) ensureCustomerInStore(entry, squareId, opts);   // attach the Square link to the DO customer
  } catch (e) { console.warn('[Square] Customer upsert failed:', e); }
  return squareId;
}

// ── Notes re-key migration + orphan finder ──────────────────────────────────
// One-time, idempotent, operator-triggered (Settings → Data Recovery). Moves any
// legacy Square-ID-keyed note onto its customer's phone key; phone keys are left
// untouched, so re-running is a no-op. Collisions concatenate (never lose a note).
// A note whose Square ID isn't in the directory stays put and shows in the orphan
// list. preview=true computes the summary without writing. The original map is
// stashed once under customer_notes_backup_v361 for rollback.
export function rekeyNotesByPhone(preview = false) {
  const notes = cfg().customer_notes || {};
  const byId = new Map((customerDirectory || []).map(c => [c.squareId, c]));
  const next = {};
  let rekeyed = 0, merged = 0, orphans = 0;
  const place = (key, text) => {
    if (!(key in next)) { next[key] = text; return false; }
    if (next[key] !== text && !next[key].split('\n').some(l => l === text)) next[key] += '\n' + text;
    return true;   // collision — appended (or a duplicate, skipped)
  };
  for (const [key, raw] of Object.entries(notes)) {
    const text = (raw || '').trim();
    if (!text) continue;
    if (isPhoneKey(key)) { if (place(key, text)) merged++; continue; }
    const pk = notePhoneKey(byId.get(key)?.phone || '');
    if (pk) { if (place(pk, text)) merged++; rekeyed++; }
    else { next[key] = text; orphans++; }
  }
  if (!preview) {
    if (!cfg().customer_notes_backup_v361) dispatch('config.set', { key: 'customer_notes_backup_v361', value: notes });
    dispatch('config.set', { key: 'customer_notes', value: next });
    window.logAudit?.('Customer notes re-keyed by phone', `${rekeyed} re-keyed · ${merged} merged · ${orphans} orphan`);
  }
  return { rekeyed, merged, orphans, total: Object.keys(notes).filter(k => (notes[k] || '').trim()).length };
}

// Notes whose key matches no current customer phone — surfaced read-only so the
// operator can spot a note that lost its customer (deleted/merged-away) or a
// leftover Square-ID key the migration couldn't resolve.
export function findOrphanNotes() {
  const notes = cfg().customer_notes || {};
  const phones = new Set((customerDirectory || []).map(c => notePhoneKey(c.phone)).filter(Boolean));
  const out = [];
  for (const [key, raw] of Object.entries(notes)) {
    const text = (raw || '').trim();
    if (!text) continue;
    if (isPhoneKey(key) && phones.has(key)) continue;
    out.push({ key, text, type: isPhoneKey(key) ? 'phone' : 'square-id' });
  }
  return out;
}
