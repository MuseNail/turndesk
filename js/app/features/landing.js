// ── Public landing page (bare front door) ────────────────────────────────────
// The marketing content shown ONLY on the bare public link (no ?salon=), wrapped
// around the existing email-first sign-in card. auth.js's renderSigninScreen()
// toggles the #landing wrapper's visibility; a salon link (?salon=<slug>) hides all
// of this and shows the PIN pad exactly as before. This module owns the feature
// tiles + their detail popup — NOT any auth/session logic.
//
// Content honesty rule (verified against the real code 2026-07-14): every tile's
// problem→solution teaser reads as shipped; anything not fully built yet carries a
// `soon` line, shown only inside the click-through detail — never on the teaser card.

// Small "screenshot-like" recreations (owner chose recreations over real app captures,
// so they can later blur details to deter copycats). Built from the app's own tokens.
const REC_TURNS = `
  <div class="rounded-xl bg-primary-dim p-4 mt-4">
    <p class="text-[10px] font-body text-primary-container tracking-widest uppercase mb-2.5">Turns board · today</p>
    <div class="space-y-1.5">
      <div class="flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5">
        <span class="w-1.5 h-1.5 rounded-full" style="background:#2a7a4f"></span>
        <span class="text-[12px] font-body text-white flex-1">Amy</span>
        <span class="text-[11px] font-headline font-semibold text-secondary-container">6.5t</span></div>
      <div class="flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5">
        <span class="w-1.5 h-1.5 rounded-full" style="background:#f5c870"></span>
        <span class="text-[12px] font-body text-white flex-1">Bao</span>
        <span class="text-[11px] font-headline font-semibold text-secondary-container">5.0t</span></div>
      <div class="flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5">
        <span class="w-1.5 h-1.5 rounded-full" style="background:#f5c870"></span>
        <span class="text-[12px] font-body text-white flex-1">Chi</span>
        <span class="text-[11px] font-headline font-semibold text-secondary-container">4.5t</span></div>
      <div class="flex items-center gap-2.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 opacity-60">
        <span class="w-1.5 h-1.5 rounded-full" style="background:#7a858a"></span>
        <span class="text-[12px] font-body text-white flex-1">Dao · skipped</span>
        <span class="text-[11px] font-headline font-semibold text-primary-container">4.0t</span></div>
    </div>
  </div>`;

const REC_REPORTS = `
  <div class="rounded-xl bg-primary-dim p-4 mt-4">
    <p class="text-[10px] font-body text-primary-container tracking-widest uppercase mb-2.5">Reports · phone app</p>
    <div class="grid grid-cols-3 gap-2">
      <div class="rounded-lg bg-white/[0.06] px-2 py-2 text-center">
        <p class="text-[9px] font-body text-primary-container uppercase tracking-wide">Sales</p>
        <p class="text-[15px] font-headline font-extrabold text-white mt-0.5">$1,240</p></div>
      <div class="rounded-lg bg-white/[0.06] px-2 py-2 text-center">
        <p class="text-[9px] font-body text-primary-container uppercase tracking-wide">Tips</p>
        <p class="text-[15px] font-headline font-extrabold text-white mt-0.5">$186</p></div>
      <div class="rounded-lg bg-white/[0.06] px-2 py-2 text-center">
        <p class="text-[9px] font-body text-primary-container uppercase tracking-wide">Tickets</p>
        <p class="text-[15px] font-headline font-extrabold text-white mt-0.5">28</p></div>
    </div>
  </div>`;

const REC_PAYMENTS = `
  <div class="rounded-xl bg-primary-dim p-4 mt-4">
    <p class="text-[10px] font-body text-primary-container tracking-widest uppercase mb-2.5">Effective rate</p>
    <div class="flex items-end gap-3">
      <div><p class="text-[26px] leading-none font-headline font-extrabold text-white">~1.8%</p>
        <p class="text-[10px] font-body text-primary-container mt-1">Helcim · no added per-txn fee</p></div>
      <div class="flex-1 border-l border-white/15 pl-3">
        <p class="text-[15px] leading-none font-headline font-semibold text-white/60 line-through">2.6% + 15¢</p>
        <p class="text-[10px] font-body text-primary-container mt-1">typical processor</p></div>
    </div>
  </div>`;

const li = t => `<li class="flex gap-2 items-start"><span class="material-symbols-outlined text-primary text-[18px] leading-5">check</span><span>${t}</span></li>`;
const bullets = arr => `<ul class="space-y-1.5 text-sm font-body text-on-surface-variant mt-1">${arr.map(li).join('')}</ul>`;
const lead = t => `<p class="text-sm font-body text-on-surface-variant leading-relaxed">${t}</p>`;

// The 8 tiles. `problem`/`solution` = the always-confident teaser; `body` = detail HTML;
// `soon` (optional) = the honest "not built yet" line, detail-only. `visual` = a recreation.
export const LANDING_FEATURES = [
  {
    key: 'turns', icon: 'swap_vert',
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
    key: 'checkin', icon: 'how_to_reg',
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
    key: 'floorplan', icon: 'chair',
    problem: 'A list of names doesn’t show you how your floor actually works.',
    solution: 'See your real layout — drag, drop, and color it to match your salon.',
    title: 'See your floor, not a list.',
    body: lead('Your real stations, laid out and colored the way your salon is actually arranged — dragged and dropped, not typed into a spreadsheet.')
      + bullets([
        'Drag-and-drop layout that mirrors your real floor',
        'Custom colors and sizing per station type',
        'Who’s open and who’s busy, at a glance',
      ]),
  },
  {
    key: 'reports', icon: 'bar_chart',
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
    key: 'payments', icon: 'credit_card',
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
    key: 'texting', icon: 'sms',
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
    key: 'booking', icon: 'event_available',
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
    key: 'ai', icon: 'insights',
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
  const visual = f.visual || '';
  return `
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
export function renderLandingTiles() {
  const host = document.getElementById('landing-tiles');
  if (!host) return;
  host.innerHTML = LANDING_FEATURES.map(f => `
    <button type="button" class="landing-tile flex flex-col bg-surface-container-lowest rounded-xl p-4" aria-haspopup="dialog" onclick="showLandingFeature('${f.key}')">
      <span class="flex w-8 h-8 rounded-lg bg-primary-container items-center justify-center mb-2.5">
        <span class="material-symbols-outlined text-on-primary-container" style="font-size:18px">${f.icon}</span></span>
      <span class="block text-xs font-body text-on-surface-variant mb-1.5 leading-snug">${f.problem}</span>
      <span class="block font-headline font-bold text-sm text-on-surface mb-3 leading-snug">${f.solution}</span>
      <span class="mt-auto text-[11px] font-body font-semibold text-primary underline">Learn more →</span>
    </button>`).join('');
}

// Init once the DOM exists (module scripts run after parse, but guard anyway).
// - render the tiles
// - Escape closes the detail popup (the app's other modals have no key handling; new
//   code gets the basics)
if (typeof document !== 'undefined') {
  const _init = () => {
    renderLandingTiles();
    // Marketing tab title ONLY on the bare public link — never on a ?salon= kiosk load
    // (there photos.js sets the business name once config hydrates; until then the
    // neutral static <title>TurnDesk</title> shows, not this marketing string).
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
