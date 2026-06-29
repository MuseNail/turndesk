// ── Back Office sync (one-way push: Muse → the books app) ──────────────────────
// M11 of the Back Office plan: this is the ONLY touchpoint in Muse. We push
// finalized daily summary rows (and locked payroll periods) to Back Office's
// POST /sync/inbound; they land there as STAGED rows the owner approves into
// the ledger. Nothing ever syncs back — Back Office cannot write to Muse.
//
// The numbers are the same ones the Reports tab shows (computeMetrics /
// payrollComputedRows / payrollFdRows — overrides and locked snapshots
// included), converted to integer cents at this edge. Row identity is
// sourceApp+sourceId (`<date>:<type>`), so re-pushing a day is idempotent:
// Back Office updates still-pending rows and never touches approved ones.
//
// Setup lives in Settings → Integrations → Back Office sync. The endpoint URL +
// business id are synced config (`config.bo_sync`); the SYNC token is
// device-local (`turndesk_bo_token`) — a secret never rides the state channel.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, localDateStr } from '../utils.js';
import { computeMetrics, payrollComputedRows, payrollFdRows } from './reports.js';

const cfg = () => getState().config;
const TOKEN_KEY = 'turndesk_bo_token';
const cents = v => Math.round((v || 0) * 100);

// Net cash-drawer over/short (dollars; + over, − short) across drawers CLOSED on
// the given day. overShort is stored per closed drawer in cash_drawer_history.
function drawerOverShortForDay(dateStr) {
  return (cfg().cash_drawer_history || [])
    .filter(d => d && d.closedAt && localDateStr(new Date(d.closedAt)) === dateStr)
    .reduce((s, d) => s + (Number(d.overShort) || 0), 0);
}

// ── Row builders ──────────────────────────────────
export function buildBoDayRows(dateStr) {
  const from = new Date(dateStr + 'T00:00:00');
  const to = new Date(dateStr + 'T23:59:59.999');
  const m = computeMetrics(from, to);
  const pretty = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const rows = [];
  const add = (type, dollars, desc, memo) => {
    const a = cents(dollars);
    if (a > 0) rows.push({ sourceId: `${dateStr}:${type}`, type, date: dateStr, amountCents: a, desc, ...(memo ? { memo } : {}) });
  };
  add('sales_cash',    m.cashMix,   `Muse — cash sales ${pretty}`);
  add('sales_card',    m.cardMix,   `Muse — card sales ${pretty}`, m.tipsTotal > 0 ? `includes $${m.tipsTotal.toFixed(2)} tips` : '');
  add('sales_zelle',   m.zelleMix,  `Muse — Zelle sales ${pretty}`);
  add('sales_other',   m.otherMix,  `Muse — untracked sales ${pretty}`, 'tickets with no recorded tender');
  add('gift_sold',     m.gcSold,    `Muse — gift cards sold ${pretty}`, 'charged on top of bills — money rides the day’s card/cash');
  add('gift_redeemed', m.giftMix,   `Muse — gift cards redeemed ${pretty}`);
  // Cash drawer over/short for the day → books the cash account to what was actually
  // counted, not just recorded sales. Net across drawers closed that day; + = over.
  const os = drawerOverShortForDay(dateStr);
  if (os > 0)      add('cash_over',  os,  `Muse — cash drawer over ${pretty}`,  'counted more than expected');
  else if (os < 0) add('cash_short', -os, `Muse — cash drawer short ${pretty}`, 'counted less than expected');
  return { rows, metrics: m };
}

export function buildBoPayrollRow(offset) {
  const { cur, T, locked } = payrollComputedRows(offset);
  const fd = payrollFdRows(offset);
  const total = T.reduce((s, x) => s + (x.cTotal || 0), 0) + fd.rows.reduce((s, r) => s + (r.pay || 0), 0);
  const key = localDateStr(cur.from);
  const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return {
    row: total > 0 ? {
      sourceId: `payroll:${key}`, type: 'payroll', date: localDateStr(cur.to), amountCents: cents(total),
      desc: `Muse — payroll ${fmtD(cur.from)} – ${fmtD(cur.to)}`,
      memo: locked ? 'locked period snapshot' : 'period NOT locked yet — numbers may still change',
    } : null,
    cur, locked, total,
  };
}

// ── Push ──────────────────────────────────────────
async function pushRows(rows) {
  const s = cfg().bo_sync || {};
  const token = localStorage.getItem(TOKEN_KEY) || '';
  if (!s.url || !s.businessId || !token) { showToast('Set the Back Office URL, business id, and sync token first.'); return null; }
  try {
    const r = await fetch(s.url.replace(/\/+$/, '') + '/sync/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ sourceApp: 'musenail', businessId: s.businessId, rows }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(`Back Office rejected the push: ${j.error || r.status}`); return null; }
    return j;
  } catch { showToast('Could not reach Back Office — check the URL / connection.'); return null; }
}

export async function boPushDay() {
  const dateStr = document.getElementById('bosync-date')?.value;
  if (!dateStr) { showToast('Pick a date first.'); return; }
  const { rows } = buildBoDayRows(dateStr);
  if (!rows.length) { showToast('Nothing to push — that day has no sales.'); return; }
  const res = await pushRows(rows);
  if (res) {
    showToast(`Pushed ${rows.length} rows — ${res.created} new, ${res.updated} updated, ${res.skipped} already there.`);
    window.logAudit?.('Back Office', `Pushed ${dateStr} (${rows.length} rows: ${res.created} new / ${res.updated} updated / ${res.skipped} skipped)`);
  }
}

export async function boPushPayroll(offset) {
  const { row, locked } = buildBoPayrollRow(offset);
  if (!row) { showToast('No payroll for that period.'); return; }
  if (!locked && !confirm('This pay period is NOT locked — the numbers can still change. Push anyway?')) return;
  const res = await pushRows([row]);
  if (res) {
    showToast(res.created ? 'Payroll period pushed.' : res.updated ? 'Payroll period updated in Back Office.' : 'Already in Back Office (approved rows are never overwritten).');
    window.logAudit?.('Back Office', `Pushed payroll ${row.sourceId}`);
  }
}

// ── Settings card (Integrations → Back Office sync) ─────────────────────────────
export function saveBoSyncSettings() {
  const url = document.getElementById('bosync-url')?.value.trim() || '';
  const businessId = document.getElementById('bosync-biz')?.value.trim() || '';
  const token = document.getElementById('bosync-token')?.value.trim() || '';
  dispatch('config.set', { key: 'bo_sync', value: { url, businessId } });
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
  showToast('Back Office sync settings saved');
  renderBoSyncSettings();
}

export function renderBoSyncSettings() {
  const el = document.getElementById('bosync-section'); if (!el) return;
  const s = cfg().bo_sync || {};
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const yesterday = localDateStr(new Date(Date.now() - 86400000));
  const ready = s.url && s.businessId && token;
  const lbl = 'text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1';
  const input = 'w-full px-3 py-2 rounded-xl border border-surface-container-high bg-surface-container-lowest text-sm font-body text-on-surface';
  el.innerHTML = `
    <p class="text-sm font-body text-on-surface-variant mb-3">Push finalized daily sales (and locked payroll periods) to the Back Office books app. Rows land there for review — nothing posts to the ledger until they're approved over there, and Back Office can never change anything here.</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
      <div><label class="${lbl}">Back Office Worker URL</label><input id="bosync-url" class="${input}" placeholder="https://backoffice….workers.dev" value="${(s.url || '').replace(/"/g, '&quot;')}"></div>
      <div><label class="${lbl}">Business id</label><input id="bosync-biz" class="${input}" placeholder="muse-nails-spa" value="${(s.businessId || '').replace(/"/g, '&quot;')}"></div>
    </div>
    <label class="${lbl}">Sync token (this device only — matches the Worker's SYNC_TOKEN secret)</label>
    <div class="flex gap-2 mb-4">
      <input id="bosync-token" type="password" autocomplete="off" class="flex-1 ${input}" placeholder="${token ? '••••••• (saved)' : 'Paste the sync token'}" value="${token.replace(/"/g, '&quot;')}">
      <button onclick="saveBoSyncSettings()" class="btn-primary px-4 py-2 rounded-xl font-body font-bold text-sm">Save</button>
    </div>
    <label class="${lbl}">Push a day's sales</label>
    <div class="flex gap-2 items-center mb-3 flex-wrap">
      <input id="bosync-date" type="date" class="${input}" style="max-width:170px" value="${yesterday}" max="${localDateStr(new Date())}">
      <button onclick="boPushDay()" ${ready ? '' : 'disabled'} class="btn-secondary text-sm ${ready ? '' : 'opacity-50'}">Push day to Back Office</button>
    </div>
    <label class="${lbl}">Push a payroll period</label>
    <div class="flex gap-2 items-center flex-wrap">
      <button onclick="boPushPayroll(-1)" ${ready ? '' : 'disabled'} class="btn-secondary text-sm ${ready ? '' : 'opacity-50'}">Last period</button>
      <button onclick="boPushPayroll(0)" ${ready ? '' : 'disabled'} class="btn-secondary text-sm ${ready ? '' : 'opacity-50'}">Current period</button>
      <span class="text-xs font-body text-on-surface-variant">Lock the period first so the snapshot is final.</span>
    </div>`;
}
