// One-command provisioner + config seed for the FIRST real beta salon:
// "Krystal Nails Lounge" (slug: krystal-nails-lounge). Starts FRESH — no
// records/customers/appointments — just a standard, fully-editable nail-salon
// setup: business profile, ~20-service menu, retail items, 5 techs + a manager
// & front-desk login, turns order, manual (cash) checkout.
//
// Idempotent: re-running re-applies the config (config.set overwrites by key).
// If the salon already exists the create step is skipped and the owner login
// is left untouched.
//
// Usage (PowerShell):
//   $env:OPERATOR_TOKEN="<operator token>"; node tools/seed-krystal.mjs
// Optional env: WORKER, SALON, SALON_NAME, OWNER_EMAIL, OWNER_PASSWORD.
//
// OPERATOR_TOKEN is required only to CREATE the salon (the same token the
// operator console uses). Owner credential is set server-side (RESTORE_TOKEN is
// held by the Worker — the caller never needs it).

const WORKER = process.env.WORKER || 'https://turndesk.musenailandspa.workers.dev';
const SALON  = process.env.SALON  || 'krystal-nails-lounge';
const NAME   = process.env.SALON_NAME || 'Krystal Nails Lounge';
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || '';
const OWNER_EMAIL    = process.env.OWNER_EMAIL || 'krystal.owner@turndesk.app';   // placeholder — change in the operator console
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || ('Krystal-' + Math.random().toString(36).slice(2, 9));

// ── Standard nail-salon default (everything editable in-app afterward) ──────────
const BUSINESS = { name: NAME, address: '', phone: '' };   // name shows on the app + receipts; address/phone editable

const SERVICES = [
  { id: 'svc-mani',    label: 'Classic Manicure',      abbr: 'MANI',  baseCost: 25 },
  { id: 'svc-gelmani', label: 'Gel Manicure',          abbr: 'GELM',  baseCost: 38 },
  { id: 'svc-dip',     label: 'Dip Powder',            abbr: 'DIP',   baseCost: 45 },
  { id: 'svc-pedi',    label: 'Classic Pedicure',      abbr: 'PEDI',  baseCost: 35 },
  { id: 'svc-gelpedi', label: 'Gel Pedicure',          abbr: 'GPED',  baseCost: 50 },
  { id: 'svc-spa',     label: 'Deluxe Spa Pedicure',   abbr: 'SPA',   baseCost: 55 },
  { id: 'svc-acrf',    label: 'Acrylic Full Set',      abbr: 'ACRF',  baseCost: 50 },
  { id: 'svc-acrl',    label: 'Acrylic Fill',          abbr: 'FILL',  baseCost: 38 },
  { id: 'svc-gelx',    label: 'Gel-X Full Set',        abbr: 'GELX',  baseCost: 60 },
  { id: 'svc-gelxf',   label: 'Gel-X Fill',            abbr: 'GXF',   baseCost: 45 },
  { id: 'svc-combo',   label: 'Mani + Pedi Combo',     abbr: 'COMBO', baseCost: 58 },
  { id: 'svc-polh',    label: 'Polish Change — Hands', abbr: 'PCH',   baseCost: 15 },
  { id: 'svc-polf',    label: 'Polish Change — Feet',  abbr: 'PCF',   baseCost: 18 },
  { id: 'svc-art',     label: 'Nail Art (per nail)',   abbr: 'ART',   baseCost: 5 },
  { id: 'svc-french',  label: 'French / Design',       abbr: 'FRN',   baseCost: 8 },
  { id: 'svc-repair',  label: 'Nail Repair',           abbr: 'RPR',   baseCost: 6 },
  { id: 'svc-kids',    label: 'Kids Manicure',         abbr: 'KIDS',  baseCost: 18 },
  { id: 'svc-brow',    label: 'Eyebrow Wax',           abbr: 'BROW',  baseCost: 12 },
  { id: 'svc-gelrem',  label: 'Gel Removal',           abbr: 'GRM',   baseCost: 10 },
  { id: 'svc-acrrem',  label: 'Acrylic Removal',       abbr: 'ARM',   baseCost: 15 },
];
const ITEMS = [
  { id: 'item-oil',   label: 'Cuticle Oil', abbr: 'OIL',   price: 12 },
  { id: 'item-cream', label: 'Hand Cream',  abbr: 'CREAM', price: 15 },
  { id: 'item-file',  label: 'Nail File',   abbr: 'FILE',  price: 3 },
];
const FEES = [];   // none — manual/cash checkout for the beta

// 5 placeholder techs (rename + reset PINs in Settings → Staff). PINs 1001–1005.
const STAFF = [1, 2, 3, 4, 5].map(i => ({
  id: `staff-${i}`, name: `Tech ${i}`, legalName: '', commission: 55,
  services: SERVICES.map(s => s.id), pin: String(1000 + i), checkType: 'variable', checkValue: null,
  cashDeductPct: null, cashDeductThreshold: null, app: { pdf: true, history: true, histNames: true },
}));
// Front-desk logins. 'fd-manager' is the id the operator console's manager-PIN
// control expects. Change these PINs in Settings → Team.
const FD_USERS = [
  { id: 'fd-front',   name: 'Front Desk', pin: '1111', role: 'frontdesk' },
  { id: 'fd-manager', name: 'Manager',    pin: '2222', role: 'admin' },
];
const TURNS_ORDER = STAFF.map(s => s.id);

// ── HTTP helpers ────────────────────────────────────────────────────────────────
let TOKEN = '', _mid = 0;
async function createSalon() {
  if (!OPERATOR_TOKEN) throw new Error('OPERATOR_TOKEN env var is required to create the salon.');
  const r = await fetch(`${WORKER}/operator/salons`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPERATOR_TOKEN },
    body: JSON.stringify({ slug: SALON, name: NAME, ownerEmail: OWNER_EMAIL, ownerPassword: OWNER_PASSWORD }),
  });
  if (r.status === 409) { console.log('  salon already exists — skipping create (owner login unchanged)'); return false; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`create failed -> ${r.status} ${JSON.stringify(j)}`);
  console.log('  salon created ✓');
  return true;
}
// A brand-new salon has no fd_users → PIN 1234 (fresh-system fallback) works; a
// re-run has fd_users → the Front Desk PIN 1111 works. Try both.
async function login() {
  for (const pin of ['1234', '1111', '2222']) {
    const r = await fetch(`${WORKER}/auth/login?salon=${SALON}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, device: 'seed-krystal' }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) { TOKEN = j.token; return; }
  }
  throw new Error('could not sign in to seed (tried PIN 1234/1111/2222).');
}
async function mutate(op, payload) {
  const r = await fetch(`${WORKER}/state/mutate?salon=${SALON}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ op, payload, mutationId: `krystal-${Date.now()}-${_mid++}` }),
  });
  if (!r.ok) throw new Error(`mutate ${op} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.json().catch(() => ({}));
}

async function main() {
  console.log(`Provisioning "${NAME}" (${SALON}) at ${WORKER} …`);
  const created = await createSalon();
  await login();
  console.log('  signed in ✓');

  await mutate('config.set', { key: 'business', value: BUSINESS });
  await mutate('config.set', { key: 'services', value: SERVICES });
  await mutate('config.set', { key: 'items', value: ITEMS });
  await mutate('config.set', { key: 'fees', value: FEES });
  await mutate('config.set', { key: 'staff', value: STAFF });
  await mutate('config.set', { key: 'fd_users', value: FD_USERS });
  await mutate('config.set', { key: 'turns_order', value: TURNS_ORDER });
  await mutate('config.set', { key: 'inactive_staff', value: [] });
  await mutate('config.set', { key: 'payment_processor', value: 'none' });   // beta: cash / manual "mark paid"
  console.log('  config seeded ✓ (business, 20 services, 3 items, 5 techs, front-desk + manager, turns order)');

  // Immediately create a first namespaced R2 backup so the new salon has a recovery point.
  try { const b = await fetch(`${WORKER}/state/backup-now?salon=${SALON}`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN } }); const bj = await b.json().catch(() => ({})); if (bj.key) console.log(`  first backup ✓ (${bj.key})`); } catch {}

  console.log('\n──────── Krystal Nails Lounge is ready ────────');
  console.log(`Open       : ${WORKER.replace('.workers.dev', '')} → the TurnDesk client with  ?salon=${SALON}`);
  console.log(`Salon link : https://musenail.github.io/turndesk/?salon=${SALON}`);
  console.log(`Front-desk : Front Desk PIN 1111 · Manager PIN 2222 · Techs 1001–1005  (all editable in Settings)`);
  if (created) console.log(`OWNER LOGIN: ${OWNER_EMAIL}  /  ${OWNER_PASSWORD}   ← SAVE THIS (placeholder — change it in the operator console)`);
  else         console.log(`OWNER LOGIN: unchanged (salon already existed). Use the operator console to see/reset it.`);
  console.log('───────────────────────────────────────────────');
}

main().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
