// Re-runnable demo-salon seed for TurnDesk.
//
// Populates the `demo` salon ("Lush Nails & Spa") with ~a month of believable
// history so Reports/Payroll/Customers/Turns look like a real, busy salon for
// sales demos. Re-running RE-ANCHORS the whole window to end *today* (today is a
// partial, in-shift day), so the demo never looks stale. Ids are deterministic
// (rec-1..rec-N, cust-1..cust-320, gc-1..gc-6), so a re-run REPLACES by id rather
// than duplicating — and it always covers the existing id range, leaving zero
// stale orphans. It never calls record.delete (a deletion marker would permanently
// block that id from ever being re-seeded).
//
// Usage (PowerShell):
//   node tools/seed-demo.mjs                       # signs in with SEED_PIN (default 1111)
//   $env:RESTORE_TOKEN="<token>"; node ...         # also (re)sets the owner email/password
// Optional env: WORKER, SALON, SEED_PIN, SESSION_TOKEN, OWNER_EMAIL, OWNER_PASSWORD,
//               RESTORE_TOKEN, DAYS, CONCURRENCY.
//
// Works with AUTH_ENFORCED="true": every write carries a session token minted from
// SEED_PIN via /auth/login (that route is always auth-exempt). RESTORE_TOKEN is
// only needed to (re)set the owner credential — omit it to leave the owner as-is.

const WORKER   = process.env.WORKER       || 'https://turndesk.musenailandspa.workers.dev';
const SALON    = process.env.SALON        || 'demo';
const SEED_PIN = process.env.SEED_PIN     || '1111';   // a front-desk PIN → session token
let   TOKEN    = process.env.SESSION_TOKEN || '';       // reuse an existing token if provided
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@demo.turndesk.app';
const RESTORE_TOKEN = process.env.RESTORE_TOKEN || '';
const DAYS     = parseInt(process.env.DAYS || '35', 10);
const CONC     = parseInt(process.env.CONCURRENCY || '12', 10);
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || ('Lush-' + Math.random().toString(36).slice(2, 8) + '-demo');

// ── Deterministic PRNG (mulberry32) so re-runs reproduce the same salon ────────
let _seed = 0x9e3779b9;
function rnd() { _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0; let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));        // int in [a,b]
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

// ── Catalog: Lush Nails & Spa ──────────────────────────────────────────────────
const SERVICES = [
  { id: 'svc-mani',  label: 'Classic Manicure', abbr: 'MANI', baseCost: 25 },
  { id: 'svc-gel',   label: 'Gel Manicure',     abbr: 'GEL',  baseCost: 38 },
  { id: 'svc-pedi',  label: 'Classic Pedicure', abbr: 'PEDI', baseCost: 35 },
  { id: 'svc-gpedi', label: 'Gel Pedicure',     abbr: 'GPED', baseCost: 50 },
  { id: 'svc-dip',   label: 'Dip Powder',       abbr: 'DIP',  baseCost: 45 },
  { id: 'svc-acrf',  label: 'Acrylic Full Set', abbr: 'ACRF', baseCost: 55 },
  { id: 'svc-gelx',  label: 'Gel-X Extensions', abbr: 'GELX', baseCost: 65 },
  { id: 'svc-pol',   label: 'Polish Change',    abbr: 'POL',  baseCost: 15 },
];
const ITEMS = [
  { id: 'item-oil',   label: 'Cuticle Oil',  abbr: 'OIL',  price: 12 },
  { id: 'item-cream', label: 'Hand Cream',   abbr: 'CREAM',price: 15 },
  { id: 'item-file',  label: 'Nail File',    abbr: 'FILE', price: 3 },
];
const FEES = [];   // none for the demo

const TECH_NAMES = ['Lily', 'Mai', 'Tina', 'Kevin', 'Sophia', 'Anna'];
const STAFF = TECH_NAMES.map((name, i) => ({
  id: `staff-${i + 1}`, name, legalName: '', commission: pick([50, 55, 60]),
  services: SERVICES.map(s => s.id), pin: String(1001 + i), checkType: 'variable', checkValue: null,
  cashDeductPct: null, cashDeductThreshold: null, app: { pdf: true, history: true, histNames: true },
}));
const FD_USERS = [
  { id: 'fd-1', name: 'Front Desk', pin: '1111', role: 'frontdesk' },
  { id: 'fd-2', name: 'Manager Mia', pin: '2222', role: 'admin' },
];
const TURNS_ORDER = STAFF.map(s => s.id);

const FIRST = ['Emma','Olivia','Ava','Sophia','Isabella','Mia','Amelia','Harper','Evelyn','Abigail','Grace','Chloe','Nora','Lily','Zoe','Hannah','Lucy','Ella','Scarlett','Aria','Maya','Jasmine','Diana','Rachel','Karen','Linda','Susan','Nancy','Jessica','Ashley','Brittany','Megan','Tiffany','Vanessa','Crystal','Michelle','Cynthia','Angela','Melissa','Rebecca','Stephanie','Christina','Natalie','Victoria','Samantha','Lauren','Kayla','Destiny','Jacqueline','Priya'];
const LAST = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Nguyen','Tran','Pham','Kim','Patel','Chen','Wang','Cooper','Reed','Bailey','Rivera','Brooks','Ward','Foster','Gray','Hughes','Price','Bennett','Wood','Barnes','Ross'];

function buildCustomers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const gn = pick(FIRST), fn = pick(LAST);
    const area = pick(['909','714','951','626','310']);
    const phone = `(${area}) ${ri(200,999)}-${String(ri(0,9999)).padStart(4,'0')}`;
    out.push({ id: `cust-${i + 1}`, given_name: gn, family_name: fn, phone });
  }
  return out;
}

// One paid sale. checkinTime (ms) is the date field Reports buckets by. When capMs
// is given (today), the start is clamped to [9am, capMs] so a sale can't begin in
// the future — today reads as a salon mid-shift, not booked out to closing.
function buildRecord(dayMs, customers, capMs) {
  const cust = pick(customers);
  const open = new Date(dayMs); open.setHours(ri(9, 18), pick([0, 15, 30, 45]), 0, 0);
  let checkinTime = open.getTime();
  if (capMs && checkinTime > capMs) {
    const dayStart = new Date(dayMs); dayStart.setHours(9, 0, 0, 0);
    const lo = dayStart.getTime();
    checkinTime = capMs > lo ? lo + Math.floor(rnd() * (capMs - lo)) : lo;
  }
  const tech = pick(STAFF);
  const assignments = [];
  const nSvc = chance(0.30) ? 2 : 1;
  const chosen = new Set();
  for (let k = 0; k < nSvc; k++) {
    let svc = pick(SERVICES); let guard = 0;
    while (chosen.has(svc.id) && guard++ < 5) svc = pick(SERVICES);
    chosen.add(svc.id);
    const aTech = k === 0 ? tech : (chance(0.5) ? pick(STAFF) : tech);
    assignments.push({ techId: aTech.id, serviceId: svc.id, name: svc.label, cost: svc.baseCost, income: svc.baseCost, count: 1, checkinTime });
  }
  const items = chance(0.12) ? [{ ...pick(ITEMS), qty: 1 }] : [];
  const svcTotal = assignments.reduce((s, a) => s + a.cost, 0);
  const itemTotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const totalCost = svcTotal + itemTotal;
  // Tender mix: ~60% card, ~33% cash, ~7% gift. Card sales carry a tip.
  const roll = rnd();
  let tenders, tip = 0;
  if (roll < 0.60) { tenders = { card: totalCost, cash: 0, gift: 0, zelle: 0 }; tip = Math.round(totalCost * pick([0.15, 0.18, 0.20, 0.20, 0.25])); }
  else if (roll < 0.93) { tenders = { card: 0, cash: totalCost, gift: 0, zelle: 0 }; if (chance(0.4)) tip = pick([3, 5, 5, 10]); }
  else { tenders = { card: 0, cash: 0, gift: totalCost, zelle: 0 }; }
  let completedAt = checkinTime + ri(25, 70) * 60000;
  if (capMs && completedAt > capMs) completedAt = capMs;    // today: just wrapped up
  return {
    id: '', status: 'paid', checkinTime, completedAt,       // id assigned by the caller
    name: `${cust.given_name} ${cust.family_name}`, phone: cust.phone, customer: cust.id,
    assignments, items, fees: [], discount: 0, totalCost, tip, tenders,
  };
}

function buildGiftcards() {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const amount = pick([25, 50, 50, 75, 100]);
    const used = chance(0.4) ? pick([10, 20, 25]) : 0;
    const redemptions = used ? [{ amount: used, date: new Date(Date.now() - ri(2, 20) * 864e5).toISOString() }] : [];
    out.push({ id: `gc-${i + 1}`, code: `LUSH-${1000 + i}`, amount, redemptions, amountUsed: used, createdAt: new Date(Date.now() - ri(20, 40) * 864e5).toISOString() });
  }
  return out;
}

// A dozen-ish believable app-native appointments: some today (spread across staff, some
// confirmed), some over the next 3 days, one 2-guest party. Deterministic ids appt-1..N.
function buildAppointments() {
  const out = [];
  const at = (dayOffset, hour, min) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + dayOffset); d.setHours(hour, min, 0, 0); return d; };
  const mk = (startD, mins, guests, confirmed) => {
    const start = startD.toISOString(), end = new Date(startD.getTime() + mins*60000).toISOString();
    out.push({ id: `appt-${out.length + 1}`, start, end, guests, notes: '', confirmed: !!confirmed, noShow: false, checkedInQueueId: null, createdAt: Date.now() });
  };
  const cust = () => { const gn = pick(FIRST), fn = pick(LAST); const area = pick(['909','714','951']); return { name: `${gn} ${fn}`, phone: `(${area}) ${ri(200,999)}-${String(ri(0,9999)).padStart(4,'0')}` }; };
  const svcId = () => pick(SERVICES).id;
  const staffId = (i) => STAFF[i % STAFF.length].id;
  // Today — one per several staff, a couple confirmed, one upcoming this afternoon.
  [ [10,0,0], [11,30,1], [13,0,2], [14,30,3], [16,0,4], [17,15,5] ].forEach(([h,m,si], k) => {
    const c = cust(); mk(at(0,h,m), pick([45,60,60,90]), [{ name: c.name, phone: c.phone, lines: [{ serviceId: svcId(), staffId: staffId(si) }] }], k % 2 === 0);
  });
  // A 2-guest party today, two different techs.
  { const a = cust(), b = cust(); mk(at(0,15,0), 60, [
      { name: a.name, phone: a.phone, lines: [{ serviceId: svcId(), staffId: staffId(1) }] },
      { name: b.name, phone: b.phone, lines: [{ serviceId: svcId(), staffId: staffId(2) }] },
    ], true); }
  // Next 3 days — a few each, some Unassigned (staffId '').
  for (let d = 1; d <= 3; d++) {
    const n = ri(2, 4);
    for (let k = 0; k < n; k++) { const c = cust(); const sid = chance(0.3) ? '' : staffId(d + k); mk(at(d, ri(9,17), pick([0,15,30,45])), pick([45,60,90]), [{ name: c.name, phone: c.phone, lines: [{ serviceId: svcId(), staffId: sid }] }], chance(0.5)); }
  }
  return out;
}

// Closed cash-drawer shifts for the last ~10 business days.
function buildDrawerHistory(records) {
  const hist = [];
  for (let d = 10; d >= 1; d--) {
    const day = new Date(); day.setHours(0,0,0,0); day.setDate(day.getDate() - d);
    const dayStart = day.getTime(), dayEnd = dayStart + 864e5;
    const cashSales = records.filter(r => r.checkinTime >= dayStart && r.checkinTime < dayEnd).reduce((s, r) => s + (r.tenders.cash || 0), 0);
    const openTotal = 200;
    const open = new Date(dayStart); open.setHours(9, 0, 0, 0);
    const close = new Date(dayStart); close.setHours(19, 30, 0, 0);
    const cashOut = chance(0.3) ? pick([20, 40, 50]) : 0;
    const expected = openTotal + cashSales - cashOut;
    const overShort = chance(0.5) ? 0 : pick([-5, -2, 1, 3, 5]);
    hist.push({
      id: `drawer-${d}`, openedAt: open.toISOString(), openedBy: 'Front Desk',
      openCounts: { 100: 0, 50: 1, 20: 5, 10: 2, 5: 4, 1: 10 }, openTotal,
      movements: cashOut ? [{ id: `mv-${d}`, type: 'out', amount: cashOut, reason: 'Supplies', at: close.toISOString(), by: 'Manager Mia' }] : [],
      closedAt: close.toISOString(), closedBy: 'Manager Mia',
      closeCounts: {}, closeTotal: expected + overShort, cashSales, cashIn: 0, cashOut, tipsOut: 0, expected, overShort,
    });
  }
  return hist;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
const base = `${WORKER}`;
let _mid = 0;
function authHeaders(extra) { return { ...(extra || {}), ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) }; }
async function login() {
  if (TOKEN) return TOKEN;
  const r = await fetch(`${base}/auth/login?salon=${SALON}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: SEED_PIN, device: 'seed-script' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`login failed -> ${r.status} ${JSON.stringify(j)} (is SEED_PIN a valid front-desk PIN?)`);
  TOKEN = j.token;
  return TOKEN;
}
async function readSnapshot() {
  const r = await fetch(`${base}/state/snapshot?salon=${SALON}`, { headers: authHeaders() });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
async function mutate(op, payload) {
  const r = await fetch(`${base}/state/mutate?salon=${SALON}`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ op, payload, mutationId: `seed-${Date.now()}-${_mid++}` }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`mutate ${op} -> ${r.status} ${t}`); }
  return r.json().catch(() => ({}));
}
async function pool(items, worker, conc) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); done++; }
  }));
  return done;
}

async function main() {
  console.log(`Seeding "${SALON}" at ${base} — ${DAYS} days ending today …`);
  await login();
  console.log('  signed in ✓');

  // Existing id range: overwrite every id that already exists so no stale record
  // from a prior (differently-sized) run is left behind as an orphan.
  let existingMaxRec = 0;
  const before = await readSnapshot();
  if (before) {
    const recs = (before.state || before).records || [];
    for (const r of recs) { const m = /^rec-(\d+)$/.exec(r.id || ''); if (m) existingMaxRec = Math.max(existingMaxRec, +m[1]); }
    console.log(`  existing: ${recs.length} records (max rec-${existingMaxRec})`);
  }

  // 1) Config (one call per key)
  await mutate('config.set', { key: 'services', value: SERVICES });
  await mutate('config.set', { key: 'items', value: ITEMS });
  await mutate('config.set', { key: 'fees', value: FEES });
  await mutate('config.set', { key: 'staff', value: STAFF });
  await mutate('config.set', { key: 'fd_users', value: FD_USERS });
  await mutate('config.set', { key: 'turns_order', value: TURNS_ORDER });
  await mutate('config.set', { key: 'inactive_staff', value: [] });
  await mutate('config.set', { key: 'review_url', value: 'https://g.page/lush-nails-demo/review' });
  await mutate('config.set', { key: 'payment_processor', value: 'none' });   // beta: cash / manual checkout (no in-app terminal)
  console.log('  config ✓');

  // 2) Customers (one bulk call)
  const customers = buildCustomers(320);
  await mutate('customer.bulkUpsert', { customers });
  console.log(`  customers ✓ (${customers.length})`);

  // 3) Records across the last DAYS days (weekend-heavier). Today is PARTIAL — only
  //    the elapsed share of the 9am–7pm business day, capped to the current time —
  //    so the live board + Today report look like a salon mid-shift.
  const nowMs   = Date.now();
  const today   = new Date(); today.setHours(0, 0, 0, 0);
  const bizStart = new Date(today); bizStart.setHours(9, 0, 0, 0);
  const bizEnd   = new Date(today); bizEnd.setHours(19, 0, 0, 0);
  const todayFrac = Math.max(0, Math.min(1, (nowMs - bizStart.getTime()) / (bizEnd.getTime() - bizStart.getTime())));
  const records = [];
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(today); day.setDate(day.getDate() - d);
    const dow = day.getDay();
    let n = (dow === 0) ? ri(8, 14) : (dow === 5 || dow === 6) ? ri(20, 26) : ri(12, 19);
    const capMs = (d === 0) ? nowMs : undefined;
    if (d === 0) n = Math.round(n * todayFrac);
    for (let k = 0; k < n; k++) records.push(buildRecord(day.getTime(), customers, capMs));
  }
  // Pad so the new id set (rec-1..rec-N) fully covers the existing max — clean
  // overwrite, zero orphans, and NO record.delete (a deletion marker would block
  // that id from re-seeding forever).
  while (records.length < existingMaxRec) {
    const d = ri(1, DAYS - 1);                    // a random past (full) business day
    const day = new Date(today); day.setDate(day.getDate() - d);
    records.push(buildRecord(day.getTime(), customers));
  }
  records.forEach((r, i) => { r.id = `rec-${i + 1}`; });
  const okCount = await pool(records, (rec) => mutate('record.save', { record: rec }), CONC);
  console.log(`  records ✓ (${okCount}; covers existing max rec-${existingMaxRec})`);

  // 4) Gift cards
  for (const card of buildGiftcards()) await mutate('giftcard.save', { card });
  console.log('  gift cards ✓');

  // 4b) Appointments (app-native) — a few today + upcoming, one party.
  const appointments = buildAppointments();
  await pool(appointments, (a) => mutate('appt.upsert', { appt: a }), CONC);
  console.log(`  appointments ✓ (${appointments.length})`);

  // 5) Cash-drawer history
  await mutate('config.set', { key: 'cash_drawer_history', value: buildDrawerHistory(records) });
  await mutate('config.set', { key: 'cash_drawer', value: null });
  console.log('  cash drawer history ✓');

  // 6) Owner credential (email + password) — server-hashed, RESTORE_TOKEN-gated.
  //    Skipped unless RESTORE_TOKEN is set, so a routine re-seed leaves the owner
  //    login untouched.
  if (RESTORE_TOKEN) {
    const r = await fetch(`${base}/auth/owner-set?salon=${SALON}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: RESTORE_TOKEN, email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Lush Owner', role: 'owner' }),
    });
    if (!r.ok) console.error(`  owner-set FAILED -> ${r.status} ${await r.text().catch(()=> '')}`);
    else console.log('  owner credential ✓');
  } else {
    console.log('  owner credential — skipped (RESTORE_TOKEN not set; owner login unchanged)');
  }

  const revenue = records.reduce((s, x) => s + x.totalCost, 0);
  const times = records.map(r => r.checkinTime).sort((a, b) => a - b);
  const fmt = ms => new Date(ms).toISOString().slice(0, 10);
  console.log('\n──────── Demo seeded ────────');
  console.log(`Salon link : ${base.replace('.workers.dev','')}  →  open the TurnDesk client with ?salon=${SALON}`);
  console.log(`Records    : ${records.length}  ·  Revenue ~$${revenue.toLocaleString()}  ·  Customers ${customers.length}`);
  console.log(`Window     : ${fmt(times[0])} → ${fmt(times[times.length - 1])} (today partial, ${Math.round(todayFrac * 100)}% of the day)`);
  console.log(`Staff PINs : Front Desk 1111 · Manager Mia 2222 · Techs 1001–1008`);
  if (RESTORE_TOKEN) console.log(`OWNER LOGIN: ${OWNER_EMAIL}  /  ${OWNER_PASSWORD}`);
  console.log('─────────────────────────────');
}

main().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
