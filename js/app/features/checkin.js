// ── Check-in kiosk: guest card builder + submission ─────────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, newEntryId } from '../utils.js';
import { GROUP_COLORS } from '../config.js';
import { ui } from '../session.js';
import { squareUpsertCustomer } from './square-customers.js';

const cfg = () => getState().config;
const isServiceVisibleOnCheckin = id => !cfg().hidden_services.includes(id);

let guestCount = 0;
let groupColorIndex = 0;

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
    <button type="button" onclick="toggleService(this, '${idx}', '${s.id}')" data-service="${s.id}"
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

export function removeGuest(idx) { document.getElementById(`guest-card-${idx}`)?.remove(); }
export function toggleService(btn) { btn.classList.toggle('selected'); }

export function submitCheckin() {
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
    newEntries.push({
      id: newEntryId(),
      name: first + (last ? ' ' + last : ''), phone, services,
      status: 'waiting', checkinTime: new Date().toISOString(), isNew: true,
      skipSquare: sameContact, isAppointment: ui.currentCheckinType === 'appointment',
    });
  }
  if (newEntries.length === 0) return;

  if (newEntries.length > 1) {
    const groupId = `grp-${Date.now()}`;
    const groupColor = GROUP_COLORS[groupColorIndex++ % GROUP_COLORS.length];
    const primaryName = newEntries[0].name;
    newEntries.forEach((e, i) => { e.groupId = groupId; e.groupColor = groupColor; e.groupLabel = i === 0 ? `${e.name} (primary)` : `${primaryName} — ${e.name}`; });
  }

  newEntries.forEach(e => dispatch('queue.upsert', { entry: e }));
  newEntries.forEach(e => { if (!e.skipSquare) squareUpsertCustomer(e); });
  window.logAudit?.('Check-in', `${newEntries.map(e => e.name).join(' & ')} checked in`);

  document.getElementById('confirm-name').textContent = newEntries.map(e => e.name).join(' & ');
  window.goTo?.('screen-confirm');
  clearTimeout(window._confirmResetTimer);
  window._confirmResetTimer = setTimeout(() => {
    if (document.getElementById('screen-confirm').classList.contains('active')) window.goTo?.('screen-welcome');
  }, 5000);

  window.renderQueue?.(); window.updateStats?.(); window.renderTurns?.();
}
