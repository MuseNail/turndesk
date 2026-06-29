// ── Check-in kiosk: guest card builder + submission ─────────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, newEntryId } from '../utils.js';
import { GROUP_COLORS } from '../config.js';
import { ui } from '../session.js';
import { upsertPartyCustomers } from './square-customers.js';

const cfg = () => getState().config;
const isServiceVisibleOnCheckin = id => !cfg().hidden_services.includes(id);

let guestCount = 0;
let groupColorIndex = 0;
// Double-submit guard: the Check-In button calls submitCheckin directly; a bounced/laggy
// double-tap queues two events that would each build a fresh party (new ids + groupId) →
// duplicate queue rows + duplicate Square upserts. The handler is synchronous, so a second
// queued tap fires after the first returns — a short self-releasing lock blocks it.
let _submitting = false;

export function renderGuestsContainer() {
  const container = document.getElementById('guests-container');
  container.innerHTML = '';
  guestCount = 0;
  addGuestCard();
  renderAddGuestButton();
  // Land the cursor in the primary guest's phone field so check-in can start
  // typing immediately (on touch this also opens the on-screen number pad).
  setTimeout(() => document.getElementById('phone-1')?.focus(), 150);
}

export function renderAddGuestButton() {
  document.getElementById('add-guest-btn-row')?.remove();
  const container = document.getElementById('guests-container');
  const row = document.createElement('div');
  row.id = 'add-guest-btn-row';
  row.className = 'flex justify-center pt-2 pb-2';
  row.innerHTML = `
    <button onclick="addGuestCard()" class="group flex items-center gap-2 text-secondary hover:text-on-secondary-container transition-colors px-5 py-3 rounded-full hover:bg-secondary-container text-sm font-body font-semibold tracking-wide">
      <span class="material-symbols-outlined text-lg">person_add</span> Add another guest
    </button>`;
  container.appendChild(row);
}

export function addGuestCard() {
  guestCount++;
  const idx = guestCount;
  const container = document.getElementById('guests-container');
  document.getElementById('add-guest-btn-row')?.remove();

  const card = document.createElement('section');
  card.className = 'guest-card bg-surface-container-lowest p-6 rounded-xl shadow-sm border border-surface-container-high mb-5';
  card.id = `guest-card-${idx}`;

  const visibleServices = cfg().services.filter(s => isServiceVisibleOnCheckin(s.id));
  const serviceButtons = visibleServices.map(s => `
    <button type="button" onclick="toggleService(this)" data-service="${s.id}"
      class="service-btn flex flex-col items-center justify-center py-3 rounded-lg bg-surface-container text-on-surface-variant border border-outline-variant/30 hover:bg-primary/10 hover:text-primary transition-all duration-200">
      <span class="text-xs font-headline font-bold">${s.abbr}</span>
      <span class="text-[9px] font-body mt-0.5 uppercase tracking-tighter leading-tight text-center">${s.label}</span>
    </button>`).join('');

  if (idx === 1) {
    card.innerHTML = `
      <div class="flex justify-between items-baseline mb-5">
        <h2 class="text-xs font-headline font-bold tracking-widest text-primary uppercase">Primary Guest</h2>
        <span class="text-[10px] font-body text-outline uppercase tracking-tighter opacity-50">Entry 01</span>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-5">
        <div class="space-y-4">
          <div class="ac-input-wrap">
            <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">Phone Number</label>
            <input id="phone-${idx}" type="tel" placeholder="(555) 000-0000" autocomplete="off" onfocus="openPhoneNumpad(this)" oninput="acSearch(this, ${idx}, 'phone')"
              class="w-full bg-transparent border-b border-surface-container-high py-2 text-xl font-headline font-light focus:border-primary transition-colors placeholder:text-surface-container-highest">
            <div id="ac-phone-${idx}" class="autocomplete-list hidden"></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="ac-input-wrap">
              <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">First Name</label>
              <input id="first-${idx}" type="text" placeholder="Name" autocomplete="off" oninput="acSearch(this, ${idx}, 'first'); autoCapitalize(this)"
                class="w-full bg-transparent border-b border-surface-container-high py-2 text-lg font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
              <div id="ac-first-${idx}" class="autocomplete-list hidden"></div>
            </div>
            <div>
              <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">Last Name</label>
              <input id="last-${idx}" type="text" placeholder="Last name" oninput="autoCapitalize(this)"
                class="w-full bg-transparent border-b border-surface-container-high py-2 text-lg font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
            </div>
          </div>
        </div>
        <div>
          <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-3">Select Services</label>
          <div class="grid grid-cols-4 gap-2" id="services-${idx}">${serviceButtons}</div>
        </div>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="flex justify-between items-baseline mb-4">
        <h2 class="text-xs font-headline font-bold tracking-widest text-primary uppercase">Guest ${idx}</h2>
        <div class="flex items-center gap-3">
          <span class="text-[10px] font-body text-outline uppercase tracking-tighter opacity-50">Entry ${String(idx).padStart(2,'0')}</span>
          <button onclick="removeGuest(${idx})" class="text-xs font-body text-outline hover:text-error transition-colors flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:14px">remove_circle</span> Remove</button>
        </div>
      </div>
      <label class="flex items-center gap-3 mb-5 cursor-pointer" id="same-contact-label-${idx}" onclick="toggleSameContact(${idx})">
        <div id="same-contact-box-${idx}" class="w-6 h-6 rounded border-2 border-outline-variant flex items-center justify-center flex-shrink-0 transition-all" style="background:transparent">
          <span class="material-symbols-outlined hidden" id="same-contact-check-${idx}" style="font-size:14px;color:#ffffff;font-variation-settings:'FILL' 1,'wght' 700">check</span>
        </div>
        <span class="text-sm font-body text-on-surface-variant">Same contact info as primary guest</span>
        <input type="checkbox" id="same-contact-${idx}" class="hidden">
      </label>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-5">
        <div id="manual-contact-fields-${idx}" class="space-y-3">
          <div class="ac-input-wrap">
            <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-1">Phone Number</label>
            <input id="phone-${idx}" type="tel" placeholder="(555) 000-0000" autocomplete="off" onfocus="openPhoneNumpad(this)" oninput="acSearch(this, ${idx}, 'phone')"
              class="w-full bg-transparent border-b border-surface-container-high py-2 text-xl font-headline font-light focus:border-primary transition-colors placeholder:text-surface-container-highest">
            <div id="ac-phone-${idx}" class="autocomplete-list hidden"></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="ac-input-wrap">
              <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">First Name</label>
              <input id="first-${idx}" type="text" placeholder="Name" autocomplete="off" oninput="acSearch(this, ${idx}, 'first'); autoCapitalize(this)"
                class="w-full bg-transparent border-b border-surface-container-high py-2 text-lg font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
              <div id="ac-first-${idx}" class="autocomplete-list hidden"></div>
            </div>
            <div>
              <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">Last Name</label>
              <input id="last-${idx}" type="text" placeholder="Last name" oninput="autoCapitalize(this)"
                class="w-full bg-transparent border-b border-surface-container-high py-2 text-lg font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
            </div>
          </div>
        </div>
        <div id="first-only-fields-${idx}" class="hidden space-y-4">
          <div>
            <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">First Name</label>
            <input id="first-only-${idx}" type="text" placeholder="Name" oninput="autoCapitalize(this)"
              class="w-full bg-transparent border-b border-surface-container-high py-2 text-lg font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
          </div>
        </div>
        <div>
          <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-3">Select Services</label>
          <div class="grid grid-cols-4 gap-2" id="services-${idx}">${serviceButtons}</div>
        </div>
      </div>`;
  }
  card.insertAdjacentHTML('beforeend', notesSectionHtml(idx));
  container.appendChild(card);
  renderAddGuestButton();
  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

export function toggleSameContact(idx) {
  const cb = document.getElementById(`same-contact-${idx}`);
  const box = document.getElementById(`same-contact-box-${idx}`);
  const checkIcon = document.getElementById(`same-contact-check-${idx}`);
  const contactFields = document.getElementById(`manual-contact-fields-${idx}`);
  const firstOnlyFields = document.getElementById(`first-only-fields-${idx}`);
  cb.checked = !cb.checked;
  if (cb.checked) {
    const existingFirst = document.getElementById(`first-${idx}`)?.value.trim() || '';
    box.style.background = '#1a5252'; box.style.borderColor = '#1a5252';
    checkIcon.classList.remove('hidden');
    contactFields.classList.add('hidden'); firstOnlyFields.classList.remove('hidden');
    const fo = document.getElementById(`first-only-${idx}`); if (fo && existingFirst) fo.value = existingFirst;
  } else {
    box.style.background = 'transparent'; box.style.borderColor = '#7a858a';
    checkIcon.classList.add('hidden');
    contactFields.classList.remove('hidden'); firstOnlyFields.classList.add('hidden');
    const foVal = document.getElementById(`first-only-${idx}`)?.value.trim() || '';
    const fi = document.getElementById(`first-${idx}`); if (fi && foVal) fi.value = foVal;
  }
}

// Notes block appended to every guest card: a per-VISIT note (saved on this check-in as txnNote
// → flows to the record + customer/staff history) and the persistent CUSTOMER note (kept on file,
// phone-keyed), revealed + pre-filled when a returning customer is picked from autofill.
function notesSectionHtml(idx) {
  return `<div class="mt-5 space-y-3">
    <div id="ci-cust-note-wrap-${idx}" class="hidden">
      <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">Customer note <span class="text-outline normal-case tracking-normal">· kept on file</span></label>
      <textarea id="ci-cust-note-${idx}" rows="2" oninput="ciCustNoteInput(${idx})" placeholder="Allergies, preferences, anything to remember…"
        class="w-full bg-surface-container rounded-lg border border-surface-container-high px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary resize-none"></textarea>
    </div>
    <div>
      <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest px-1 block mb-1">Note for this visit <span class="text-outline normal-case tracking-normal">· optional</span></label>
      <textarea id="visit-note-${idx}" rows="2" placeholder="e.g., design on ring fingers, in a hurry…"
        class="w-full bg-surface-container rounded-lg border border-surface-container-high px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary resize-none"></textarea>
    </div>
  </div>`;
}

export function removeGuest(idx) { document.getElementById(`guest-card-${idx}`)?.remove(); }
export function toggleService(btn) { btn.classList.toggle('selected'); }

export function submitCheckin(skipApptGuard) {
  const newEntries = [];
  for (let i = 1; i <= guestCount; i++) {
    const card = document.getElementById(`guest-card-${i}`);
    if (!card) continue;
    const sameContact = i > 1 && document.getElementById(`same-contact-${i}`)?.checked;
    let phone, first, last;
    if (sameContact) {
      first = document.getElementById(`first-only-${i}`)?.value.trim() || '';
      phone = document.getElementById('phone-1')?.value.trim() || '';
      last = '';
    } else {
      phone = document.getElementById(`phone-${i}`)?.value.trim() || '';
      first = document.getElementById(`first-${i}`)?.value.trim() || '';
      last  = document.getElementById(`last-${i}`)?.value.trim() || '';
    }
    if (!first) { showToast('Please enter a first name for each guest.'); return; }
    const services = Array.from(card.querySelectorAll('.service-btn.selected')).map(b => b.dataset.service);
    const visitNote = document.getElementById(`visit-note-${i}`)?.value.trim() || '';
    window.flushCiCustNote?.(i);   // persist any edited "customer note on file" before we navigate away
    const entry = {
      id: newEntryId(),
      name: first + (last ? ' ' + last : ''), phone, services,
      status: 'waiting', checkinTime: new Date().toISOString(), isNew: true,
      skipSquare: sameContact, isAppointment: ui.currentCheckinType === 'appointment',
    };
    if (visitNote) entry.txnNote = visitNote;   // per-visit note → carried to the record + history
    newEntries.push(entry);
  }
  if (newEntries.length === 0) return;
  // Appointment guard: if a guest already has a not-checked-in appointment today, prompt to
  // check in FROM the appointment (linked, services included) or proceed as its own check-in.
  if (skipApptGuard !== true && window.checkinApptGuard?.(newEntries.map(e => ({ name: e.name, phone: e.phone })), () => submitCheckin(true))) return;
  if (_submitting) return;                 // ignore a bounced/double tap while the first submit is in flight
  _submitting = true;
  setTimeout(() => { _submitting = false; }, 1500);   // self-release so the lock can never wedge the kiosk

  if (newEntries.length > 1) {
    const groupId = `grp-${Date.now()}`;
    const groupColor = GROUP_COLORS[groupColorIndex++ % GROUP_COLORS.length];
    const primaryName = newEntries[0].name;
    newEntries.forEach((e, i) => { e.groupId = groupId; e.groupColor = groupColor; e.groupLabel = i === 0 ? `${e.name} (primary)` : `${primaryName} — ${e.name}`; });
  }

  newEntries.forEach(e => dispatch('queue.upsert', { entry: e }));
  upsertPartyCustomers(newEntries);   // one Square profile per distinct phone (no shared-phone flip-flop)
  window.logAudit?.('Check-in', `${newEntries.map(e => e.name).join(' & ')} checked in`);

  document.getElementById('confirm-name').textContent = newEntries.map(e => e.name).join(' & ');
  window.goTo?.('screen-confirm');
  clearTimeout(window._confirmResetTimer);
  window._confirmResetTimer = setTimeout(() => {
    if (document.getElementById('screen-confirm').classList.contains('active')) window.goTo?.('screen-welcome');
  }, 5000);

  window.renderQueue?.(); window.updateStats?.(); window.renderTurns?.();
}
