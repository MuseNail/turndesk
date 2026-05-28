// ── Square customers: directory, autocomplete, upsert, staff import ─────────
// Customers are owned by Square — kept as a device-local cache (localStorage
// 'turndesk_customers'), NOT in the DO store. Staff import writes config.staff.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, formatPhone, autoCapitalize, dismissNumpad } from '../utils.js';
import { SQUARE_PROXY } from '../config.js';

const cfg = () => getState().config;
// Manual customer notes are app-owned + synced (config.customer_notes) — kept
// SEPARATE from Square's own `note` field, which the app does NOT write. This
// app-owned note is what the check-in popup shows. Notes are keyed by PHONE
// (normalized digits) so a Square customer-ID change (merge/recreate) can't
// orphan them; notePhoneKey() is the single canonical normalization.
const notePhoneKey = phone => (phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
const isPhoneKey   = key => /^\d{7,15}$/.test(key);
const customerNote = phone => ((cfg().customer_notes || {})[notePhoneKey(phone)] || '').trim();

export let squareCustomers   = [];
export let customerDirectory = [];

// Unsaved-changes guard for the Edit Customer modal (3b): snapshot the fields when it opens,
// warn before discarding if they changed.
let _editCustSnapshot = '';
const _editCustSig = () => ['edit-cust-first','edit-cust-last','edit-cust-phone','edit-cust-email','edit-cust-notes'].map(id => (document.getElementById(id)?.value || '').trim()).join('');

// Pre-populate from the local cache on load (works offline + before Square sync).
(function initFromCache() {
  try {
    const cached = localStorage.getItem('turndesk_customers');
    if (cached) {
      customerDirectory = JSON.parse(cached);
      squareCustomers = customerDirectory.map(c => ({
        id: c.squareId, given_name: c.firstName || '', family_name: c.lastName || '',
        phone: c.phone || '', display: [c.firstName, c.lastName].filter(Boolean).join(' '),
      })).filter(c => c.given_name);
    }
  } catch (e) {}
})();

// ATOMIC refresh: the directory + cache (and therefore the phone/id anchors that
// notes hang off) are replaced ONLY on a fully successful pull — every page OK and
// the cursor exhausted. Any page error, a network throw, or a fully-"successful"
// empty pull while we already hold data keeps the last-good list untouched and
// returns false, so a single failed page can never blank the directory.
export async function loadSquareCustomers() {
  let all = [], cursor = null;
  try {
    do {
      const url = `${SQUARE_PROXY}/v2/customers?limit=100&sort_field=CREATED_AT&sort_order=DESC${cursor ? '&cursor=' + cursor : ''}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`Square customers: page failed (HTTP ${res.status}) — keeping last-good directory`);
        showToast('Customer sync incomplete — kept last list');
        return false;
      }
      const data = await res.json();
      all = all.concat(data.customers || []);
      cursor = data.cursor || null;
    } while (cursor);
  } catch (e) {
    console.warn('Could not load Square customers:', e);
    showToast('Customer sync incomplete — kept last list');
    return false;
  }

  // Suspicious-shrink guard: a fully "successful" empty pull while the cache is
  // populated is almost always a transient Square/proxy glitch, not a real wipe.
  if (all.length === 0 && customerDirectory.length > 0) {
    console.warn('Square returned 0 customers but cache has data — keeping last-good directory');
    showToast('Customer sync incomplete — kept last list');
    return false;
  }

  squareCustomers = all
    .filter(c => c.given_name && c.given_name.trim() !== '-' && c.given_name.trim() !== '')
    .map(c => ({
      id: c.id,
      given_name:  c.given_name?.trim() || '',
      family_name: (c.family_name || '').trim().replace(/^-$/, ''),
      phone:       c.phone_number || '',
      display:     [c.given_name?.trim(), (c.family_name||'').trim().replace(/^-$/,'')].filter(Boolean).join(' '),
    }));
  customerDirectory = all.map(c => ({
    squareId: c.id, firstName: c.given_name?.trim() || '', lastName: (c.family_name || '').trim().replace(/^-$/, ''),
    phone: c.phone_number || '', email: c.email_address || '', note: c.note || '',
  }));
  localStorage.setItem('turndesk_customers', JSON.stringify(customerDirectory));
  console.log(`Loaded ${squareCustomers.length} customers from Square`);
  return true;
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
      return c.given_name.toLowerCase().startsWith(query.toLowerCase()) || c.display.toLowerCase().startsWith(query.toLowerCase());
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
      {id:'${c.id}',phone:'${c.phone.replace(/'/g,"\\'")}',given_name:'${c.given_name.replace(/'/g,"\\'")}',family_name:'${c.family_name.replace(/'/g,"\\'")}'},
      ${guestIdx}, '', '${phoneId}', '${firstId}', '${lastId}'
    )">
      <div class="ac-name">${c.display || '—'}</div>
      <div class="ac-phone">${displayPhone || 'No phone'}</div>
    </div>`;
  }).join('');
  dropdown.classList.remove('hidden');
  const input = document.getElementById(phoneId) || document.getElementById(firstId);
  if (input) _attachAcKeyNav(input, dropdown, idx => fillFromCustomer(
    { id: customers[idx].id, phone: customers[idx].phone, given_name: customers[idx].given_name, family_name: customers[idx].family_name },
    guestIdx, '', phoneId, firstId, lastId));
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

// ── Customer Directory modal ──────────────────────
export function showCustomerDir() {
  const m = document.getElementById('customer-dir-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  renderCustomerDir('');
}
export function closeCustomerDir() {
  const m = document.getElementById('customer-dir-modal');
  m.classList.add('hidden'); m.style.display = '';
}
export async function syncSquareCustomers() {
  if (!cfg().square_config) { showToast('Square not configured.'); return; }
  showToast('Syncing customers…');
  const ok = await loadSquareCustomers();   // false → loadSquareCustomers already toasted "sync incomplete"
  if (ok) showToast(`${customerDirectory.length} customers synced ✓`);
  renderCustomerDir(document.getElementById('customer-dir-search')?.value || '');
}
export function filterCustomerDir(query) { renderCustomerDir(query); }

export function renderCustomerDir(query) {
  const list = document.getElementById('customer-dir-list');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  // Phone match compares DIGITS-to-DIGITS: the stored phone is formatted ("(555) 318-2244"),
  // so comparing a typed number against that string failed the moment the query spanned a
  // "(", ")", "-" or space — i.e. 4+ digits or a full number never matched (only the bare
  // area code did). Strip non-digits from both sides instead.
  const qDigits = q.replace(/\D/g, '');
  const filtered = customerDirectory.filter(c => {
    if (!q) return true;
    if ((c.firstName + ' ' + c.lastName).toLowerCase().includes(q)) return true;
    if ((c.email || '').toLowerCase().includes(q)) return true;
    if (qDigits && (c.phone || '').replace(/\D/g, '').includes(qDigits)) return true;
    return false;
  }).slice(0, 100);
  if (filtered.length === 0) {
    list.innerHTML = '<div class="text-sm font-body text-on-surface-variant text-center py-8">No customers found. Tap Sync Square to load.</div>';
    return;
  }
  list.innerHTML = filtered.map(c => {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown';
    return `
      <div onclick="showEditCustomer('${c.squareId}')" title="Edit customer" class="flex items-center gap-3 px-4 py-3 border-b border-surface-container-high hover:bg-surface-container transition-colors cursor-pointer">
        <div class="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center flex-shrink-0">
          <span class="text-sm font-headline font-bold text-primary">${name.charAt(0).toUpperCase()}</span>
        </div>
        <div class="flex-grow min-w-0">
          <div class="font-headline font-semibold text-on-surface text-sm">${name}</div>
          <div class="text-xs font-body text-on-surface-variant">${c.phone || ''}${c.email ? ' · ' + c.email : ''}</div>
        </div>
        <span class="material-symbols-outlined text-on-surface-variant flex-shrink-0" style="font-size:18px">chevron_right</span>
      </div>`;
  }).join('');
}

export function showEditCustomer(squareId) {
  const c = customerDirectory.find(x => x.squareId === squareId);
  if (!c) return;
  document.getElementById('edit-cust-id').value        = c.squareId;
  document.getElementById('edit-cust-square-id').value = c.squareId;
  document.getElementById('edit-cust-first').value     = c.firstName;
  document.getElementById('edit-cust-last').value      = c.lastName;
  document.getElementById('edit-cust-phone').value     = c.phone;
  document.getElementById('edit-cust-email').value     = c.email;
  document.getElementById('edit-cust-notes').value     = customerNote(c.phone);   // app-owned manual note, keyed by phone
  // Local visit history (derived from transaction records) — kept in reports.js to avoid
  // a circular import; safe no-op if reports hasn't loaded.
  window.renderCustomerHistory?.(c.phone, [c.firstName, c.lastName].filter(Boolean).join(' '));
  _editCustSnapshot = _editCustSig();   // baseline for the unsaved-changes guard
  const m = document.getElementById('edit-customer-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
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
  const squareId = document.getElementById('edit-cust-square-id').value;
  const first = document.getElementById('edit-cust-first').value.trim();
  const last  = document.getElementById('edit-cust-last').value.trim();
  const phone = document.getElementById('edit-cust-phone').value.trim();
  const email = document.getElementById('edit-cust-email').value.trim();
  const note  = document.getElementById('edit-cust-notes').value.trim();
  if (!first) { showToast('First name is required.'); return; }

  const local = customerDirectory.find(x => x.squareId === squareId);
  if (local) { local.firstName = first; local.lastName = last; local.phone = phone; local.email = email; }
  localStorage.setItem('turndesk_customers', JSON.stringify(customerDirectory));
  // Manual note → app-owned synced store, keyed by phone (kept out of Square's note).
  const phoneKey = notePhoneKey(phone);
  if (phoneKey) {
    const notes = { ...(cfg().customer_notes || {}) };
    if (note) notes[phoneKey] = note; else delete notes[phoneKey];
    dispatch('config.set', { key: 'customer_notes', value: notes });
  } else if (note) {
    showToast('Add a phone number to save a note');
  }
  const sc = squareCustomers.find(c => c.id === squareId);
  if (sc) { sc.given_name = first; sc.family_name = last; sc.phone = phone; sc.display = `${first} ${last}`.trim(); }

  // Update matching queue entries (match by phone) via the store.
  const fullName = last ? `${first} ${last}` : first;
  getState().queue.forEach(e => {
    if (e.phone && phone && e.phone.replace(/\D/g,'').endsWith(phone.replace(/\D/g,''))) {
      dispatch('queue.upsert', { entry: { ...e, name: fullName } });
    }
  });
  window.renderQueue?.(); window.renderTurns?.();

  if (cfg().square_config && squareId) {
    try {
      await fetch(`${SQUARE_PROXY}/v2/customers/${squareId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ given_name: first, family_name: last, phone_number: phone, email_address: email }),   // note stays app-owned — the app never writes Square's own note field
      });
      showToast('Customer updated in Square ✓');
    } catch (e) { showToast('Saved locally (Square update failed)'); }
  } else { showToast('Customer updated locally ✓'); }

  window.logAudit?.('Customer edit', `${fullName || '—'}${phone ? ' · ' + phone : ''}`);
  closeEditCustomer(true);   // already saved — skip the unsaved-changes guard
  renderCustomerDir(document.getElementById('customer-dir-search')?.value || '');
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
export async function squareUpsertCustomer(entry) {
  if (!entry.name || entry.name.trim() === '-') return;
  const parts = entry.name.trim().split(/\s+/);
  const firstName = parts[0] || '', lastName = parts.slice(1).join(' ') || '';
  const rawPhone = (entry.phone || '').replace(/\D/g, '');
  if (!rawPhone) return;
  try {
    let existingId = null;
    if (squareCustomers.length > 0) {
      const cached = squareCustomers.find(c => {
        const cp = (c.phone||'').replace(/\D/g,'').replace(/^1(\d{10})$/,'$1');
        return cp === rawPhone || cp === rawPhone.replace(/^1/,'');
      });
      if (cached) existingId = cached.id;
    }
    if (!existingId) {
      try {
        const phoneE164 = `+1${rawPhone.replace(/^1(\d{10})$/, '$1')}`;
        const sr = await fetch(`${SQUARE_PROXY}/v2/customers/search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: { filter: { phone_number: { exact: phoneE164 } } } }),
        });
        if (sr.ok) existingId = (await sr.json())?.customers?.[0]?.id || null;
      } catch (e) {}
    }
    // The app no longer writes Square's own `note` field — it kept overwriting the
    // salon's manual note box every check-in. Visit history is tracked app-side.
    const payload = { given_name: firstName, family_name: lastName };
    if (rawPhone) payload.phone_number = entry.phone;

    if (existingId) {
      const res = await fetch(`${SQUARE_PROXY}/v2/customers/${existingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        const c = (await res.json()).customer;
        if (c) {
          // Refresh the local caches so a name/phone fix shows immediately in-app
          // (not only after the next full sync).
          const sc = squareCustomers.find(x => x.id === c.id);
          if (sc) { sc.given_name = c.given_name||''; sc.family_name = c.family_name||''; sc.phone = c.phone_number||''; sc.display = entry.name; }
          else squareCustomers.push({ id: c.id, given_name: c.given_name||'', family_name: c.family_name||'', phone: c.phone_number||'', display: entry.name });
          const dir = customerDirectory.find(x => x.squareId === c.id);
          if (dir) { dir.firstName = c.given_name||''; dir.lastName = c.family_name||''; dir.phone = c.phone_number||''; }
          else customerDirectory.push({ squareId: c.id, firstName: c.given_name||'', lastName: c.family_name||'', phone: c.phone_number||'', email: '', note: c.note||'' });
          localStorage.setItem('turndesk_customers', JSON.stringify(customerDirectory));
        }
      }
    } else {
      const iKey = rawPhone ? `turndesk-customer-${rawPhone}` : `turndesk-customer-${firstName.toLowerCase()}-${lastName.toLowerCase()}`;
      const res = await fetch(`${SQUARE_PROXY}/v2/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: iKey, ...payload }) });
      if (res.ok) {
        const c = (await res.json()).customer;
        if (c) {
          squareCustomers.push({ id: c.id, given_name: c.given_name||'', family_name: c.family_name||'', phone: c.phone_number||'', display: entry.name });
          customerDirectory.push({ squareId: c.id, firstName: c.given_name||'', lastName: c.family_name||'', phone: c.phone_number||'', email: '', note: c.note||'' });
          localStorage.setItem('turndesk_customers', JSON.stringify(customerDirectory));
        }
      }
    }
  } catch (e) { console.warn('[Square] Customer upsert failed:', e); }
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
