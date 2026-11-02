// ── Guide — printable in-app documentation (Full + Quick reference) ────────────
// Opens a self-contained, print-friendly document in a new tab; "Print / Save as
// PDF" produces the PDF. Kept in code (not a committed binary) so it never drifts
// from the app. Exposed on window via main.js glue for the account-menu buttons.
import { getState } from '../store.js';
import { businessName, escHtml } from '../utils.js';

const STYLE = `
*{box-sizing:border-box}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1c1c1c;max-width:820px;margin:0 auto;padding:0 24px 64px}
.bar{position:sticky;top:0;background:#fff;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #ddd;margin-bottom:14px}
.bar button{background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}
h1{font-size:25px;margin:14px 0 2px}
h2{font-size:19px;margin:26px 0 6px;border-bottom:2px solid #eee;padding-bottom:4px}
h3{font-size:15.5px;margin:16px 0 3px}
p{margin:6px 0}ul,ol{margin:5px 0 5px 20px;padding:0}li{margin:3px 0}
.sub{color:#666;font-size:13px;margin-top:0}
code{background:#f1f1f1;border-radius:4px;padding:1px 5px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{border:1px solid #dcdcdc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7}
.step{background:#f7f5fe;border:1px solid #e2d9f7;border-radius:8px;padding:10px 14px;margin:8px 0}
.sw{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:6px;border:1px solid rgba(0,0,0,.15)}
.tag{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:700}
@media print{.bar{display:none}body{max-width:none;padding:0}}
@page{margin:1.4cm}
`;

function openDoc(title, html) {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to open the guide.'); return; }
  w.document.write(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>${STYLE}</style></head><body>` +
    `<div class="bar"><strong>${title}</strong><button onclick="window.print()">Print / Save as PDF</button></div>` +
    html + `</body></html>`);
  w.document.close();
}

export function openAppGuide() { openDoc('TurnDesk — App Guide', FULL); }
export function openAppQuickRef() { openDoc('TurnDesk — Quick Reference', QUICK); }

// ── Customer Price Menu — editable, tiered, print-friendly (ported from Muse) ──
// The menu is DATA (config.price_menu), edited in Settings → Price Menu and rendered by a pure
// priceMenuToHtml into a print-friendly two-page doc. A service can carry pick-one `variants` and/or
// stackable `addons`, rendered indented. Owner text is stored DECODED and escaped exactly once on
// render — the doc is document.write-n into a new tab, so escaping is the whole XSS defense.
// Multi-tenant: the header is the salon's businessName() (no hardcoded logo), and a salon that hasn't
// built a menu yet gets a GENERIC nail-salon starter (DEFAULT_PRICE_MENU) to edit — never another
// salon's prices. normalizePriceMenu hardens the read path so a malformed/partial/empty synced config
// can never throw or blank the customer-facing menu.
const PRICE_MENU_STYLE = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
@page{size:Letter;margin:0}
body{font-family:'Jost',sans-serif;color:#1a1a1a;background:#e9e6df}
.bar{position:sticky;top:0;z-index:5;background:#fff;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid #ddd}
.bar strong{font-size:14px;letter-spacing:1px}
.bar button{background:#1a5252;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}
.page{width:8.5in;height:11in;padding:0.22in 0.6in 0.3in;background:#ffffff;margin:18px auto;box-shadow:0 4px 18px rgba(0,0,0,.16);display:flex;flex-direction:column;overflow:hidden}
.phead{display:flex;align-items:center;gap:0.2in;border-bottom:1px solid #cccccc;padding-bottom:0.1in}
.pm-wordmark{font-family:'Cormorant Garamond',serif;font-weight:700;font-size:23px;letter-spacing:1px;color:#1a5252;width:1.7in;flex-shrink:0;line-height:1.1}
.phead-sp{width:1.7in;flex-shrink:0}
.pagetitle{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:25px;color:#1a1a1a;text-align:center;margin:0;flex:1}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 0.55in;margin-top:0.16in;flex:1}
.sec{font-family:'Cormorant Garamond',serif;font-weight:700;font-size:19px;letter-spacing:3px;color:#1a5252;text-transform:uppercase;margin:15px 0 7px;display:flex;align-items:center;gap:9px}
.col>.sec:first-child{margin-top:0}
.sec::after{content:"";flex:1;border-bottom:1px solid #cccccc}
.row{display:flex;align-items:baseline;gap:7px;margin:5px 0}
.nm{font-size:15.5px;font-weight:400;color:#1a1a1a}
.dots{flex:1;border-bottom:1px dotted #cccccc;transform:translateY(-4px)}
.pr{font-size:13.5px;font-weight:500;color:#1a5252;white-space:nowrap}
.desc{font-size:12px;color:#1a1a1a;font-style:italic;margin:-2px 0 4px;white-space:pre-line}
.sec+.desc{margin-top:0}
.subhead{font-family:'Cormorant Garamond',serif;font-weight:600;font-size:14.5px;letter-spacing:1px;color:#2a6d6a;margin:9px 0 3px 0.08in}
.choose{font-size:11px;font-style:italic;color:#8a8a8a;margin:2px 0 1px 0.16in}
.subrow,.addon{display:flex;align-items:baseline;gap:7px;margin:3px 0 3px 0.16in}
.subrow .nm,.addon .nm{font-size:13.5px;color:#444444}
.subrow .pr,.addon .pr{font-size:13.5px;font-weight:500;color:#1a5252;white-space:nowrap}
.subrow .dots,.addon .dots{flex:1;border-bottom:1px dotted #d8d8d8;transform:translateY(-3px)}
.subrow+.desc,.addon+.desc{margin-left:0.16in}
.foot{margin-top:0.16in;border-top:1px solid #cccccc;padding-top:0.12in}
.foot p{margin:6px 0;font-size:12.5px;line-height:1.5;text-align:center;color:#1a1a1a}
.foot .cash{font-weight:500;color:#1a5252}
.foot .fix{font-size:11.5px;color:#1a1a1a;font-style:italic}
@media print{.bar{display:none}body{background:#fff}.page{margin:0;box-shadow:none}}
`;

// ── Price-menu data model + render ────────────────────────────────────────────
// Owner text is stored DECODED (real "&", real non-breaking spaces) and escaped exactly once on
// render — the doc is document.write-n into a new tab, so escaping is the whole XSS defense. A service
// can carry pick-one `variants` and/or stackable `addons`, rendered indented.
const NB = ' ';   // non-breaking space (the "set / fill" spacer)
// Generic nail-salon STARTER — a brand-neutral sample every salon edits in Settings → Price Menu.
// It is NOT any real salon's prices; it exists only so a salon that hasn't built a menu sees a
// sensible, editable shape rather than a blank page.
export const DEFAULT_PRICE_MENU = { v: 1, pages: [
  { title: 'Hand Services', cols: [
    [
      { t: 'sec', label: 'Manicures' },
      { t: 'row', nm: 'Classic Manicure', pr: '$25' },
      { t: 'row', nm: 'Gel Manicure', pr: '$35' },
      { t: 'row', nm: 'Deluxe Manicure', pr: '$45', desc: 'scrub, mask & hot towel' },
      { t: 'sec', label: 'Full Sets & Fills', desc: 'set / fill' },
      { t: 'row', nm: 'Acrylic', pr: '$55 / 45' },
      { t: 'row', nm: 'Dip Powder', pr: '$50' },
      { t: 'row', nm: 'Gel-X', pr: '$65 / 55' },
    ],
    [
      { t: 'sec', label: 'Color & Add-Ons' },
      { t: 'row', nm: 'Regular Polish Change', pr: '$15' },
      { t: 'row', nm: 'Gel Color Change', pr: '$25' },
      { t: 'row', nm: 'Nail Art', pr: 'from $5' },
      { t: 'row', nm: 'French Tip', pr: 'from $7' },
      { t: 'row', nm: 'Gel Removal', pr: '$10' },
    ],
  ], foot: [
    { text: 'Prices vary by length, shape, design & add-ons — for an exact quote, please ask your technician before your service begins.' },
    { text: 'This is a sample menu. Edit it in Settings → Price Menu to match your salon.', cls: 'fix' },
  ] },
  { title: 'Foot Services & Waxing', cols: [
    [
      { t: 'sec', label: 'Pedicures' },
      { t: 'row', nm: 'Classic Pedicure', pr: '$33' },
      { t: 'row', nm: 'Spa Pedicure', pr: '$45' },
      { t: 'row', nm: 'Deluxe Pedicure', pr: '$60', desc: 'scrub, mask, paraffin & extended massage' },
      { t: 'sec', label: 'Pedicure Add-Ons' },
      { t: 'row', nm: 'Gel Polish', pr: '$13' },
      { t: 'row', nm: 'Callus Treatment', pr: '$7' },
    ],
    [
      { t: 'sec', label: 'Waxing' },
      { t: 'row', nm: 'Eyebrows', pr: '$15' },
      { t: 'row', nm: 'Lip or Chin', pr: '$10' },
      { t: 'row', nm: 'Underarms', pr: '$20' },
      { t: 'row', nm: 'Half / Full Leg', pr: '$40 / 60' },
    ],
  ], foot: [
    { text: 'Prices vary by length, shape, design & add-ons — for an exact quote, please ask your technician before your service begins.' },
  ] },
] };

const _WL_CLS = new Set(['', 'cash', 'fix']);
let _pmc = 0;
const _pmUid = () => 'pm' + (++_pmc) + Math.random().toString(36).slice(2, 6);
const _str = v => String(v == null ? '' : v);
function _normSub(v) { return (v && typeof v === 'object') ? { id: v.id || _pmUid(), nm: _str(v.nm), pr: _str(v.pr), ...(v.desc != null ? { desc: _str(v.desc) } : {}) } : null; }
function _normItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.t === 'sec') return { id: it.id || _pmUid(), t: 'sec', label: _str(it.label), ...(it.desc != null ? { desc: _str(it.desc) } : {}) };
  if (it.t === 'sub') return { id: it.id || _pmUid(), t: 'sub', label: _str(it.label) };   // subheader: a secondary heading under a section
  if (it.t === 'row') {
    const row = { id: it.id || _pmUid(), t: 'row', nm: _str(it.nm), pr: _str(it.pr), ...(it.desc != null ? { desc: _str(it.desc) } : {}) };
    const vs = (Array.isArray(it.variants) ? it.variants : []).map(_normSub).filter(Boolean); if (vs.length) row.variants = vs;
    const as = (Array.isArray(it.addons) ? it.addons : []).map(_normSub).filter(Boolean); if (as.length) row.addons = as;
    return row;
  }
  return null;   // unknown item type → drop
}
function _normPages(pages) {
  return pages.map(p => ({
    id: (p && p.id) || _pmUid(),   // pages + foot lines carry ids too, so the editor can address EVERYTHING by id
    title: _str(p && p.title),
    cols: (Array.isArray(p && p.cols) ? p.cols : []).map(col => (Array.isArray(col) ? col : []).map(_normItem).filter(Boolean)),
    foot: (Array.isArray(p && p.foot) ? p.foot : []).map(f => (f && typeof f === 'object') ? { id: f.id || _pmUid(), text: _str(f.text), cls: _WL_CLS.has(f.cls) ? f.cls : '' } : null).filter(Boolean),
  }));
}
// Return a valid, id-stamped menu — NEVER throw and never let a malformed/partial/stale synced
// config.price_menu blank the customer-facing menu. Falls back to the default for anything that
// isn't a well-formed { pages: [...] }; coerces junk nodes per-field; backfills missing ids.
export function normalizePriceMenu(stored, opts) {
  const src = (stored && Array.isArray(stored.pages) && stored.pages.length) ? stored : DEFAULT_PRICE_MENU;
  let pages;
  try { pages = _normPages(src.pages); } catch { pages = _normPages(DEFAULT_PRICE_MENU.pages); }
  if (opts && opts.allowEmpty) return { v: 1, pages };   // preview renders the LITERAL draft, even mid-build
  // A structurally-valid but CONTENT-empty config would render blank customer-facing pages — the one
  // thing this function promises can't happen. Fall back to the default whenever nothing renders.
  if (!pages.some(p => (p.cols || []).some(c => c.length))) pages = _normPages(DEFAULT_PRICE_MENU.pages);
  return { v: 1, pages };
}

// Desk "how much is X?" lookup: flatten the menu into { label, price, section } matches for a query.
// A matching service returns itself + its variants/add-ons; a variant/add-on is also findable by its
// own name even when the parent doesn't match. Pure + tolerant of a malformed menu.
export function priceMenuSearch(menu, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase(); if (!q) return [];
  const hit = s => String(s == null ? '' : s).toLowerCase().includes(q);
  const out = [];
  for (const p of (menu && menu.pages) || []) {
    let section = '';
    for (const col of (p && p.cols) || []) {
      for (const it of (col || [])) {
        if (!it) continue;
        if (it.t === 'sec') { section = it.label || ''; continue; }
        if (it.t !== 'row') continue;
        if (hit(it.nm)) {   // service name matches → show it + all its tiers
          out.push({ label: it.nm || '', price: it.pr || '', section });
          for (const v of (it.variants || [])) out.push({ label: (it.nm || '') + ' · ' + (v.nm || ''), price: v.pr || '', section });
          for (const a of (it.addons || [])) out.push({ label: '+ ' + (a.nm || ''), price: a.pr || '', section: it.nm || '' });
        } else {            // otherwise match a tier by its own name
          for (const v of (it.variants || [])) if (hit(v.nm)) out.push({ label: (it.nm || '') + ' · ' + (v.nm || ''), price: v.pr || '', section });
          for (const a of (it.addons || [])) if (hit(a.nm)) out.push({ label: '+ ' + (a.nm || '') + ' (' + (it.nm || '') + ')', price: a.pr || '', section });
        }
      }
    }
  }
  return out;
}

// Pure renderer: data → the menu's page sections (no getState inside; menu + escaper passed in).
export function priceMenuToHtml(menu, logoTag, esc) {
  const e = typeof esc === 'function' ? esc : (s => _str(s));
  const sub = (cls, prefix, v) => `<div class="${cls}"><span class="nm">${prefix}${e(v.nm)}</span><span class="dots"></span><span class="pr">${e(v.pr)}</span></div>` + (v.desc ? `<div class="desc">${e(v.desc)}</div>` : '');
  const itemHtml = it => {
    if (!it) return '';                                 // self-safe even if handed un-normalized data
    if (it.t === 'sec') return `<div class="sec">${e(it.label)}</div>` + (it.desc ? `<div class="desc">${e(it.desc)}</div>` : '');
    if (it.t === 'sub') return `<div class="subhead">${e(it.label)}</div>`;   // secondary heading under a section
    if (it.t !== 'row') return '';                      // unknown node type → render nothing (not "undefined")
    let h = `<div class="row"><span class="nm">${e(it.nm)}</span><span class="dots"></span><span class="pr">${e(it.pr)}</span></div>` + (it.desc ? `<div class="desc">${e(it.desc)}</div>` : '');
    if (it.variants && it.variants.length) h += it.variants.map(v => sub('subrow', '', v)).join('');
    if (it.addons && it.addons.length) h += it.addons.map(a => sub('addon', '+ ', a)).join('');
    return h;
  };
  const colHtml = col => `<div class="col">${(col || []).map(itemHtml).join('')}</div>`;
  const footHtml = foot => (foot && foot.length) ? `<div class="foot">${foot.map(f => { const c = _WL_CLS.has(f.cls) ? f.cls : ''; return `<p${c ? ` class="${c}"` : ''}>${e(f.text)}</p>`; }).join('')}</div>` : '';
  return (menu.pages || []).map(p =>
    `<section class="page"><div class="phead">${logoTag}<div class="pagetitle">${e(p.title)}</div><div class="phead-sp"></div></div><div class="cols">${(p.cols || []).map(colHtml).join('')}</div>${footHtml(p.foot)}</section>`
  ).join('');
}

export function openPriceMenu() {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to open the price menu.'); return; }
  w.document.write(priceMenuDoc());
  w.document.close();
}
// menuOverride (optional) renders that menu instead of the live config — used by the editor preview,
// which passes the unsaved DRAFT and renders it literally (allowEmpty) so a half-built menu shows as-is.
// A preview also gets a per-page overflow banner (accurate — measured with the real print fonts).
function priceMenuDoc(menuOverride) {
  const name = businessName() || 'Our Salon';
  const logo = `<div class="pm-wordmark">${escHtml(name)}</div>`;
  const preview = menuOverride != null;
  let body;
  try {
    const menu = preview ? normalizePriceMenu(menuOverride, { allowEmpty: true }) : normalizePriceMenu(getState().config.price_menu);
    body = priceMenuToHtml(menu, logo, escHtml);
  } catch { try { body = priceMenuToHtml(normalizePriceMenu(null), logo, escHtml); } catch { body = ''; } }
  const overflowScript = preview ? `<script>addEventListener('load',function(){document.querySelectorAll('.page').forEach(function(pg){if(pg.scrollHeight>pg.clientHeight+2){var b=document.createElement('div');b.textContent='⚠ This page is longer than one printed sheet — some items may be cut off when printed.';b.style.cssText='background:#fdecec;color:#8a2b2b;font-size:12px;padding:6px 12px;text-align:center;font-family:sans-serif';pg.parentNode.insertBefore(b,pg);}});});<\/script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(name)} — Price Menu${preview ? ' (preview)' : ''}</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">` +
    `<style>${PRICE_MENU_STYLE}</style></head><body>` +
    `<div class="bar"><strong>${escHtml(name.toUpperCase())} · PRICE MENU${preview ? ' · PREVIEW' : ''}</strong><button onclick="window.print()">Print / Save as PDF</button></div>` +
    body + overflowScript +
    `</body></html>`;
}
// Open the editor's unsaved DRAFT in a single reused tab (named window) — not the live menu.
export function openPriceMenuPreview(menu) {
  const w = window.open('', 'td-price-preview');
  if (!w) { alert('Please allow pop-ups for this site to open the preview.'); return; }
  w.document.open(); w.document.write(priceMenuDoc(menu)); w.document.close(); try { w.focus(); } catch {}
}

// ── Full guide — the detailed manual: every screen, button, symbol, and color ──
const FULL = `
<h1>TurnDesk — App Guide</h1>
<p class="sub">The complete manual for the salon front-desk app: what every screen does, what each button does when you tap it, what every symbol and color means, and how text fields behave. The app runs on the front-desk iPad and on technician devices and syncs live across all of them.</p>

<h2>How to read the screen</h2>

<h3>Symbols &amp; icons</h3>
<table>
<tr><th>Symbol</th><th>Where</th><th>Meaning &amp; what tapping it does</th></tr>
<tr><td><code>↻</code> next to the version number</td><td>Top of the screen, on the version badge</td><td>An update is ready. <strong>Tap it</strong> to reload fresh (it signs the device out of the old cached files, clears the cache, and reloads so every file comes from the network). Tapping the version badge <em>any</em> time — with or without the <code>↻</code> — reopens <strong>What's new</strong>. If a screen ever looks stuck or stale, tapping here is the fix.</td></tr>
<tr><td>A small <strong>colored dot</strong></td><td>On every Queue, Turns, and Floor card, one per service</td><td>The service's status. The dot is a drawn circle (always the same size) so colors stay easy to compare. See the color table below.</td></tr>
<tr><td>A <strong>number</strong> on the top-right of a card</td><td>Queue / Turns cards</td><td>That customer's <strong>turn number</strong> — their place in the rotation. Not a button.</td></tr>
<tr><td>A small <strong>amber box</strong></td><td>Turns cards</td><td>This service counts as a <strong>half turn</strong> (a short/quick service) rather than a full turn, so rotation stays fair. Full turns show no box.</td></tr>
<tr><td>Outline line-icons</td><td>Nav and buttons (calendar, search, etc.)</td><td>Decorative labels for the button next to them — they do whatever their button says.</td></tr>
</table>

<h3>Color codes — the status system</h3>
<p>Every service shows its status with <strong>three cues at once</strong> — a colored dot, a text pill, and a row accent — so the floor can read state at a glance, and so it's clear even if you're color-blind. The flow is <strong>Waiting → In Service → Done → Paid</strong>.</p>
<table>
<tr><th>Color</th><th>Pill</th><th>Means</th></tr>
<tr><td><span class="sw" style="background:#f5c870"></span><strong>Amber</strong></td><td><span class="tag" style="background:#f5c870;color:#3a2800">Waiting</span></td><td>Checked in, service not started yet.</td></tr>
<tr><td><span class="sw" style="background:#2a7a4f"></span><strong>Green</strong></td><td><span class="tag" style="background:#2a7a4f;color:#fff">In Service</span></td><td>Actively being worked on. This is the only status that <strong>highlights the whole row</strong> with a colored bar and a light green tint — "the hot row" — so active work stands out on a busy board.</td></tr>
<tr><td><span class="sw" style="background:#1a5c7a"></span><strong>Blue</strong></td><td><span class="tag" style="background:#1a5c7a;color:#fff">Done</span></td><td>Service finished but <strong>payment not taken yet</strong>. It still counts and the technician has earned the turn — it's just waiting for checkout.</td></tr>
<tr><td><span class="sw" style="background:#8a9298"></span><strong>Slate / gray</strong></td><td><span class="tag" style="background:#5b6166;color:#fff">Paid</span></td><td>Sale finalized and recorded in Reports. The row <strong>fades</strong> and leaves the floor.</td></tr>
</table>
<p class="sub">Tip: a ticket can have several services at once, each with its own dot — so one card may show a mix (e.g. one service In Service, another still Waiting).</p>

<h3>Text fields &amp; formatting</h3>
<p>The app has free-text fields — customer notes (kept per phone number), the per-ticket memo/note, service and item names, etc. <strong>None of them use Markdown or any rich-text formatting.</strong> Whatever you type is stored and shown exactly as typed, as plain text, so symbols like <code>*</code>, <code>#</code>, or <code>**</code> appear literally rather than turning into bold or headings. Type normal words and numbers.</p>

<h2>The day in one line</h2>
<div class="step">Customer <strong>checks in</strong> → appears in the <strong>Queue</strong> → you <strong>Assign &amp; Price</strong> a technician and services → the service moves through its <strong>status</strong> (Waiting → In Service → Done) → <strong>Pay</strong> (cash, card, gift card, tips) → it becomes <strong>Paid</strong> and lands in <strong>Reports</strong>. <strong>Turns</strong> keeps rotation fair; the <strong>cash drawer</strong> is opened and closed each day.</div>

<h2>Header &amp; your account</h2>
<ul>
<li><strong>Your name (top-right)</strong> — tap it for your account menu: <strong>Clock in / out</strong>, <strong>App guide</strong> and <strong>Quick reference</strong> (this document and the short one, both printable to PDF), <strong>What's new</strong>, and <strong>Log out</strong>.</li>
<li><strong>Version badge</strong> — shows the app version; doubles as the reload/What's-new button (see the symbols table for <code>↻</code>).</li>
<li><strong>Search box</strong> — type a name or number to jump to a customer or a past ticket.</li>
</ul>

<h2>Check-in</h2>
<ul>
<li>Customers check themselves in at the kiosk, or you check them in from the front desk.</li>
<li><strong>Returning customers</strong> are matched by <strong>phone number</strong>; <strong>new</strong> customers are added to the directory on the spot.</li>
<li>Once checked in, the customer drops into the <strong>Queue</strong> as <strong>Waiting</strong> (amber).</li>
</ul>

<h2>Queue &amp; Assign &amp; Price</h2>
<ul>
<li>The <strong>Queue</strong> lists everyone Waiting or In Service, each as a card with its status dot/pill and turn number.</li>
<li><strong>Tap a card</strong> to open <strong>Assign &amp; Price</strong>. There you: choose the <strong>technician</strong>; add the <strong>services</strong>; add any <strong>items</strong> (with quantity) and <strong>fees</strong>; and set <strong>tips</strong> and a <strong>discount</strong>. This sets the ticket's price — the single source of truth for what's owed (services + items×qty + fees − discount). The total always reflects the live ticket; nothing is cached.</li>
<li><strong>Cross-device lock:</strong> while someone has a ticket open on another device, that ticket is <strong>locked</strong> so two people can't edit the same one at once. Wait for it to be released, or use the device that holds it.</li>
</ul>

<h2>Status flow (advancing a service)</h2>
<ul>
<li>Each service has a status button on its card. Advancing it moves <strong>Waiting → In Service → Done</strong>; checkout makes it <strong>Paid</strong>.</li>
<li>Starting <strong>In Service</strong> starts that service's work timer; marking <strong>Done</strong> stops it. (Going back to In Service and Done again adds the time correctly.)</li>
<li>If you advance a status by mistake, you can move it back — a correction restores the original timer rather than resetting it.</li>
<li>The same dot/pill/accent appears identically on Queue, Turns, and Floor cards.</li>
</ul>

<h2>Turns (rotation)</h2>
<ul>
<li>Tracks each technician's turn count so work is shared fairly — use it to decide who's "up" next.</li>
<li>A customer's <strong>turn number</strong> shows on the top-right of their card; a <strong>half turn</strong> (short service) shows in a small amber box and counts as half.</li>
<li>History is kept on a rolling window so you can see recent rotation.</li>
</ul>

<h2>Floor plan</h2>
<p>A visual map of the salon's stations with technician avatars. <strong>Drag a technician</strong> onto a station to seat them; each station type has its own capacity (set in Settings → Stations), so it won't let you over-fill a station type. Useful for seeing who's where at a glance.</p>

<h2>Pay / checkout</h2>
<ul>
<li>From a ticket, <strong>Confirm Payment</strong> opens checkout.</li>
<li><strong>Tenders:</strong> choose <strong>cash</strong>, <strong>card</strong>, or <strong>gift card</strong> — and <strong>split</strong> across more than one if needed (e.g. part gift card, part card).</li>
<li><strong>Tips</strong> and a <strong>gift-card redemption</strong> or discount are applied here.</li>
<li><strong>Card payments run on the Helcim Smart Terminal:</strong> confirm the amount in the app, the customer taps/inserts on the terminal, and the app waits for the result and records it automatically.</li>
<li><strong>Mark paid without charging a card</strong> — for cash already taken or an outside payment; it still records the sale.</li>
<li>Once paid, the service turns <strong>Paid</strong> (slate, fades) and the sale lands in Reports.</li>
<li><strong>Reprint a receipt</strong> and <strong>refund</strong> are available from the transaction afterward (see Reports). Card refunds go back to the original card via Helcim.</li>
</ul>

<h2>Quick Sale</h2>
<p>Sell a retail item or a gift card <strong>without</strong> a service ticket — a fast, no-service checkout. Add the item(s) or gift card, take payment the same way as a normal ticket.</p>

<h2>Customers</h2>
<ul>
<li>The <strong>Customers</strong> tab is your directory and the app is the source of truth for it.</li>
<li><strong>Search</strong> by name/number; <strong>add</strong> or <strong>edit</strong> a customer; <strong>delete</strong>; <strong>de-dup</strong> (merge duplicates); <strong>import</strong> a list; and keep per-customer <strong>notes</strong> (tied to the phone number, plain text).</li>
</ul>

<h2>Gift cards</h2>
<p>Sell gift cards (paid by cash or card) and <strong>redeem</strong> them at checkout by choosing gift card as a tender. Balances are tracked in the app.</p>

<h2>Cash register / drawer</h2>
<ul>
<li><strong>Open</strong> the drawer at the start of the day with a starting count.</li>
<li>Record <strong>cash in / cash out</strong> during the day as needed (pay-outs, drops, etc.).</li>
<li><strong>Close</strong> the drawer with a counted total; the app reconciles it against the expected cash and records <strong>over/short</strong> (which also pushes to Back Office). A <strong>PDF</strong> summary is available.</li>
</ul>

<h2>Appointments (calendar)</h2>
<p>Appointments are backed by <strong>Google Calendar</strong> and shown in the app. You can adjust the visible <strong>columns</strong> and <strong>display hours</strong>. <strong>Appointment reminders</strong> can be sent to customers by text.</p>

<h2>Reports, payroll &amp; refunds</h2>
<ul>
<li><strong>Reports:</strong> pick a <strong>date range</strong>, <strong>compare</strong> periods, see a <strong>performance chart</strong>, and <strong>drill in</strong> to the day's numbers.</li>
<li><strong>Transactions:</strong> every sale. From a transaction you can <strong>view</strong> it, <strong>reprint</strong> the receipt, <strong>refund</strong> a card sale (back to the original card), or <strong>edit</strong> a historical record.</li>
<li><strong>Payroll:</strong> technician earnings derived from the records, plus a <strong>Front Desk — Hourly</strong> section (hours × rate) with a manager <strong>timecard editor</strong>.</li>
</ul>

<h2>Time clock (front desk)</h2>
<p>Front-desk staff <strong>clock in / out</strong> from the account menu (tap your name). Punches feed the hourly payroll section. Clocking is <strong>locked to the front-desk station</strong> so it can't be done from just any device.</p>

<h2>Settings</h2>
<p>One place for: the <strong>Services, Items &amp; Fees</strong> catalog; <strong>staff &amp; schedules</strong>; <strong>stations</strong> (including per-station-type capacity); <strong>appearance</strong>; the <strong>payment processor</strong>; <strong>texting</strong>; <strong>integrations</strong> (including the Back Office daily-sales sync); <strong>photos/logo</strong>; and <strong>data tools</strong>.</p>

<h2>Technician app</h2>
<p>Technicians sign in on their own device to see their queue/turns. Front-desk users get a <strong>read-only schedule + hours</strong> view there.</p>

<h2>End of day</h2>
<div class="step">Finish open tickets → <strong>close the cash drawer</strong> (count + reconcile) → check <strong>Reports</strong> for the day → daily totals sync to Back Office automatically.</div>

<h2>Good to know</h2>
<ul>
<li>Everything syncs <strong>live</strong> across devices; a device that goes offline catches up when it reconnects.</li>
<li>A ticket's price is <strong>always</strong> the live total (services + items×qty + fees − discount) — never a stale saved number.</li>
<li><strong>Done</strong> means the work is finished but money hasn't been taken yet; <strong>Paid</strong> is the finalized sale.</li>
<li>If anything looks stale or stuck, tap the version badge to reload.</li>
</ul>
`;

// ── Quick reference — the everyday overview (was the old App Guide) ─────────────
const QUICK = `
<h1>TurnDesk — Quick Reference</h1>
<p class="sub">The salon front-desk app at a glance: the daily workflow, each screen, and the key buttons. It runs on the front-desk iPad and on technician devices, and syncs live across all of them. (For exact button-by-button detail, symbols, and color meanings, see the full App guide.)</p>

<h2>The day in one line</h2>
<div class="step">Customer <strong>checks in</strong> → appears in the <strong>Queue</strong> → you <strong>Assign &amp; Price</strong> a technician and services → the service moves through its <strong>status</strong> (waiting → in service → done) → <strong>Pay</strong> (cash, card, gift card, tips) → it lands in <strong>Reports</strong>. The <strong>Turns</strong> tab keeps tech rotation fair; the <strong>cash drawer</strong> is opened and closed each day.</div>

<h2>Header &amp; your account</h2>
<ul>
<li>Top-right shows who's signed in. <strong>Tap your name</strong> for your account menu: <strong>Clock in / out</strong>, the <strong>App guide</strong> and <strong>Quick reference</strong> (printable to PDF), <strong>What's new</strong>, and <strong>Log out</strong>.</li>
<li>The <strong>version number</strong> is the update button: it shows a <code>↻</code> when a new version is available — tap it to reload fresh. Tapping it any time also reopens <strong>What's new</strong>. If a screen ever seems stuck, tap the version badge to reload.</li>
<li>The <strong>search</strong> box finds customers and past tickets fast.</li>
</ul>

<h2>Check-in</h2>
<ul>
<li>Customers check themselves in at the kiosk (or you check them in at the front desk). Returning customers are matched by phone; new ones are added to the directory.</li>
<li>Checked-in customers drop into the <strong>Queue</strong> as waiting.</li>
</ul>

<h2>Queue &amp; Assign &amp; Price</h2>
<ul>
<li>The <strong>Queue</strong> lists everyone waiting or in service, each as a card with a status dot/pill.</li>
<li>Tap a card → <strong>Assign &amp; Price</strong>: choose the technician, add the services and any items/fees, set tips/discounts. This sets the ticket's price (the single source of truth for what's owed).</li>
<li>While someone has a ticket open on another device, it's locked to avoid two people editing the same ticket at once.</li>
</ul>

<h2>Status flow</h2>
<p>Each service shows a colored dot + pill so the floor can read state at a glance: <strong>waiting</strong>, <strong>in service</strong>, <strong>done</strong>. The same styling appears on Queue, Turns, and Floor cards.</p>

<h2>Turns (rotation)</h2>
<ul>
<li>Tracks each technician's turn count so work is shared fairly. A customer's turn number shows on the top-right of their card; <strong>half turns</strong> appear in a small amber box.</li>
<li>Use it to decide who's "up" next. History is kept on a rolling window.</li>
</ul>

<h2>Floor plan</h2>
<p>A visual map of stations with technician avatars. Drag a tech to a station; each station type has its own capacity. Good for seeing who's where at a glance.</p>

<h2>Pay / checkout</h2>
<ul>
<li>From a ticket, <strong>Confirm Payment</strong> opens checkout: choose the tender(s) — <strong>cash</strong>, <strong>card</strong>, <strong>gift card</strong> — split across tenders if needed, add <strong>tips</strong>, and apply a <strong>gift-card redemption</strong> or discount.</li>
<li><strong>Card payments run on the Helcim Smart Terminal</strong>: confirm the amount on the app and the customer taps/inserts on the terminal; the app waits for the result and records it.</li>
<li>You can also <strong>mark a ticket paid without charging a card</strong> (e.g. cash already taken) — it still records the sale.</li>
<li><strong>Reprint a receipt</strong> from the transaction; <strong>refunds</strong> for card sales go back to the original card.</li>
</ul>

<h2>Quick Sale</h2>
<p>Sell a retail item or a gift card without a service ticket — a fast no-service checkout.</p>

<h2>Customers</h2>
<p>The <strong>Customers</strong> tab is your directory: search, add, edit, de-dup, import, and per-customer notes (kept by phone number). The app is the source of truth for the directory.</p>

<h2>Gift cards</h2>
<p>Sell gift cards (cash or card) and redeem them at checkout. Balances are tracked in the app.</p>

<h2>Cash register / drawer</h2>
<ul>
<li><strong>Open</strong> the drawer with a starting count at the start of the day; record <strong>cash in / out</strong> as needed.</li>
<li><strong>Close</strong> the drawer with a counted total to reconcile against expected cash; over/short is recorded (and pushed to Back Office). A PDF summary is available.</li>
</ul>

<h2>Appointments (calendar)</h2>
<p>Appointments are backed by Google Calendar and shown in the app. Columns and display hours are adjustable. Appointment reminders can be sent by text.</p>

<h2>Reports, payroll &amp; refunds</h2>
<ul>
<li><strong>Reports</strong>: pick a date range, compare periods, see a performance chart, and drill into the day's transactions.</li>
<li><strong>Transactions</strong>: every sale, with the ability to view, reprint, refund, or edit a historical record.</li>
<li><strong>Payroll</strong>: technician earnings from the records, plus a <strong>Front Desk — Hourly</strong> section (hours × rate) with a manager timecard editor.</li>
</ul>

<h2>Time clock (front desk)</h2>
<p>Front-desk staff clock in/out from their account menu (tap your name). Punches feed the hourly payroll section; clocking is locked to the front-desk station.</p>

<h2>Settings</h2>
<p>Services, items &amp; fees catalog; staff &amp; schedules; stations; appearance; payment processor; texting; integrations (including the Back Office daily-sales sync); photos/logo; and data tools.</p>

<h2>Technician app</h2>
<p>Technicians sign in on their own device to see their queue/turns and (for front-desk users) a read-only schedule + hours view.</p>

<h2>End of day</h2>
<div class="step">Finish open tickets → <strong>close the cash drawer</strong> (count + reconcile) → check <strong>Reports</strong> for the day → daily totals sync to Back Office automatically.</div>

<h2>Good to know</h2>
<ul>
<li>Everything syncs live across devices; if a device goes offline it catches up when it reconnects.</li>
<li>A ticket's price is always the live total — services + items×qty + fees − discount.</li>
<li>If anything looks stale or stuck, tap the version badge to reload.</li>
</ul>
`;
