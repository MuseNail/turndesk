// ── Public landing page (bare front door) ────────────────────────────────────
// The marketing content shown ONLY on the bare public link (no ?salon=), wrapped
// around the existing email-first sign-in card. auth.js's renderSigninScreen()
// toggles the #landing wrapper's visibility; a salon link (?salon=<slug>) hides all
// of this and shows the PIN pad exactly as before. This module owns the feature
// tiles, their detail popup, and the "see it in action" showcase — NOT any auth logic.
//
// Content honesty rule (verified against the real code 2026-07-14): every tile's
// problem→solution teaser reads as shipped; anything not fully built yet carries a
// `soon` line, shown only inside the click-through detail — never on the teaser card.

// ── Sample "windows" ─────────────────────────────────────────────────────────
// FAITHFUL recreations of the REAL app screens — light surface + the app's ACTUAL
// status colors and structure (from status.js serviceLineStyle, turns.js availability
// chips, floorplan.js status tints, reports.js metric cards), so the previews look
// exactly like the product. Margin-free + w-full so the SAME panel works in both the
// feature popups and the showcase row. Owner chose recreations over live screenshots so
// details can be blurred later to deter copycats. Brand hexes are inline on purpose —
// these mirror specific app surfaces, not themeable UI.
function recWindow(icon, title, inner) {
  return `<div class="rounded-xl overflow-hidden w-full border border-surface-container-high shadow-sm" style="background:#f5f7f8">
    <div class="flex items-center gap-2 px-3.5 py-2.5" style="background:#fff;border-bottom:1px solid #e4eae9">
      <span class="material-symbols-outlined text-primary" style="font-size:16px">${icon}</span>
      <span class="text-[12px] font-headline font-bold text-on-surface">${title}</span>
    </div>
    <div class="p-3">${inner}</div>
  </div>`;
}

const _fdot = c => `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block;flex-shrink:0"></span>`;
// Availability chips mirror turns.js exactly (Working now / Next up / Available / Off).
const _CHIP = {
  working: { ring: '#2a7a4f', style: 'background:#e9f4ee;color:#1b5e3b', lead: _fdot('#2a7a4f'), label: 'Working now' },
  nextup:  { ring: '#1a5252', style: 'background:#1a5252;color:#fff', lead: '<span class="material-symbols-outlined" style="font-size:11px">arrow_upward</span>', label: 'Next up' },
  avail:   { ring: '#1a5252', style: 'background:#fff;border:1px solid #b9c8c2;color:#1a5252', lead: _fdot('#1a5252'), label: 'Available' },
  off:     { ring: '#b0b6ba', style: 'background:#eceef0;color:#7a858a', lead: _fdot('#b0b6ba'), label: 'Off' },
};
const _turnRow = (name, initial, turns, chipKey) => {
  const c = _CHIP[chipKey];
  return `<div class="flex items-center gap-2.5 px-1 py-1">
    <div class="w-9 h-9 rounded-full flex items-center justify-center border-2 flex-shrink-0 text-xs font-headline font-bold" style="background:${c.ring}1f;border-color:${c.ring};color:${c.ring}">${initial}</div>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5"><span class="font-headline font-semibold text-on-surface text-[13px] truncate">${name}</span><span class="text-[13px] font-headline font-bold flex-shrink-0" style="color:#1a5252">${turns}t</span></div>
      <div class="mt-1"><span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold leading-none inline-flex items-center gap-1" style="${c.style}">${c.lead}${c.label}</span></div>
    </div>
  </div>`;
};
const REC_TURNS = recWindow('swap_vert', 'Turns · Today', `
  <div class="grid grid-cols-1 gap-0.5">
    ${_turnRow('Amy', 'A', '6.5', 'working')}
    ${_turnRow('Bao', 'B', '5.0', 'nextup')}
    ${_turnRow('Chi', 'C', '4.5', 'avail')}
    ${_turnRow('Dao', 'D', '4.0', 'off')}
  </div>`);

const _FP = { inservice: { bg: '#d8ecdf', bd: '#2a7a4f' }, complete: { bg: '#d3e4ef', bd: '#1a5c7a' }, waiting: { bg: '#ffe9c4', bd: '#d4860a' } };
const _fpTile = (label, name, status) => {
  if (!name) return `<div class="rounded-lg flex items-center justify-center" style="height:50px;border:2px solid #cdd8d5;background:#eef2f1"><span class="text-[10px] font-headline font-extrabold" style="color:#93a09c">${label}</span></div>`;
  const c = _FP[status];
  return `<div class="rounded-lg relative flex flex-col justify-center px-1.5" style="height:50px;border:2px solid ${c.bd};background:${c.bg}">
    <span class="absolute" style="top:2px;left:5px;font-size:8px;font-weight:700;color:${c.bd};opacity:.7">${label}</span>
    <span class="text-[11px] font-semibold" style="color:#1f2937;line-height:1.1;margin-top:6px">${name}</span></div>`;
};
const REC_FLOOR = recWindow('chair', 'Floor Plan', `
  <div class="grid grid-cols-4 gap-1.5 mb-1.5">
    ${_fpTile('Mani 1', 'Sarah', 'inservice')}
    ${_fpTile('Mani 2', 'Amy', 'complete')}
    ${_fpTile('Mani 3', '')}
    ${_fpTile('Mani 4', 'Mia', 'waiting')}
  </div>
  <div class="grid grid-cols-3 gap-1.5">
    ${_fpTile('Pedi 1', 'Bao', 'inservice')}
    ${_fpTile('Pedi 2', '')}
    ${_fpTile('Wax', 'Evy', 'complete')}
  </div>`);

const _metric = (label, val, primary) => `<div class="rounded-lg px-2 py-2 text-center" style="${primary ? 'background:rgba(26,82,82,0.07)' : 'background:#fff;border:1px solid #e4eae9'}"><div class="text-[9px] font-body uppercase tracking-wide text-on-surface-variant leading-tight">${label}</div><div class="font-headline font-bold text-[15px] leading-tight mt-0.5 ${primary ? 'text-primary' : 'text-on-surface'}">${val}</div></div>`;
const _rptRow = (tech, turns, billed) => `<tr style="border-top:1px solid #e4eae9"><td class="py-1 text-on-surface">${tech}</td><td class="py-1 text-right text-on-surface-variant">${turns}</td><td class="py-1 text-right font-headline font-semibold" style="color:#1a5252">${billed}</td></tr>`;
const REC_REPORTS = recWindow('bar_chart', 'Daily Report', `
  <div class="grid grid-cols-3 gap-2">
    ${_metric('Sales', '$1,240', true)}
    ${_metric('Tips', '$186')}
    ${_metric('Tickets', '28')}
  </div>
  <table class="w-full mt-3 text-[11px] font-body">
    <thead><tr class="text-on-surface-variant"><th class="text-left font-semibold pb-1">Tech</th><th class="text-right font-semibold pb-1">Turns</th><th class="text-right font-semibold pb-1">Billed</th></tr></thead>
    <tbody>
      ${_rptRow('Amy', '6.5', '$410')}
      ${_rptRow('Bao', '5.0', '$355')}
      ${_rptRow('Chi', '4.5', '$300')}
    </tbody>
  </table>`);

const REC_PAYMENTS = recWindow('credit_card', 'Effective rate', `
  <div class="flex items-end gap-3">
    <div><p class="text-[26px] leading-none font-headline font-extrabold text-primary">~1.8%</p>
      <p class="text-[10px] font-body text-on-surface-variant mt-1">Helcim · no added per-txn fee</p></div>
    <div class="flex-1 pl-3" style="border-left:1px solid #e4eae9">
      <p class="text-[15px] leading-none font-headline font-semibold line-through text-on-surface-variant">2.6% + 15¢</p>
      <p class="text-[10px] font-body text-on-surface-variant mt-1">typical processor</p></div>
  </div>`);

const li = t => `<li class="flex gap-2 items-start"><span class="material-symbols-outlined text-primary text-[18px] leading-5">check</span><span>${t}</span></li>`;
const bullets = arr => `<ul class="space-y-1.5 text-sm font-body text-on-surface-variant mt-1">${arr.map(li).join('')}</ul>`;
const lead = t => `<p class="text-sm font-body text-on-surface-variant leading-relaxed">${t}</p>`;

// The 8 tiles. `name` = the short feature title; `problem`/`solution` = the always-
// confident teaser; `body` = detail HTML; `soon` (optional) = the honest "not built
// yet" line, detail-only; `visual` = a sample window.
export const LANDING_FEATURES = [
  {
    key: 'turns', name: 'Turn Grid', icon: 'swap_vert',
    problem: '“Whose turn is it?” turns into a daily argument.',
    solution: 'An ordered, visible rotation the whole team can check for themselves.',
    title: 'A rotation the whole shop can see and trust.',
    body: lead('Every walk-in joins one ordered rotation instead of a first-come free-for-all. Step a tech away and the skip is tracked automatically — so the board is always the honest answer to “who’s next?”')
      + bullets([
        'Ordered turn list, synced to every device in real time',
        'Manual skip-a-turn, counted like a completed turn',
        'Full-turn and half-turn credit — not just a head count',
        'Suggestions already favor techs who can do the service',
      ]),
    soon: 'Choose your own fairness rule — points-based, whole-turn, or traditional. Today the rule is fixed; picking it is what’s coming.',
    visual: REC_TURNS,
  },
  {
    key: 'checkin', name: 'Check-In Kiosk', icon: 'how_to_reg',
    problem: 'Walk-ins arrive with no appointment and no clean way to get in line.',
    solution: 'Self check-in at the door — no clipboard, no calling names across the salon.',
    title: 'No clipboard. No shouting names.',
    body: lead('A guest with no appointment enters their own name, phone, and service the moment they walk in — and drops straight into the same rotation as everyone else.')
      + bullets([
        'Guests check themselves in — staff don’t have to start it',
        'Joins the real turn rotation instantly',
        'The front desk sees every arrival live',
      ]),
  },
  {
    key: 'floorplan', name: 'Floor Plan', icon: 'chair',
    problem: 'A list of names doesn’t show you how your floor actually works.',
    solution: 'See your real layout — drag, drop, and color it to match your salon.',
    title: 'See your floor, not a list.',
    body: lead('Your real stations, laid out and colored the way your salon is actually arranged — dragged and dropped, not typed into a spreadsheet.')
      + bullets([
        'Drag-and-drop layout that mirrors your real floor',
        'Custom colors and sizing per station type',
        'Who’s open and who’s busy, at a glance',
      ]),
    visual: REC_FLOOR,
  },
  {
    key: 'reports', name: 'Reports & Payroll', icon: 'bar_chart',
    problem: 'Payroll by hand eats hours — and you can’t see the numbers unless you’re at the front desk.',
    solution: 'Sales, tips, and payroll figured automatically — with a phone app so you can check from anywhere.',
    title: 'The numbers, wherever you are.',
    body: lead('Every ticket flows straight into your reports and your team’s pay — no spreadsheet bolted on afterward. And a separate, install-to-your-phone app shows the same numbers on the go, read-only and PIN-protected.')
      + bullets([
        'Daily sales and tips, calculated automatically',
        'Technician payroll tied to real tickets',
        'A dedicated phone app for owners and managers',
      ]),
    soon: 'Your calendar here too. Today the phone app covers reports and payroll; the on-the-go calendar view is coming.',
    visual: REC_REPORTS,
  },
  {
    key: 'payments', name: 'Payments', icon: 'credit_card',
    problem: 'Most salon software locks you into their processor — often at a steep rate.',
    solution: 'Bring the processor you already use. Through Helcim, an effective rate around 1.8% with no added per-transaction fee.',
    title: 'Your processor. A better rate.',
    body: lead('Connect the processor you already use instead of switching to ours. Through Helcim that’s an effective rate around 1.8% with no added per-transaction fee — well under the usual 2.6% + 15¢. Gift cards sell and redeem at the same checkout.')
      + bullets([
        'Square or Helcim — your choice',
        'An effective rate around 1.8% via Helcim, no added per-transaction fee',
        'Gift cards built into checkout',
      ]),
    visual: REC_PAYMENTS,
  },
  {
    key: 'texting', name: 'Text Updates', icon: 'sms',
    problem: 'Customers forget appointments — and don’t know when their turn is close.',
    solution: 'Text updates that don’t depend on someone remembering to send them.',
    title: 'Customers stay in the loop.',
    body: lead('Reach a customer’s phone straight from the front desk — the texting is built in, not a bolted-on marketing upsell.')
      + bullets([
        'Send a text to a customer right from the app',
        'Built in — not metered, not a separate tier',
      ]),
    soon: 'Automatic status and appointment texts. The sending works today; having them fire on their own is what’s coming next.',
  },
  {
    key: 'booking', name: 'Smart Booking', icon: 'event_available',
    problem: 'Slow Tuesday afternoons sit empty while Saturday mornings overbook.',
    solution: 'Booking that steers toward your slow hours and guards against overcommitting.',
    title: 'Booking that protects your day.',
    body: lead('Instead of a calendar anyone can pile onto, booking that’s aware of how your day actually runs — nudging appointments toward quiet stretches and holding the line on your busiest ones.')
      + bullets([
        '24/7 booking from a customer’s phone',
        'Steers bookings toward your slow hours',
        'Guards against overbooking your busiest times',
      ]),
    soon: 'This whole feature is in active development — not live yet. We’re building it properly rather than rushing it onto the page.',
  },
  {
    key: 'ai', name: 'AI Insights', icon: 'insights',
    problem: 'Digging insight out of raw numbers takes time you don’t have.',
    solution: 'Ask a question about your numbers in plain English and get an answer.',
    title: 'Answers, not just spreadsheets.',
    body: lead('Instead of copying figures into a separate chatbot, ask about your own reports right where they live — “which day was slowest last week?” — and get a plain-English read.')
      + bullets([
        'Ask in plain English, about your real numbers',
        'Your data stays handled securely on our server',
      ]),
    soon: 'The in-app button. The AI engine is already wired up securely on our side; the reports-app button that calls it is what’s coming.',
  },
];

export function getLandingFeature(key) {
  return LANDING_FEATURES.find(f => f.key === key);
}

function detailHtml(f) {
  const soon = f.soon
    ? `<div class="mt-4 rounded-xl bg-secondary-container/50 px-3 py-2.5">
         <p class="text-xs font-body text-on-secondary-container leading-snug">
           <span class="material-symbols-outlined text-[15px] align-[-3px] mr-1">schedule</span>
           <span class="font-semibold">Launching soon:</span> ${f.soon}</p></div>`
    : '';
  const visual = f.visual ? `<div class="mt-4">${f.visual}</div>` : '';
  return `
    <p class="text-[11px] font-headline font-bold uppercase tracking-wide text-primary mb-1">${f.name}</p>
    <h2 class="text-xl font-headline font-bold text-on-surface pr-8 mb-3">${f.title}</h2>
    ${f.body}
    ${soon}
    ${visual}`;
}

let _lastTrigger = null;

export function showLandingFeature(key) {
  const f = getLandingFeature(key);
  if (!f) return;
  const modal = document.getElementById('landing-feature-modal');
  const body  = document.getElementById('landing-feature-body');
  if (!modal || !body) return;
  body.innerHTML = detailHtml(f);
  _lastTrigger = document.activeElement;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('landing-feature-close')?.focus();
}

export function closeLandingFeature() {
  const modal = document.getElementById('landing-feature-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  try { _lastTrigger && _lastTrigger.focus(); } catch {}
}

// Populate the tile grid from LANDING_FEATURES (one tested source of truth). Tiles are
// real <button>s (keyboard-operable) holding only phrasing content (spans, not divs).
// Hierarchy: name (extrabold header) → problem (muted) → solution (semibold) → CTA.
export function renderLandingTiles() {
  const host = document.getElementById('landing-tiles');
  if (!host) return;
  host.innerHTML = LANDING_FEATURES.map(f => `
    <button type="button" class="landing-tile flex flex-col bg-surface-container-lowest rounded-xl p-4" aria-haspopup="dialog" onclick="showLandingFeature('${f.key}')">
      <span class="flex items-center gap-2 mb-2">
        <span class="flex w-8 h-8 rounded-lg bg-primary-container items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-on-primary-container" style="font-size:18px">${f.icon}</span></span>
        <span class="font-headline font-extrabold text-sm text-on-surface leading-tight">${f.name}</span>
      </span>
      <span class="block text-xs font-body text-on-surface-variant mb-1.5 leading-snug">${f.problem}</span>
      <span class="block font-headline font-semibold text-[13px] text-on-surface mb-3 leading-snug">${f.solution}</span>
      <span class="mt-auto text-[11px] font-body font-semibold text-primary underline">Learn more →</span>
    </button>`).join('');
}

// The "see it in action" showcase — three sample windows (turn grid, floor plan,
// report) so a first-time visitor sees the product, not just claims about it.
export function renderLandingShowcase() {
  const host = document.getElementById('landing-showcase');
  if (!host) return;
  const panel = (rec, cap) => `<div>${rec}<p class="text-center text-xs font-body text-on-surface-variant mt-2.5">${cap}</p></div>`;
  host.innerHTML =
      panel(REC_TURNS,   'The turn grid — whose turn, at a glance.')
    + panel(REC_FLOOR,   'Your floor plan — open and busy stations.')
    + panel(REC_REPORTS, 'Daily report — sales, tips, and payroll.');
}

// Init once the DOM exists (module scripts run after parse, but guard anyway):
// render the tiles + showcase, set the marketing tab title (bare link only), and wire
// Escape-to-close for the detail popup (the app's other modals have no key handling).
if (typeof document !== 'undefined') {
  const _init = () => {
    renderLandingTiles();
    renderLandingShowcase();
    // Marketing tab title ONLY on the bare public link — never on a ?salon= kiosk load.
    // (photos.js is the authoritative owner of the title once config hydrates; this is
    // the pre-hydrate default so the bare page reads right immediately.)
    try { if (!new URLSearchParams(location.search).get('salon')) document.title = 'TurnDesk — salon front desk, free beta'; } catch {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('landing-feature-modal');
    if (modal && !modal.classList.contains('hidden')) closeLandingFeature();
  });
}
