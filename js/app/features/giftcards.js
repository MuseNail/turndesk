// ── Gift cards + backup/restore utilities ───────────────────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, todayStr, localDateStr } from '../utils.js';
import { APP_NAME, APP_VERSION } from '../config.js';
import { customerDirectory } from './square-customers.js';

const giftCards = () => getState().giftcards;

// A card's redemptions = explicit [{date,amount}] array, or a legacy single
// dateUsed/amountUsed migrated to one entry. gcTotalUsed = sum of all redemptions.
export function gcRedemptions(g) {
  if (Array.isArray(g.redemptions)) return g.redemptions.filter(r => r && ((r.amount || 0) > 0 || r.date));
  if ((g.amountUsed || 0) > 0 || g.dateUsed) return [{ date: g.dateUsed || g.datePurchased || '', amount: g.amountUsed || 0 }];
  return [];
}
export const gcTotalUsed = g => gcRedemptions(g).reduce((s, r) => s + (r.amount || 0), 0);

// ── R6: record gift-card use at checkout (does NOT touch the Square charge) ────────
// The app keeps its own gift-card ledger in sync with Square (which applies the real card
// to the charge). At checkout we log a redemption + draw down the app balance, tagged with
// the ticketId so reopening a ticket reverses exactly its draws. Never changes ticketTotal.
function _gcCommit(card) {
  const redemptions = (card.redemptions || []).filter(r => r && ((r.amount || 0) > 0 || r.date));
  const amountUsed = redemptions.reduce((s, r) => s + (r.amount || 0), 0);
  const dateUsed = redemptions.map(r => r.date).filter(Boolean).sort().pop() || '';
  dispatch('giftcard.save', { card: { ...card, redemptions, amountUsed, dateUsed, updatedAt: new Date().toISOString() } });
}
export function gcReverseTicket(ticketId) {
  if (!ticketId) return;
  giftCards().forEach(g => {
    const reds = gcRedemptions(g);
    if (reds.some(r => r.ticketId === ticketId)) _gcCommit({ ...g, redemptions: reds.filter(r => r.ticketId !== ticketId) });
  });
}
// Idempotent: clears this ticket's prior draws, then writes the given set. Safe to call on
// every 'paid' event. items = [{ giftcardId, amount }].
export function gcSyncTicket(ticketId, items) {
  if (!ticketId) return;
  gcReverseTicket(ticketId);
  (items || []).forEach(it => {
    if (!(it.amount > 0)) return;
    const g = giftCards().find(x => x.id === it.giftcardId); if (!g) return;
    _gcCommit({ ...g, redemptions: [...gcRedemptions(g), { date: todayStr(), amount: +it.amount, ticketId }] });
  });
}

let _gcSortField = 'datePurchased', _gcSortDir = 'desc', _gcHideZero = false;
let _gcRedeem = [];      // working redemption list while the modal is open
let _gcAcMatches = [];   // recipient autocomplete matches

export function showAddGiftCard() {
  document.getElementById('gc-modal-title').textContent = 'New Gift Card';
  ['gc-edit-id','gc-serial','gc-amount','gc-phone','gc-from','gc-to','gc-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('gc-date').value = todayStr();
  _gcRedeem = []; renderGcRedemptions(); _gcShowDelete(false);
  document.getElementById('gc-to-ac')?.classList.add('hidden');
  const m = document.getElementById('gc-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('gc-serial').focus(), 100);
}
export function showEditGiftCard(id) {
  const gc = giftCards().find(g => g.id === id);
  if (!gc) return;
  document.getElementById('gc-modal-title').textContent = 'Edit Gift Card';
  document.getElementById('gc-edit-id').value = id;
  document.getElementById('gc-date').value = gc.datePurchased || '';
  document.getElementById('gc-serial').value = gc.serial || '';
  document.getElementById('gc-amount').value = gc.amount || '';
  document.getElementById('gc-phone').value = gc.phone || '';
  document.getElementById('gc-from').value = gc.from || '';
  document.getElementById('gc-to').value = gc.to || '';
  document.getElementById('gc-notes').value = gc.notes || '';
  _gcRedeem = gcRedemptions(gc).map(r => ({ date: r.date || '', amount: r.amount || 0 }));
  renderGcRedemptions(); _gcShowDelete(true);
  document.getElementById('gc-to-ac')?.classList.add('hidden');
  const m = document.getElementById('gc-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeGcModal() { const m = document.getElementById('gc-modal'); m.classList.add('hidden'); m.style.display = ''; }

// ── Redemptions editor (multiple date+amount uses per card) ───────────────────
function renderGcRedemptions() {
  const wrap = document.getElementById('gc-redemptions'); if (!wrap) return;
  wrap.innerHTML = _gcRedeem.length ? _gcRedeem.map((r, i) => `
    <div class="flex items-center gap-2 mb-2">
      <input type="date" value="${r.date || ''}" onchange="gcSetRedemption(${i},'date',this.value)" class="flex-1 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-headline focus:border-primary outline-none">
      <input type="text" inputmode="decimal" value="${r.amount ? r.amount : ''}" placeholder="0.00" onfocus="openNumpad(this,'Amount Used')" oninput="gcSetRedemption(${i},'amount',this.value)" onchange="gcSetRedemption(${i},'amount',this.value)" class="w-28 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-headline text-right focus:border-primary outline-none">
      <button onclick="gcRemoveRedemption(${i})" title="Remove" class="w-9 h-9 rounded-xl bg-surface-container hover:bg-error/15 flex items-center justify-center text-on-surface-variant hover:text-error transition-colors flex-shrink-0"><span class="material-symbols-outlined" style="font-size:18px">close</span></button>
    </div>`).join('') : '<p class="text-xs font-body text-on-surface-variant italic py-1">No redemptions yet — add one when the card is used.</p>';
  updateGcTotals();
}
export function gcAddRedemption() { _gcRedeem.push({ date: todayStr(), amount: 0 }); renderGcRedemptions(); }
export function gcRemoveRedemption(i) { _gcRedeem.splice(i, 1); renderGcRedemptions(); }
export function gcSetRedemption(i, field, value) {
  if (!_gcRedeem[i]) return;
  if (field === 'amount') _gcRedeem[i].amount = parseFloat(value) || 0; else _gcRedeem[i].date = value;
  updateGcTotals();
}
export function updateGcTotals() {
  const used = _gcRedeem.reduce((s, r) => s + (r.amount || 0), 0);
  const amount = parseFloat(document.getElementById('gc-amount')?.value) || 0;
  const u = document.getElementById('gc-used-modal'); if (u) u.textContent = '$' + used.toFixed(2);
  const b = document.getElementById('gc-balance-modal'); if (b) b.textContent = '$' + (amount - used).toFixed(2);
}

// ── Recipient autocomplete (customer directory) ───────────────────────────────
export function gcRecipientSearch(input) {
  const q = (input.value || '').trim().toLowerCase();
  const drop = document.getElementById('gc-to-ac'); if (!drop) return;
  if (q.length < 2) { drop.classList.add('hidden'); return; }
  _gcAcMatches = customerDirectory.filter(c => ((c.firstName || '') + ' ' + (c.lastName || '')).trim().toLowerCase().includes(q)).slice(0, 6);
  if (!_gcAcMatches.length) { drop.classList.add('hidden'); return; }
  drop.innerHTML = _gcAcMatches.map((c, i) => { const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim(); return `<div class="autocomplete-item" onmousedown="gcPickRecipient(${i})"><div class="ac-name">${name || '—'}</div><div class="ac-phone">${c.phone || 'No phone'}</div></div>`; }).join('');
  drop.classList.remove('hidden');
}
export function gcPickRecipient(i) {
  const c = _gcAcMatches[i]; if (!c) return;
  const to = document.getElementById('gc-to'); if (to) to.value = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
  const ph = document.getElementById('gc-phone'); if (ph && !ph.value.trim() && c.phone) { ph.value = c.phone; window.formatPhone?.(ph); }
  document.getElementById('gc-to-ac')?.classList.add('hidden');
}
export function gcHideRecipientAc() { setTimeout(() => document.getElementById('gc-to-ac')?.classList.add('hidden'), 150); }

export function saveGiftCard() {
  const editId = document.getElementById('gc-edit-id').value;
  const existing = editId ? giftCards().find(g => g.id === editId) : null;
  const rawSerial = document.getElementById('gc-serial').value.trim();
  const serial = /^\d+$/.test(rawSerial) ? rawSerial.padStart(8, '0') : rawSerial;   // 29 → 00000029
  const redemptions = _gcRedeem.filter(r => (r.amount || 0) > 0 || r.date).map(r => ({ date: r.date || '', amount: parseFloat(r.amount) || 0 }));
  const amountUsed = redemptions.reduce((s, r) => s + (r.amount || 0), 0);
  const lastDate = redemptions.map(r => r.date).filter(Boolean).sort().pop() || '';
  const card = {
    id: editId || 'gc-' + Date.now(),
    datePurchased: document.getElementById('gc-date').value,
    serial,
    amount: parseFloat(document.getElementById('gc-amount').value) || 0,
    phone: document.getElementById('gc-phone').value.trim(),
    from: document.getElementById('gc-from').value.trim(),
    to: document.getElementById('gc-to').value.trim(),
    redemptions,
    amountUsed,          // running total — kept for display + report/back-compat
    dateUsed: lastDate,  // last redemption date — legacy compat
    notes: document.getElementById('gc-notes').value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  dispatch('giftcard.save', { card });
  closeGcModal();
  renderGiftCards();
  showToast(editId ? 'Gift card updated ✓' : 'Gift card added ✓');
}
function _gcShowDelete(show) { document.getElementById('gc-delete-btn')?.classList.toggle('hidden', !show); }
export function deleteGiftCardFromModal() {
  const id = document.getElementById('gc-edit-id').value; if (!id) return;
  window.showWarnModal?.('Delete this gift card?', 'This permanently removes the gift card record. This cannot be undone.', () => {
    dispatch('giftcard.delete', { id });
    closeGcModal();
    renderGiftCards();
    showToast('Gift card deleted');
  });
}

export function setGcSort(field) {
  if (_gcSortField === field) _gcSortDir = _gcSortDir === 'asc' ? 'desc' : 'asc';
  else { _gcSortField = field; _gcSortDir = field === 'datePurchased' ? 'desc' : 'asc'; }
  renderGiftCards();
}
export function toggleGcHideZero() {
  _gcHideZero = !_gcHideZero;
  const btn = document.getElementById('gc-hide-zero-btn'); if (btn) btn.textContent = _gcHideZero ? 'Show $0' : 'Hide $0';
  renderGiftCards();
}

export function renderGiftCards() {
  const list = document.getElementById('gc-list'), empty = document.getElementById('gc-empty');
  if (!list) return;
  const q = (document.getElementById('gc-search')?.value || '').toLowerCase();
  let filtered = giftCards().filter(g => !q || (g.serial||'').toLowerCase().includes(q) || (g.from||'').toLowerCase().includes(q) || (g.to||'').toLowerCase().includes(q) || (g.phone||'').includes(q) || (g.notes||'').toLowerCase().includes(q));
  if (_gcHideZero) filtered = filtered.filter(g => ((g.amount||0) - gcTotalUsed(g)) > 0);
  filtered = [...filtered].sort((a,b) => {
    let av, bv;
    if (_gcSortField === 'amount') { av = a.amount||0; bv = b.amount||0; }
    else if (_gcSortField === 'balance') { av = (a.amount||0)-gcTotalUsed(a); bv = (b.amount||0)-gcTotalUsed(b); }
    else if (_gcSortField === 'serial') { av = a.serial||''; bv = b.serial||''; }
    else if (_gcSortField === 'status') { const order = { Active:0, Partial:1, Redeemed:2 }; const getS = g => { const u = gcTotalUsed(g); const bal = (g.amount||0)-u; return bal<=0&&u>0?'Redeemed':u>0?'Partial':'Active'; }; av = order[getS(a)]??3; bv = order[getS(b)]??3; }
    else { av = a.datePurchased||''; bv = b.datePurchased||''; }
    if (av < bv) return _gcSortDir === 'asc' ? -1 : 1;
    if (av > bv) return _gcSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const totalValue = giftCards().reduce((s,g)=>s+(g.amount||0),0);
  const totalUsed = giftCards().reduce((s,g)=>s+gcTotalUsed(g),0);
  const set = (id,v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('gc-total-sold', giftCards().length); set('gc-total-value', '$'+totalValue.toFixed(2)); set('gc-total-used', '$'+totalUsed.toFixed(2)); set('gc-total-balance', '$'+(totalValue-totalUsed).toFixed(2));

  if (filtered.length === 0) { list.innerHTML = ''; empty?.classList.remove('hidden'); document.getElementById('gc-headers')?.classList.add('hidden'); return; }
  empty?.classList.add('hidden'); document.getElementById('gc-headers')?.classList.remove('hidden');
  const formatDate = d => d ? new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : null;
  list.innerHTML = filtered.map(g => {
    const used = gcTotalUsed(g);
    const balance = (g.amount||0) - used;
    const isRedeemed = balance <= 0 && used > 0;
    const isPartial = used > 0 && balance > 0;
    const sc = isRedeemed ? { bg:'rgba(200,230,197,0.2)', border:'#2a7a4f', label:'Redeemed', lc:'#2a7a4f' } : isPartial ? { bg:'rgba(255,224,178,0.2)', border:'#d4860a', label:'Partial', lc:'#a05000' } : { bg:'', border:'#c8d4d8', label:'Active', lc:'#1a5252' };
    return `<div onclick="showEditGiftCard('${g.id}')" title="Edit gift card" class="rounded-xl border flex items-center gap-0 overflow-hidden cursor-pointer hover:shadow-md transition-shadow" style="background:${sc.bg};border-color:${sc.border}">
      <div class="flex-shrink-0 flex items-center justify-center font-headline font-extrabold text-xl px-4 self-stretch" style="width:88px;background:${sc.border}22;border-right:1px solid ${sc.border}40;color:${sc.lc}">$${(g.amount||0).toFixed(0)}</div>
      <div class="flex-shrink-0 flex items-center justify-center px-3" style="width:96px"><span class="text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap" style="background:${sc.border}20;color:${sc.lc}">${sc.label}</span></div>
      <div class="flex-shrink-0 text-xs font-body font-semibold text-on-surface px-2" style="width:90px">${g.serial ? '#'+g.serial : '—'}</div>
      <div class="flex-shrink-0 text-xs font-body text-on-surface-variant px-2" style="width:96px">${g.datePurchased ? formatDate(g.datePurchased) : '—'}</div>
      <div class="flex-shrink-0 text-xs font-body px-2 truncate" style="width:110px">${g.from ? `<span class="text-on-surface">${g.from}</span>` : '<span class="text-outline-variant">—</span>'}</div>
      <div class="flex-shrink-0 text-xs font-body px-2 truncate" style="width:110px">${g.to ? `<span class="text-on-surface">${g.to}</span>` : '<span class="text-outline-variant">—</span>'}</div>
      <div class="flex-shrink-0 text-xs font-body text-on-surface-variant px-2" style="width:110px">${g.phone || '—'}</div>
      <div class="flex-grow min-w-0 text-xs font-body text-on-surface-variant italic truncate px-2">${g.notes || ''}</div>
      <div class="flex-shrink-0 text-right px-4 py-3" style="width:96px"><div class="text-[10px] text-on-surface-variant leading-none mb-0.5">Balance</div><div class="text-base font-headline font-extrabold leading-none" style="color:${balance>0?'#1a5252':'#aaa'}">$${balance.toFixed(2)}</div>${used>0?`<div class="text-[10px] text-on-surface-variant mt-0.5">$${used.toFixed(2)} used</div>`:''}</div>
    </div>`;
  }).join('');
}

// ── Backup / restore / clear ──────────────────────
export function exportAllData() {
  const s = getState();
  const backup = { exportedAt: new Date().toISOString(), appVersion: APP_NAME + '-' + APP_VERSION, state: { config: s.config, queue: s.queue, records: s.records, giftcards: s.giftcards } };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `turndesk-backup-${todayStr()}.json`; a.click(); URL.revokeObjectURL(url);
  const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
  localStorage.setItem('turndesk_last_backup', now);
  const lbl = document.getElementById('last-backup-label'); if (lbl) lbl.textContent = now;
  showToast('Backup downloaded ✓');
}

export function importAllData(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const backup = JSON.parse(e.target.result);
      const st = backup.state || backup.data;
      if (!st) { showToast('Invalid backup file.'); return; }
      if (!confirm(`Restore backup from ${backup.exportedAt?.slice(0,10) || 'unknown date'}?\n\nThis pushes the backup into the shared store for all devices.`)) return;
      if (st.config) Object.entries(st.config).forEach(([key, value]) => dispatch('config.set', { key, value }));
      (st.queue || []).forEach(entry => dispatch('queue.upsert', { entry }));
      (st.records || []).forEach(record => dispatch('record.save', { record }));
      (st.giftcards || []).forEach(card => dispatch('giftcard.save', { card }));
      showToast('Backup restored ✓');
      window.renderQueue?.(); window.renderTurns?.(); window.setLogo?.();
    } catch (err) { showToast('Failed to read backup file.'); console.error(err); }
  };
  reader.readAsText(file);
  input.value = '';
}

export function confirmClearAllRecords() {
  // Require an admin code first (destructive + irreversible), then the usual confirm.
  window.requireAdminCode?.(() => {
    window.showWarnModal?.('Clear All Records?', 'This permanently removes every transaction record. Export a backup first if you need this data.', () => {
      const _n = getState().records.filter(r => r.status !== 'deleted').length;
      getState().records.forEach(r => { if (r.status !== 'deleted') dispatch('record.delete', { id: r.id, reason: 'bulk clear', by: 'admin' }); });
      localStorage.removeItem('turndesk_deletion_log');
      window.logAudit?.('Clear records', `Cleared all transaction records (${_n})`);
      window.renderTransactions?.(); window.runReport?.();
      showToast('All records cleared ✓');
    });
  }, 'Clearing all records requires an admin PIN.');
}
