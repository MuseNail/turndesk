// ── 80mm thermal receipt printing (Rongta RP327) ────────────────────────────
// Self-contained print documents sized for the 80mm receipt roll (72mm print
// area). No Worker change: we render a standalone HTML doc and hand it to the
// browser's print dialog, which the Windows driver sends to the RP327.
// The app's other printouts (payroll / reports) stay letter-size; this is the
// receipt-roll path only.
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { ticketTotal, escHtml, showToast } from '../utils.js';
import { REVIEW_REDIRECT } from '../config.js';
import { REVIEW_QR_DATAURL } from './review-qr.js';
import { setLogo } from './photos.js';

const cfg = () => getState().config;
const records = () => getState().records;
const queue   = () => getState().queue;
const svc = id => (cfg().services || []).find(s => s.id === id);
const staffById = id => (cfg().staff || []).find(s => s.id === id);

// Per-salon business identity (Settings → Business), printed on every receipt.
// Falls back to empty so a receipt can never print another salon's name.
function biz() {
  const b = cfg().business || {};
  return { name: (b.name || '').trim(), addr: (b.address || '').trim(), phone: (b.phone || '').trim() };
}
// Review QR — permanent (encodes the Worker /r redirect), embedded as a data URL
// so it loads instantly in the print doc. Re-route it from Settings.
export const SHOP = { reviewQr: REVIEW_QR_DATAURL };

const money = n => '$' + Number(n || 0).toFixed(2);

// Shared CSS for an 80mm roll. The @page size makes the driver cut to content
// length; the body width pins the column to the 72mm print area.
const RECEIPT_CSS = `
  @page{size:80mm auto;margin:0}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{width:72mm;margin:0 auto;padding:3mm 2mm 5mm;
    font-family:'Courier New',ui-monospace,monospace;font-size:13px;line-height:1.4;color:#000;font-weight:700}
  .ctr{text-align:center}
  .logo-img{max-width:40mm;max-height:18mm;object-fit:contain;display:block;margin:0 auto 2px}
  .name{font-family:Arial,Helvetica,sans-serif;font-weight:900;font-size:16px;letter-spacing:.4px;margin:1px 0}
  .meta{font-size:12px}
  .dash{border-top:1px solid #000;margin:6px 0}
  .dot{border-top:1px dotted #000;margin:5px 0}
  .row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .row .r{font-variant-numeric:tabular-nums;white-space:nowrap}
  .sub{color:#000;font-size:12px;padding-left:6px}
  .big{font-weight:900;font-size:15px}
  .foot{text-align:center;margin-top:8px;font-size:12px;line-height:1.5}
  .qr{width:30mm;height:30mm;margin:6px auto 0;display:block}`;

// Open the print document. New tab + a short delay so styles/images settle
// before the dialog fires (same pattern as the payroll/report PDFs).
function printReceiptDoc(bodyHtml, title) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title || 'Receipt')}</title><style>${RECEIPT_CSS}</style></head><body>${bodyHtml}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (w) setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 500);
  else showToast('Allow pop-ups to print the receipt.');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function shopHeader() {
  const logo = cfg().logo || '';
  const b = biz();
  return `<div class="ctr">
    ${logo ? `<img class="logo-img" src="${escHtml(logo)}" alt="">` : ''}
    ${b.name ? `<div class="name">${escHtml(b.name)}</div>` : ''}
    ${b.addr ? `<div class="meta">${escHtml(b.addr)}</div>` : ''}
    ${b.phone ? `<div class="meta">${escHtml(b.phone)}</div>` : ''}
  </div>`;
}

const row = (l, r, cls = '') => `<div class="row ${cls}"><span>${l}</span><span class="r">${r}</span></div>`;

// Print a customer receipt for one transaction record (or a queued ticket).
export function printCustomerReceipt(recordId) {
  const r = records().find(x => String(x.id) === String(recordId))
         || queue().find(x => String(x.id) === String(recordId));
  if (!r) { showToast('Could not find that transaction.'); return; }
  if (r.status === 'refund') { showToast('Refunds reprint from the original sale.'); return; }

  const dt = new Date(r.checkinTime || r.completedAt || Date.now());
  const when = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
             + ' · ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Privacy: receipts show the first name only — never the last name or phone.
  const firstName = (r.name || 'Guest').trim().split(/\s+/)[0] || 'Guest';
  // Charge breakdown (per-line services/items/fees) is OFF by default — receipts show
  // the total + how they paid only. Owner can opt back in via Settings → Receipt & Reviews.
  const showBreakdown = cfg().receipt_breakdown === true;

  // Line items — services (→ tech), items × qty, fees (skip $0).
  let body = '';
  (r.assignments || []).filter(a => a.cost || a.comped).forEach(a => {
    const label = svc(a.serviceId)?.label || 'Service';
    const tech = staffById(a.techId)?.name;
    if (a.comped) { body += row(escHtml(label), 'Comp'); }
    else { body += row(escHtml(label), money(a.cost)); }
    if (tech) body += `<div class="sub">↳ ${escHtml(tech)}</div>`;
  });
  (r.items || []).filter(i => (i.qty || 0) > 0).forEach(i => {
    body += row(escHtml(i.name || 'Item') + ((i.qty || 1) > 1 ? '  ×' + i.qty : ''), money((i.price || 0) * (i.qty || 0)));
  });
  (r.fees || []).filter(f => (f.amount || 0) > 0).forEach(f => {
    body += row(escHtml(f.name || 'Fee'), money(f.amount));
  });

  // Money — same source of truth as the rest of the app.
  const svcTot   = (r.assignments || []).reduce((s, a) => s + (a.cost || 0), 0);
  const itemsTot = (r.items || []).reduce((s, i) => s + ((i.price || 0) * (i.qty || 0)), 0);
  const feesTot  = (r.fees || []).reduce((s, f) => s + (f.amount || 0), 0);
  const subtotal = svcTot + itemsTot + feesTot;
  const total    = ticketTotal(r);
  const tip      = r.tip || 0;

  let totals = '';
  if ((r.discount || 0) > 0) {
    totals += row('Subtotal', money(subtotal), 'sub');
    totals += row('Discount', '-' + money(r.discount), 'sub');
  }
  totals += `<div class="dot"></div>` + row('Total', money(total), 'big');
  if (tip > 0) { totals += row('Tip', money(tip)); totals += row('Grand total', money(total + tip), 'big'); }

  // Tenders — fall back to the group's primary ticket for split parties.
  let tenders = r.tenders;
  if (!tenders && r.groupId) tenders = records().find(x => x.groupId === r.groupId && x.tenders)?.tenders;
  let pay = '';
  if (tenders) {
    [['Cash', tenders.cash], ['Card', tenders.card], ['Gift card', tenders.gift], ['Zelle', tenders.zelle]]
      .forEach(([l, v]) => { if (v > 0) pay += row('Paid · ' + l, money(v), 'sub'); });
    if (tenders.cashReceived > 0 && tenders.change > 0) {
      pay += row('Cash received', money(tenders.cashReceived), 'sub');
      pay += row('Change', money(tenders.change), 'sub');
    }
  }

  const ticketNo = r.id ? '#' + String(r.id).slice(-4) : '';
  // Only print the QR once a destination is set in Settings — otherwise /r 404s.
  const qr = (SHOP.reviewQr && cfg().review_url)
    ? `<img class="qr" src="${escHtml(SHOP.reviewQr)}" alt="" onerror="this.style.display='none'"><div style="font-size:10px;margin-top:3px">★ Leave us a review ★</div>`
    : '';

  printReceiptDoc(`
    ${shopHeader()}
    <div class="dash"></div>
    <div class="row"><span>${escHtml(when)}</span><span class="r">${ticketNo}</span></div>
    <div class="row"><span>${escHtml(firstName)}</span><span class="r"></span></div>
    <div class="dash"></div>
    ${showBreakdown ? `${body || row('—', '')}<div class="dash"></div>` : ''}
    ${totals}
    ${pay ? `<div class="dot"></div>${pay}` : ''}
    <div class="dash"></div>
    <div class="foot">${biz().name ? 'Thank you for visiting<br>' + escHtml(biz().name) + '!' : 'Thank you!'}${qr}</div>
  `, 'Receipt — ' + firstName);
}

// Print one 80mm strip per tech (billed-by-day + total) for a pay period —
// the receipt-roll version of the letter-size "Print staff receipts" sheet.
// `techRows` = [{ name, period, days:[[label, billed], ...], total, refund }]
export function printTechReceipts80(techRows) {
  if (!techRows || !techRows.length) { showToast('No billing to print.'); return; }
  const strips = techRows.map((t, i) => {
    const rows = t.days.map(([d, v]) => row(escHtml(d), money(v))).join('');
    const rf = t.refund
      ? row('Refunds', '-' + money(Math.abs(t.refund)), 'sub') + row('Net', money(t.total - Math.abs(t.refund)), 'big')
      : '';
    return `<div${i ? ' style="page-break-before:always"' : ''}>
      <div class="ctr">
        <div class="name">${escHtml(biz().name)}</div>
        <div class="meta">${escHtml(t.name)}</div>
        <div class="meta">${escHtml(t.period)}</div>
      </div>
      <div class="dash"></div>
      ${rows}
      <div class="dash"></div>
      ${row('Total', money(t.total), 'big')}
      ${rf}
    </div>`;
  }).join('');
  printReceiptDoc(strips, 'Staff billing');
}

// ── Settings: business profile (name / address / phone) ──────────────────────
// Per-salon identity: name shows on the welcome/check-in screens (via
// photos.setLogo) + prints on receipts; address/phone print on receipts. Synced
// config key `business`. Replaces the old hardcoded Muse SHOP constant.
export function renderBusinessProfile() {
  const el = document.getElementById('bizprofile-section'); if (!el) return;
  const b = cfg().business || {};
  const lbl = 'text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1';
  const input = 'w-full px-3 py-2 rounded-xl border border-surface-container-high bg-surface-container-lowest text-sm font-body text-on-surface';
  const v = s => escHtml(s || '').replace(/"/g, '&quot;');
  el.innerHTML = `
    <p class="text-sm font-body text-on-surface-variant mb-3">Your salon's name shows on the customer welcome &amp; check-in screens and prints on receipts. Address and phone print on receipts only.</p>
    <label class="${lbl}">Business name</label>
    <input id="biz-name" class="${input} mb-3" placeholder="e.g. Krystal Nails Lounge" value="${v(b.name)}">
    <label class="${lbl}">Address</label>
    <input id="biz-address" class="${input} mb-3" placeholder="123 Main St, City, ST 00000" value="${v(b.address)}">
    <label class="${lbl}">Phone</label>
    <input id="biz-phone" class="${input} mb-3" placeholder="(000) 000-0000" value="${v(b.phone)}">
    <button onclick="saveBusinessProfile()" class="btn-primary px-4 py-2 rounded-xl font-body font-bold text-sm">Save</button>`;
}
export function saveBusinessProfile() {
  const g = id => (document.getElementById(id)?.value || '').trim();
  dispatch('config.set', { key: 'business', value: { name: g('biz-name'), address: g('biz-address'), phone: g('biz-phone') } });
  setLogo();   // re-render welcome/check-in branding + tab title immediately
  showToast('Business profile saved');
}

// ── Settings: review-QR link ─────────────────────────────────────────────────
// The printed QR encodes REVIEW_REDIRECT forever; this just sets where it lands
// (config.review_url, synced). Change it any time without reprinting receipts.
export function renderReceiptSettings() {
  const el = document.getElementById('receipt-section'); if (!el) return;
  const url = cfg().review_url || '';
  const lbl = 'text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1';
  const input = 'w-full px-3 py-2 rounded-xl border border-surface-container-high bg-surface-container-lowest text-sm font-body text-on-surface';
  el.innerHTML = `
    <div class="flex items-start gap-4 mb-3">
      <img src="${REVIEW_QR_DATAURL}" alt="Review QR" class="w-20 h-20 rounded-lg border border-surface-container-high flex-shrink-0 bg-white p-1">
      <p class="text-sm font-body text-on-surface-variant">The review QR printed on customer receipts is permanent — it points at <span class="font-mono text-xs break-all">${escHtml(REVIEW_REDIRECT)}</span>, which forwards to whatever link you set here. Change the destination any time and even already-printed receipts follow it. The QR only prints once a link is set.</p>
    </div>
    <label class="${lbl}">Review / feedback link</label>
    <div class="flex gap-2 mb-2">
      <input id="review-url" class="flex-1 ${input}" placeholder="https://g.page/r/…/review" value="${escHtml(url).replace(/"/g, '&quot;')}">
      <button onclick="saveReceiptSettings()" class="btn-primary px-4 py-2 rounded-xl font-body font-bold text-sm">Save</button>
    </div>
    <div class="flex items-center gap-3">
      <a href="${escHtml(REVIEW_REDIRECT)}" target="_blank" rel="noopener" class="text-xs font-body text-primary font-semibold ${url ? '' : 'opacity-40 pointer-events-none'}">Test the QR link ↗</a>
      <span class="text-xs font-body text-on-surface-variant">${url ? 'QR will print on receipts.' : 'No link set — QR is hidden on receipts.'}</span>
    </div>
    <div class="mt-4 pt-4 border-t border-surface-container-high">
      <label class="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" id="receipt-breakdown" onchange="setReceiptBreakdown(this.checked)" ${cfg().receipt_breakdown === true ? 'checked' : ''} class="w-5 h-5 accent-primary flex-shrink-0">
        <span>
          <span class="text-sm font-body font-semibold text-on-surface block">Show charge breakdown on receipts</span>
          <span class="text-xs font-body text-on-surface-variant">When off, customer receipts print the total only — no per-service / item lines.</span>
        </span>
      </label>
    </div>`;
}
export function setReceiptBreakdown(on) {
  dispatch('config.set', { key: 'receipt_breakdown', value: !!on });
  showToast(on ? 'Charge breakdown will print' : 'Receipts will show total only');
}
export function saveReceiptSettings() {
  const v = (document.getElementById('review-url')?.value || '').trim();
  dispatch('config.set', { key: 'review_url', value: v });
  showToast(v ? 'Review link saved ✓' : 'Review link cleared');
  renderReceiptSettings();
}
