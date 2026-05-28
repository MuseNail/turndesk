// ── Square config modal + catalog pull/push ─────────────────────────────────
// Square location config is synced (config.square_config). Catalog pull merges
// into config.services / config.items / config.fees via dispatch.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast } from '../utils.js';
import { SQUARE_PROXY } from '../config.js';
import { loadSquareCustomers } from './square-customers.js';

const cfg = () => getState().config;
const sqConfig = () => cfg().square_config || null;

export function showSquareModal() {
  const sc = sqConfig();
  if (sc) {
    document.getElementById('sq-location').value = sc.locationId || '';
    const sel = document.getElementById('sq-booking-member');
    if (sel && sel.options.length <= 1 && sc.locationId) loadSquareBookingTeamMembers();
    else if (sel && sc.bookingTeamMemberId) sel.value = sc.bookingTeamMemberId;
  }
  const m = document.getElementById('square-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}

export function saveSquareConfig() {
  const locationId = document.getElementById('sq-location').value.trim();
  if (!locationId) { showToast('Please enter your Location ID.'); return; }
  const sel = document.getElementById('sq-booking-member');
  const memberId   = sel?.value || '';
  const memberName = sel?.options[sel.selectedIndex]?.text || '';
  const value = { locationId, ...(memberId ? { bookingTeamMemberId: memberId, bookingTeamMemberName: memberName } : {}) };
  dispatch('config.set', { key: 'square_config', value });
  const m = document.getElementById('square-modal');
  m.classList.add('hidden'); m.style.display = '';
  updateSyncLabel('ok', 'Square synced');
  showToast('Square connection saved!');
}

export async function testSquareConnection() {
  if (!sqConfig()) { showToast('Save config first.'); return; }
  const status = document.getElementById('sq-status');
  status.classList.remove('hidden');
  status.textContent = 'Testing connection…';
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/locations`);
    if (res.ok) { status.textContent = '✓ Connected successfully!'; status.style.color = '#2a6868'; updateSyncLabel('ok', 'Square synced'); }
    else { const err = await res.json(); status.textContent = '✗ ' + (err.errors?.[0]?.detail || 'Connection failed — check your Location ID'); status.style.color = '#a83836'; updateSyncLabel('error', 'Square error'); }
  } catch (e) { status.textContent = '✗ Could not reach proxy — check Worker is deployed'; status.style.color = '#a83836'; }
}

export async function syncSquare() {
  if (!sqConfig()) { showSquareModal(); return; }
  updateSyncLabel('pending', 'Syncing…');
  showToast('Syncing with Square…');
  try {
    await Promise.all([loadSquareCustomers(), squarePullServices()]);
    updateSyncLabel('ok', 'Square synced');
    showToast('Square sync complete');
  } catch (e) { updateSyncLabel('error', 'Sync failed'); showToast('Square sync failed. Check settings.'); }
}

export function updateSyncLabel(state, label) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-label');
  if (dot) dot.className = `sync-dot ${state}`;
  if (lbl) lbl.textContent = label;
}

// Pull Square catalog (ITEM type) → classify into services / items / fees.
export async function squarePullServices() {
  if (!sqConfig()) return;
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/catalog/list?types=ITEM`);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const e = await res.json(); detail = e.errors?.[0]?.detail || e.errors?.[0]?.code || e.errors?.[0]?.category || detail; } catch {}
      showToast(`Square catalog: ${detail}`); return;
    }
    const data = await res.json();
    const services = [...cfg().services];
    const items    = [...cfg().items];
    const fees     = [...cfg().fees];
    let addedSvc = 0, addedItems = 0;

    (data.objects || []).forEach(item => {
      const name = item.item_data?.name;
      if (!name) return;
      const lname = name.toLowerCase();
      const productType = item.item_data?.product_type;
      const isService = !productType || productType === 'APPOINTMENTS_SERVICE';

      if (lname.includes('fee') || lname.includes('charge') || lname.includes('surcharge')) {
        const id = `sq-fee-${item.id}`;
        if (!fees.find(f => f.id === id || f.label.toLowerCase() === lname)) {
          const price = item.item_data?.variations?.[0]?.item_variation_data?.price_money?.amount;
          fees.push({ id, label: name, type: 'flat', value: price ? price / 100 : 0, squareItemId: item.id });
        }
        return;
      }
      if (isService) {
        const id = `sq-${item.id}`;
        if (!services.find(s => s.id === id || s.label.toLowerCase() === lname)) {
          const abbr = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 4);
          const variationId = item.item_data?.variations?.[0]?.id || null;
          services.push({ id, label: name, abbr, squareItemId: item.id, squareVariationId: variationId });
          addedSvc++;
        }
      } else {
        if (services.find(s => s.label.toLowerCase() === lname)) return;
        const id = `sq-item-${item.id}`;
        if (!items.find(i => i.id === id || i.label.toLowerCase() === lname)) {
          const abbr = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 4);
          const price = item.item_data?.variations?.[0]?.item_variation_data?.price_money?.amount;
          items.push({ id, label: name, abbr, price: price ? price / 100 : 0, squareItemId: item.id });
          addedItems++;
        }
      }
    });

    if (addedSvc)   dispatch('config.set', { key: 'services', value: services });
    if (addedItems) dispatch('config.set', { key: 'items', value: items });
    if (fees.length !== cfg().fees.length) dispatch('config.set', { key: 'fees', value: fees });

    if (addedSvc > 0)   showToast(`${addedSvc} service${addedSvc>1?'s':''} imported from Square`);
    if (addedItems > 0) showToast(`${addedItems} item${addedItems>1?'s':''} imported from Square`);
    if (addedSvc === 0 && addedItems === 0) showToast('Catalog already up to date');
    window.renderServicesMerged?.();
  } catch (e) { console.warn('Could not pull Square catalog:', e); }
}

// Push a service to the Square catalog (create or update). Updates config.services
// with the returned Square ids on create.
export async function squarePushService(svc) {
  if (!sqConfig() || !svc) return;
  try {
    if (svc.squareItemId) {
      const getRes = await fetch(`${SQUARE_PROXY}/v2/catalog/object/${svc.squareItemId}`);
      if (!getRes.ok) { showToast('Square: could not fetch existing service.'); return; }
      const obj = (await getRes.json()).object;
      if (!obj) return;
      obj.item_data.name = svc.label;
      if (obj.item_data.variations?.[0]?.item_variation_data) {
        const vd = obj.item_data.variations[0].item_variation_data;
        vd.pricing_type = svc.baseCost > 0 ? 'FIXED_PRICING' : 'VARIABLE_PRICING';
        if (svc.baseCost > 0) vd.price_money = { amount: Math.round(svc.baseCost * 100), currency: 'USD' }; else delete vd.price_money;
      }
      const res = await fetch(`${SQUARE_PROXY}/v2/catalog/object`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: `turndesk-svc-upd-${svc.id}-${Date.now()}`, object: obj }) });
      if (res.ok) showToast(`"${svc.label}" updated in Square ✓`);
    } else {
      const tempId = `#turndesk-${svc.id}`;
      const res = await fetch(`${SQUARE_PROXY}/v2/catalog/batch-upsert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: `turndesk-svc-${svc.id}-${Date.now()}`, batches: [{ objects: [{
          type: 'ITEM', id: tempId,
          item_data: { name: svc.label, product_type: 'APPOINTMENTS_SERVICE', variations: [{ type: 'ITEM_VARIATION', id: `${tempId}-var`, item_variation_data: { item_id: tempId, name: 'Regular', pricing_type: svc.baseCost > 0 ? 'FIXED_PRICING' : 'VARIABLE_PRICING', ...(svc.baseCost > 0 ? { price_money: { amount: Math.round(svc.baseCost * 100), currency: 'USD' } } : {}) } }] },
        }] }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const itemMapping = (data.id_mappings || []).find(m => m.client_object_id === tempId);
        const varMapping  = (data.id_mappings || []).find(m => m.client_object_id === `${tempId}-var`);
        if (itemMapping?.object_id) {
          const services = cfg().services.map(s => s.id === svc.id ? { ...s, squareItemId: itemMapping.object_id, squareVariationId: varMapping?.object_id } : s);
          dispatch('config.set', { key: 'services', value: services });
        }
        showToast(`"${svc.label}" added to Square ✓`);
      }
    }
  } catch (e) { console.warn('[Square] Catalog push failed:', e); }
}

// Push a retail item to Square (create or update). itemIndex is the index in config.items.
export async function squarePushItem(itemIndex) {
  const item = cfg().items[itemIndex];
  if (!sqConfig() || !item) return;
  try {
    if (item.squareItemId) {
      const getRes = await fetch(`${SQUARE_PROXY}/v2/catalog/object/${item.squareItemId}`);
      if (!getRes.ok) { showToast('Square: could not fetch existing item.'); return; }
      const obj = (await getRes.json()).object;
      if (!obj) return;
      obj.item_data.name = item.label;
      if (obj.item_data.variations?.[0]?.item_variation_data) {
        const vd = obj.item_data.variations[0].item_variation_data;
        vd.pricing_type = item.price > 0 ? 'FIXED_PRICING' : 'VARIABLE_PRICING';
        if (item.price > 0) vd.price_money = { amount: Math.round(item.price * 100), currency: 'USD' }; else delete vd.price_money;
      }
      const res = await fetch(`${SQUARE_PROXY}/v2/catalog/object`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: `turndesk-item-upd-${item.id}-${Date.now()}`, object: obj }) });
      if (res.ok) showToast(`"${item.label}" updated in Square ✓`);
    } else {
      const tempId = `#turndesk-${item.id}`;
      const res = await fetch(`${SQUARE_PROXY}/v2/catalog/batch-upsert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: `turndesk-item-${item.id}-${Date.now()}`, batches: [{ objects: [{
          type: 'ITEM', id: tempId,
          item_data: { name: item.label, variations: [{ type: 'ITEM_VARIATION', id: `${tempId}-var`, item_variation_data: { item_id: tempId, name: 'Regular', pricing_type: item.price > 0 ? 'FIXED_PRICING' : 'VARIABLE_PRICING', ...(item.price > 0 ? { price_money: { amount: Math.round(item.price * 100), currency: 'USD' } } : {}) } }] },
        }] }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const mapping = (data.id_mappings || []).find(m => m.client_object_id === tempId);
        if (mapping?.object_id) {
          const items = cfg().items.map(i => i.id === item.id ? { ...i, squareItemId: mapping.object_id } : i);
          dispatch('config.set', { key: 'items', value: items });
        }
        showToast(`"${item.label}" added to Square ✓`);
      }
    }
  } catch (e) { console.warn('[Square] Catalog push failed:', e); }
}

// Load bookings-eligible team members into the Square modal picker.
export async function loadSquareBookingTeamMembers() {
  if (!sqConfig()) return;
  try {
    const res = await fetch(`${SQUARE_PROXY}/v2/team-members/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { filter: { status: 'ACTIVE' } }, limit: 200 }) });
    if (!res.ok) return;
    const members = (await res.json()).team_members || [];
    const sel = document.getElementById('sq-booking-member');
    if (!sel) return;
    sel.innerHTML = '<option value="">— None (no SMS reminders) —</option>' + members.map(m => {
      const name = [m.given_name, m.family_name].filter(Boolean).join(' ');
      const selected = m.id === sqConfig()?.bookingTeamMemberId ? 'selected' : '';
      return `<option value="${m.id}" ${selected}>${name}</option>`;
    }).join('');
    if (members.length === 0) showToast('No active team members found in Square.');
  } catch (e) { showToast('Could not load team members from Square.'); }
}
