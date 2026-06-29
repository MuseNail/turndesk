// ── Services / Items / Fees CRUD + dashboard visibility ─────────────────────
// Canonical config-write pattern: read arrays from the store, write via
// dispatch('config.set', { key, value: newArray }) (immutable update). The store
// applies optimistically + the DO broadcasts to other devices. No Sheets, no globals.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, setSwitchVisual } from '../utils.js';

const cfg = () => getState().config;

// ── Services (merged: CRUD + check-in visibility + dashboard visibility) ──────
// One row per service: abbr/name/base-cost + two inline visibility toggles
// (customer check-in screen, dashboard) + edit + delete.
export function renderServicesMerged() {
  const list = document.getElementById('services-merged-list');
  if (!list) return;
  const svcs = cfg().services;
  if (!svcs.length) { list.innerHTML = '<p class="text-sm font-body text-on-surface-variant py-4 text-center">No services yet. Add one to get started.</p>'; return; }
  list.innerHTML = svcs.map(s => {
    const checkin = isServiceVisibleOnCheckin(s.id);
    const dash    = isServiceVisibleOnDash(s.id);
    const toggle = (on, label, fn, title) => `
      <button onclick="event.stopPropagation();${fn}('${s.id}',this)" title="${title}" class="flex flex-col items-center gap-1 flex-shrink-0 px-1 py-1">
        <span class="text-[9px] font-body uppercase tracking-wider ${on ? 'text-primary' : 'text-outline-variant'}">${label}</span>
        <div class="mswitch relative w-14 h-7 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-surface-container-high'}"><div class="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${on ? 'left-7' : 'left-0.5'}"></div></div>
      </button>`;
    // Whole row opens the editor; the toggles + delete are nested actions that
    // stopPropagation so they don't also fire the row's edit.
    return `
    <div onclick="showEditService('${s.id}')" title="Edit service" class="bg-surface-container-lowest rounded-xl px-4 py-3 border border-surface-container-high flex items-center justify-between gap-3 cursor-pointer hover:bg-surface-container transition-colors">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-10 h-10 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
          <span class="text-xs font-headline font-bold text-on-primary">${s.abbr}</span>
        </div>
        <div class="min-w-0">
          <div class="font-headline font-semibold text-on-surface text-base truncate">${s.label}</div>
          ${s.baseCost != null ? `<div class="text-xs font-body text-on-surface-variant mt-0.5">Base: $${Number(s.baseCost).toFixed(2)}</div>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-4 flex-shrink-0">
        ${toggle(checkin, 'Check-in', 'toggleCheckinService', 'Show on the customer check-in screen')}
        ${toggle(dash, 'Dashboard', 'toggleDashService', 'Show in Assign, Turns, Queue & Calendar')}
        <button onclick="event.stopPropagation();deleteService('${s.id}')" title="Delete service" class="w-9 h-9 rounded-full hover:bg-error/10 flex items-center justify-center text-on-surface-variant hover:text-error transition-colors">
          <span class="material-symbols-outlined" style="font-size:18px">delete</span>
        </button>
      </div>
    </div>`;
  }).join('');
}

// ── Customer check-in service visibility (config.hidden_services) ─────────────
export function isServiceVisibleOnCheckin(id) { return !cfg().hidden_services.includes(id); }
export function toggleCheckinService(id, btn) {
  const hidden = cfg().hidden_services;
  const nowVisible = hidden.includes(id);   // currently hidden → toggling turns it on
  dispatch('config.set', { key: 'hidden_services', value: hidden.includes(id) ? hidden.filter(x => x !== id) : [...hidden, id] });
  if (btn) setSwitchVisual(btn, nowVisible); else renderServicesMerged();
}
export function toggleAllCheckinServices() {
  dispatch('config.set', { key: 'hidden_services', value: cfg().hidden_services.length === 0 ? cfg().services.map(s => s.id) : [] });
  renderServicesMerged();
}

export function showAddService() {
  document.getElementById('service-modal-title').textContent = 'Add Service';
  document.getElementById('service-name-input').value = '';
  document.getElementById('service-abbr-input').value = '';
  document.getElementById('service-base-cost-input').value = '';
  document.getElementById('service-edit-id').value = '';
  const m = document.getElementById('service-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('service-name-input').focus(), 100);
}

export function showEditService(id) {
  const svc = cfg().services.find(s => s.id === id);
  if (!svc) return;
  document.getElementById('service-modal-title').textContent = 'Edit Service';
  document.getElementById('service-name-input').value = svc.label;
  document.getElementById('service-abbr-input').value = svc.abbr;
  document.getElementById('service-base-cost-input').value = svc.baseCost != null ? svc.baseCost : '';
  document.getElementById('service-edit-id').value = id;
  const m = document.getElementById('service-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}

export function closeServiceModal() {
  const m = document.getElementById('service-modal');
  m.classList.add('hidden'); m.style.display = '';
}

export function saveService() {
  const label = document.getElementById('service-name-input').value.trim();
  const abbr  = document.getElementById('service-abbr-input').value.trim();
  const baseCostRaw = document.getElementById('service-base-cost-input').value.trim();
  const baseCost = baseCostRaw !== '' ? parseFloat(baseCostRaw) : null;
  const editId = document.getElementById('service-edit-id').value;
  if (!label) { showToast('Please enter a service name.'); return; }
  if (!abbr)  { showToast('Please enter an abbreviation.'); return; }
  const services = [...cfg().services];
  const dup = services.find(s => s.label.toLowerCase() === label.toLowerCase() && s.id !== editId);
  if (dup) { showToast(`"${label}" already exists as a service.`); return; }

  let changedSvc;
  if (editId) {
    const i = services.findIndex(s => s.id === editId);
    if (i >= 0) { changedSvc = { ...services[i], label, abbr, baseCost }; services[i] = changedSvc; }
  } else {
    changedSvc = { id: `svc-${Date.now()}`, label, abbr, baseCost };
    services.push(changedSvc);
  }
  dispatch('config.set', { key: 'services', value: services });
  closeServiceModal();
  renderServicesMerged();
  showToast(editId ? 'Service updated' : `"${label}" added`);
}

export function deleteService(id) {
  const svc = cfg().services.find(s => s.id === id);
  if (!svc) return;
  if (!confirm(`Remove "${svc.label}" from services?`)) return;
  dispatch('config.set', { key: 'services', value: cfg().services.filter(s => s.id !== id) });
  renderServicesMerged();
  showToast(`"${svc.label}" removed`);
}

// ── Dashboard service visibility (config.hidden_dash_services) ────────────────
export function isServiceVisibleOnDash(id) { return !cfg().hidden_dash_services.includes(id); }

export function toggleDashService(id, btn) {
  const hidden = cfg().hidden_dash_services;
  const nowVisible = hidden.includes(id);   // currently hidden → toggling turns it on
  const next = hidden.includes(id) ? hidden.filter(x => x !== id) : [...hidden, id];
  dispatch('config.set', { key: 'hidden_dash_services', value: next });
  if (btn) setSwitchVisual(btn, nowVisible); else renderServicesMerged();
}

export function toggleAllDashServices() {
  const next = cfg().hidden_dash_services.length === 0 ? cfg().services.map(s => s.id) : [];
  dispatch('config.set', { key: 'hidden_dash_services', value: next });
  renderServicesMerged();
}

// ── Items ─────────────────────────────────────────
function setItems(items) { dispatch('config.set', { key: 'items', value: items }); }

export function renderSettingsItems() {
  const container = document.getElementById('settings-items-list');
  if (!container) return;
  const items = cfg().items;
  container.innerHTML = items.map((item, i) => `
    <div class="flex items-center gap-2 py-2 border-b border-surface-container-high last:border-0">
      <input type="text" value="${item.label}" placeholder="Item name"
        onchange="updateItemField(${i},'label',this.value)"
        class="flex-1 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none">
      <input type="text" value="${item.abbr}" placeholder="Abbr"
        onchange="updateItemField(${i},'abbr',this.value)"
        class="w-16 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body font-semibold focus:border-primary outline-none text-center">
      <div class="flex items-center gap-1">
        <span class="text-sm text-on-surface-variant">$</span>
        <input type="text" inputmode="decimal" value="${item.price || ''}" placeholder="0.00"
          onchange="updateItemField(${i},'price',this.value)"
          class="w-16 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none text-right">
      </div>
      <button onclick="removeItem(${i})" class="text-outline-variant hover:text-error transition-colors flex-shrink-0">
        <span class="material-symbols-outlined" style="font-size:16px">delete</span>
      </button>
    </div>`).join('') || '<p class="text-sm text-on-surface-variant py-2">No items yet.</p>';
}

export function updateItemField(i, field, value) {
  const items = cfg().items.map((it, idx) => idx === i ? { ...it, [field]: field === 'price' ? (parseFloat(value) || 0) : value } : it);
  setItems(items);
}
export function addItemRow() {
  setItems([...cfg().items, { id: 'item-' + Date.now(), label: '', abbr: '', price: 0 }]);
  renderSettingsItems();
}
export function removeItem(i) {
  const it = cfg().items[i];
  if (it && (it.label || it.price) && !confirm(`Remove "${it.label || 'this item'}"?`)) return;
  setItems(cfg().items.filter((_, idx) => idx !== i));
  renderSettingsItems();
}

// ── Fees ──────────────────────────────────────────
function setFees(fees) { dispatch('config.set', { key: 'fees', value: fees }); }

export function renderSettingsFees() {
  const container = document.getElementById('settings-fees-list');
  if (!container) return;
  container.innerHTML = cfg().fees.map((fee, i) => `
    <div class="flex items-center gap-2 py-2 border-b border-surface-container-high last:border-0">
      <input type="text" value="${fee.label}" placeholder="Fee name"
        onchange="updateFeeField(${i},'label',this.value)"
        class="flex-1 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none">
      <select onchange="updateFeeField(${i},'type',this.value)"
        class="bg-surface-container border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none">
        <option value="flat"    ${fee.type==='flat'   ?'selected':''}>Flat $</option>
        <option value="percent" ${fee.type==='percent'?'selected':''}>Percent %</option>
      </select>
      <input type="text" inputmode="decimal" value="${fee.value || ''}" placeholder="0"
        onchange="updateFeeField(${i},'value',this.value)"
        class="w-16 bg-transparent border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:border-primary outline-none text-right">
      <button onclick="removeFee(${i})" class="text-outline-variant hover:text-error transition-colors">
        <span class="material-symbols-outlined" style="font-size:16px">delete</span>
      </button>
    </div>`).join('') || '<p class="text-sm text-on-surface-variant py-2">No fees yet.</p>';
}

export function updateFeeField(i, field, value) {
  const fees = cfg().fees.map((f, idx) => idx === i ? { ...f, [field]: field === 'value' ? (parseFloat(value) || 0) : value } : f);
  setFees(fees);
}
export function addFeeRow() {
  setFees([...cfg().fees, { id: 'fee-' + Date.now(), label: '', type: 'flat', value: 0 }]);
  renderSettingsFees();
}
export function removeFee(i) {
  const f = cfg().fees[i];
  if (f && (f.label || f.value) && !confirm(`Remove "${f.label || 'this fee'}"?`)) return;
  setFees(cfg().fees.filter((_, idx) => idx !== i));
  renderSettingsFees();
}
