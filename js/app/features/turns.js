// ── Turns: rotation grid, drag-drop, tech status, turn classification ───────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, todayStr, byName, localDateStr, formatElapsed, partyLetterMap, statusTimeHtml, escHtml, dateBtnLabel } from '../utils.js';
import { GROUP_COLORS } from '../config.js';
import { scopedKey } from '../apptoken.js';   // per-salon isolation for the device-local turns-history snapshot
import { canDo, getActiveUser } from '../session.js';
import { normalizeNotesList, NOTE_MAX } from '../staff-notes-util.js';
import { getAssignmentStatus, isPaidStatus, entryStatusSince, applyAssignmentStatus, serviceLineStyle, effectiveServiceStatus, effectiveEntryStatus, isTechPriced } from './status.js';
import { renderQueue, showGroupAssignModal } from './queue.js';
import { serviceTimeInfo } from './servicetime.js';
import { getBubblePrefs } from './bubble-prefs.js';
import { cardNotePreview, preferredTechIdFor, preferredTechBadgeHtml } from './square-customers.js';

const cfg = () => getState().config;
const q   = () => getState().queue;
const svc = id => cfg().services.find(s => s.id === id);
const staffById = id => cfg().staff.find(s => s.id === id);
const isStaffActive = id => !cfg().inactive_staff.includes(id);

// ── Per-device resizable technician column (desktop) ──────────────────────────
// The tech name/photo column is fixed width; on a wide desktop a long name gets cut off, so the
// right edge is draggable. Clamped so it can't collapse or swallow the board. Device-local (like
// the text size) and applied as a CSS var on #panel-turns so a live resize never rebuilds the grid
// (a rebuild would reset every lane's horizontal scroll).
const TURNS_TECHCOL_MIN = 120, TURNS_TECHCOL_MAX = 280, TURNS_TECHCOL_DEFAULT = 155;
export function _clampTechColW(px) {
  const n = Math.round(Number(px));
  return Number.isFinite(n) ? Math.max(TURNS_TECHCOL_MIN, Math.min(TURNS_TECHCOL_MAX, n)) : TURNS_TECHCOL_DEFAULT;
}
const turnsTechColW = () => _clampTechColW(parseInt(localStorage.getItem('turndesk_turns_techcol_w'), 10) || TURNS_TECHCOL_DEFAULT);
function _applyTurnsTechColW() { document.getElementById('panel-turns')?.style.setProperty('--turns-techcol-w', turnsTechColW() + 'px'); }
function setTurnsTechColW(px) { localStorage.setItem('turndesk_turns_techcol_w', String(_clampTechColW(px))); _applyTurnsTechColW(); }
// The turn-count column (its own column just left of the turn bubbles) is resizable the same way.
const TURNS_TOTALCOL_MIN = 44, TURNS_TOTALCOL_MAX = 140, TURNS_TOTALCOL_DEFAULT = 72;   // fits count / +Nb bonus / $billed stacked
export function _clampTotalColW(px) {
  const n = Math.round(Number(px));
  return Number.isFinite(n) ? Math.max(TURNS_TOTALCOL_MIN, Math.min(TURNS_TOTALCOL_MAX, n)) : TURNS_TOTALCOL_DEFAULT;
}
const turnsTotalColW = () => _clampTotalColW(parseInt(localStorage.getItem('turndesk_turns_totalcol_w'), 10) || TURNS_TOTALCOL_DEFAULT);
function _applyTurnsTotalColW() { document.getElementById('panel-turns')?.style.setProperty('--turns-totalcol-w', turnsTotalColW() + 'px'); }
function setTurnsTotalColW(px) { localStorage.setItem('turndesk_turns_totalcol_w', String(_clampTotalColW(px))); _applyTurnsTotalColW(); }

// Turn-number badge style, shared by the live grid + history so the two can't drift: amber half,
// light-teal bonus, neutral grey for an unpriced "?" (so it never reads as a counted turn), and a
// solid teal pill for a real turn number (was a faint opacity:0.75 — easy to miss).
const turnPillStyle = (tt, label, estimated) =>
    estimated      ? 'background:#e3e8ea;color:#5a6b70;padding:0 5px;border-radius:4px'   // provisional (from expected price, not yet real)
  : tt === 'half'  ? 'background:#f5c870;color:#3a2800;padding:0 4px;border-radius:4px'
  : tt === 'bonus' ? 'background:#a9d2c7;color:#134b3c;padding:0 4px;border-radius:4px'
  : label === '?'  ? 'background:#e3e8ea;color:#5a6b70;padding:0 5px;border-radius:4px'
  :                  'background:#1a5252;color:#fff;padding:0 5px;border-radius:4px';
const activeStaff = () => cfg().staff.filter(s => isStaffActive(s.id));

const setOrder = order => dispatch('config.set', { key: 'turns_order', value: order });
const setBreak = arr   => dispatch('config.set', { key: 'turns_break', value: arr });
const setOff   = arr   => dispatch('config.set', { key: 'turns_off',   value: arr });

let turnsViewingHistory = null;
let turnsHistory = JSON.parse(localStorage.getItem(scopedKey('turndesk_turns_history')) || '{}');
function saveTurnsHistory() { try { localStorage.setItem(scopedKey('turndesk_turns_history'), JSON.stringify(turnsHistory)); } catch (e) { console.warn('[turns] history save failed (quota?)', e); } }

// ── Turn config + classification (formerly in app.js) ─────────────────────────
export function getTurnConfig() {
  // Each category is its own independent "$X or less" cutoff: a service is a BONUS turn if its
  // price ≤ bonusMax, a HALF turn if ≤ halfMax (and above the bonus cutoff), else a FULL turn. Half
  // and bonus toggle on/off independently; bonus always uses its own cutoff even when half is off.
  const defaults = {
    bonusMax: 11, halfMax: 27,
    halfEnabled: true, bonusEnabled: true,
    halfByCost: true, halfByService: false,
    bonusByCost: true, bonusByService: true,
    precedence: 'bonusFirst',
    countOnAssign: true,   // count a turn as soon as a customer is assigned (any status), via the base price
    dedicatedBonusCounters: false,   // v5.91: show the first ≤3 always-bonus services as their own per-tech counters
  };
  const stored = cfg().turn_config || {};
  const merged = { ...defaults, ...stored };
  // Migrate pre-v5.80 installs ({fullMin, halfMin}: old bonus was < halfMin, half was [halfMin, fullMin))
  // to the new "$X or less" cutoffs, unless the new keys were set explicitly.
  if (stored.bonusMax == null && stored.halfMin != null) merged.bonusMax = Math.max(1, stored.halfMin - 1);
  if (stored.halfMax == null && stored.fullMin != null) merged.halfMax = Math.max(merged.bonusMax + 1, stored.fullMin - 1);
  return merged;
}
// Merge a partial patch over the stored turn_config so a single-setting save never wipes the other
// turn keys (the key is stored whole). Pure → unit-tested; every writer must pass a PARTIAL patch.
export function _mergeTurnConfig(stored, patch) { return { ...(stored || {}), ...patch }; }
export function saveTurnConfig(patch) { dispatch('config.set', { key: 'turn_config', value: _mergeTurnConfig(cfg().turn_config, patch) }); }
export function isAlwaysBonusService(serviceId) { return (cfg().bonus_services || []).includes(serviceId); }
export function saveBonusServices(ids) { dispatch('config.set', { key: 'bonus_services', value: ids }); }
// v5.91: the first ≤3 always-bonus services (deduped, live-only, bonus_services order) that get their
// own dedicated per-tech counter. Deduped so a repeated id can never double-count the display subtraction.
export function getDedicatedBonusServices() {
  const svcById = new Map((cfg().services || []).map(s => [s.id, s]));
  const out = [];
  for (const id of new Set(cfg().bonus_services || [])) {
    const s = svcById.get(id); if (!s) continue;
    // Prefer the service's own abbr; a service with none (legacy — new ones require it) falls back to a
    // short 4-char code from the label rather than a truncated long name.
    const abbr = (s.abbr || '').trim() || (s.label || '').trim().slice(0, 4) || '?';
    out.push({ id, abbr, label: s.label || s.abbr || id });
    if (out.length === 3) break;
  }
  return out;
}
// The general "+Nb" bonus a tech shows when dedicated counters are on: all bonus MINUS the dedicated
// add-ons. One source of truth so the turns board and the floor roster can never drift. dedSum ≤ bonus
// by construction (deduped ids), so the clamp is defensive, never load-bearing.
export function generalBonusCount(techTurns, dedServices) {
  const ded = techTurns.dedicated || {};   // harden against a caller that passes a non-live-tally object
  const dedSum = (dedServices || []).reduce((s, x) => s + (ded[x.id] || 0), 0);
  return Math.max(0, (techTurns.bonus || 0) - dedSum);
}
export function isHalfService(serviceId) { return (cfg().half_services || []).includes(serviceId); }
export function saveHalfServices(ids) { dispatch('config.set', { key: 'half_services', value: ids }); }

// Pure turn classifier (Item D). Honors the half/bonus on-off toggles, the by-cost / by-service
// methods (both may be active → OR'd), and the owner-selectable precedence. A service-list match
// classifies even when UNPRICED (so an always-bonus service reads 'bonus' at $0, as before);
// amount<=0 with no service match → 'unpriced' (not counted). Flags are injected (isBonusSvc/
// isHalfSvc) so it's testable without app state.
export function classifyAmount(amount, serviceId, c, flags) {
  const isBonusSvc = !!(flags && flags.isBonusSvc);
  const isHalfSvc  = !!(flags && flags.isHalfSvc);
  const svcBonus  = c.bonusEnabled && c.bonusByService && isBonusSvc;
  const svcHalf   = c.halfEnabled  && c.halfByService  && isHalfSvc;
  // "$X or less" cutoffs. The bands are NON-overlapping (half sits strictly above the bonus cutoff),
  // so bonus always wins the low end and half is "above bonus, up to its own cutoff".
  const bonusByCostOn = c.bonusEnabled && c.bonusByCost;
  const costBonus = bonusByCostOn && amount > 0 && amount <= c.bonusMax;
  const halfLo    = bonusByCostOn ? c.bonusMax : 0;
  const costHalf  = c.halfEnabled && c.halfByCost && amount > halfLo && amount <= c.halfMax;
  const costFull  = amount > 0 && !costBonus && !costHalf;   // priced, above the active cutoffs
  if (amount <= 0 && !svcBonus && !svcHalf) return 'unpriced';
  const bonus = svcBonus || costBonus;
  const half  = svcHalf  || costHalf;
  if (c.precedence === 'highestValue') {
    if (costFull) return 'full';
    if (half) return 'half';
    if (bonus) return 'bonus';
    return 'full';
  }
  if (c.precedence === 'costWins') {
    if (amount > 0) {
      if (costBonus) return 'bonus';
      if (costHalf) return 'half';
      return 'full';
    }
    if (svcBonus) return 'bonus';
    if (svcHalf) return 'half';
    return 'unpriced';
  }
  // 'bonusFirst' (default): bonus beats half beats full
  if (bonus) return 'bonus';
  if (half) return 'half';
  return 'full';
}

export function classifyTurn(cost, serviceId) {
  return classifyAmount(cost || 0, serviceId, getTurnConfig(), {
    isBonusSvc: isAlwaysBonusService(serviceId),
    isHalfSvc: isHalfService(serviceId),
  });
}

// Status-aware class: an unpriced service counts via its EXPECTED price (baseCost) — reclassified to
// the real value once a price is entered. WHEN it starts counting depends on config.countOnAssign:
//   on  (default) → as soon as it's assigned, at ANY status (waiting / in service / done)
//   off           → only once it's DONE ('complete') — the earlier count-at-Done behavior
// Either way, no base price + no entered price → 'unpriced' (not counted; the board shows a "?").
// A comp keeps its real a.cost, so it classifies by that. This NEVER writes a.cost.
export function turnClassOf(a) {
  if (!a) return 'unpriced';
  const c = getTurnConfig();
  const priced = (a.cost || 0) > 0;
  const countEarly = c.countOnAssign || a.status === 'complete';
  const expected = priced ? a.cost : (countEarly ? (svc(a.serviceId)?.baseCost || 0) : 0);
  return classifyAmount(expected || 0, a.serviceId || '', c, {
    isBonusSvc: isAlwaysBonusService(a.serviceId),
    isHalfSvc: isHalfService(a.serviceId),
  });
}

// The grey "~N" provisional cue applies ONLY to a number-bearing (full/half) turn counted from the
// expected price on a done/awaiting-price service that isn't priced yet — the number may shift when a
// real price lands. A 'bonus' shows the word "Bonus" (keeps its teal pill), and 'unpriced' shows '?'.
export function isEstimatedTurn(a, tt) {
  const countEarly = getTurnConfig().countOnAssign || a.status === 'complete';
  return (a.cost || 0) === 0 && countEarly && (tt === 'full' || tt === 'half');
}

// The rotation, excluding any ids that are blank or belong to deactivated staff
// (a tech deactivated after being added to the rotation must not linger on the
// grid / in suggestions). turns_order self-heals on the next roster edit.
export function getActiveTurnsOrder() { return cfg().turns_order.filter(id => id && typeof id === 'string' && isStaffActive(id)); }

export function getActiveTechEntries(staffId) {
  return q().filter(e => e.status === 'inservice' && (e.assignments||[]).some(a => a.techId === staffId && getAssignmentStatus(e, a) === 'inservice'));
}

export function getTechAllAssignments(techId) {
  const today = new Date(); today.setHours(0,0,0,0);
  const result = [];
  q().forEach(e => {
    const d = new Date(e.checkinTime);
    if (d < today) return;
    (e.assignments||[]).forEach(a => { if (a.techId === techId) result.push({ entry: e, assignment: a }); });
  });
  result.sort((a, b) => {
    const ta = a.assignment.assignedAt || new Date(a.entry.checkinTime).getTime();
    const tb = b.assignment.assignedAt || new Date(b.entry.checkinTime).getTime();
    return ta - tb;
  });
  return result;
}

// Manual "skip a turn": records a phantom full turn for a tech (no customer) so the
// rotation advances past them. Stored per-day in config.turns_skips, counted like a full
// turn, and shown as a removable greyed slot in the grid.
export const todaySkips = techId => (cfg().turns_skips || []).filter(s => s.techId === techId && localDateStr(new Date(s.at)) === todayStr());
export function skipTurnForTech(techId) {
  if (!techId) return;
  const kept = (cfg().turns_skips || []).filter(s => localDateStr(new Date(s.at)) === todayStr());   // prune older days
  dispatch('config.set', { key: 'turns_skips', value: [...kept, { id: 'skip-' + Date.now(), techId, at: new Date().toISOString() }] });
  renderTurns(); showToast('Turn skipped');
}
export function skipTurnFromModal() { const id = turnsAssignTarget?.techId; closeTurnsAssignModal(); skipTurnForTech(id); }
export function removeTurnSkip(skipId) {
  dispatch('config.set', { key: 'turns_skips', value: (cfg().turns_skips || []).filter(s => s.id !== skipId) });
  renderTurns();
}

export function getTechTurns(techId) {
  let full = 0, half = 0, bonus = 0, unknown = 0;
  // Per-serviceId tally of bonus turns, set-agnostic (every bonus turn keyed by its service). The
  // display reads only the ≤3 dedicated services out of this; keeping it uncapped decouples the count
  // from the "which 3" logic and keeps Σ(dedicated over the 3) ≤ bonus by construction.
  const dedicated = {};
  getTechAllAssignments(techId).forEach(({ assignment: a }) => {
    const t = turnClassOf(a);
    if (t === 'full') full++;
    else if (t === 'half') half += 0.5;
    else if (t === 'bonus') { bonus++; if (a.serviceId) dedicated[a.serviceId] = (dedicated[a.serviceId] || 0) + 1; }
    else if (t === 'unpriced') unknown++;   // assigned but can't be counted yet (no base/typed price) → "?" on the board
  });
  full += todaySkips(techId).length;   // each manual skip counts as a full turn
  return { full, half, bonus, total: full + half, unknown, dedicated };
}

// ── Item 3: don't recommend a tech holding a still-waiting (assigned, not-started) customer ──
// A tech reads "Available" while a customer is assigned-but-waiting; these keep such a tech out of the
// suggestions AND the "Next up" badge — but if EVERY available tech is holding someone, the pool falls
// back to the full set so there's always a who's-next (owner's rule).
export function _hasPendingAssignment(statuses) { return (statuses || []).some(s => s === 'waiting'); }
export function techHasPendingAssignment(techId) {
  return _hasPendingAssignment(getTechAllAssignments(techId).map(({ entry, assignment }) => getAssignmentStatus(entry, assignment)));
}
export function _dropHolders(ids, holdsFn) {
  const kept = (ids || []).filter(id => !holdsFn(id));
  return kept.length ? kept : (ids || []);
}

export function getTechStatusColor(staffId) {
  if (cfg().turns_off.includes(staffId))   return { bg: '#f3f4f6', text: '#9ca3af', label: 'Off' };
  if (cfg().turns_break.includes(staffId)) return { bg: '#f5c870', text: '#3a2800', label: 'On Break' };
  if (getActiveTechEntries(staffId).length > 0) return { bg: '#fa746f', text: '#fff', label: 'In Service' };
  return { bg: '#2a7a4f', text: '#fff', label: 'Available' };
}

// ── Suggestion engine ─────────────────────────────
// Can this tech perform this service? An empty (or absent) service menu = does everything.
export function _techDoesService(st, serviceId) {
  if (!st) return false;
  const list = st.services;
  return !list || list.length === 0 || list.includes(serviceId);
}
// Split the service catalog into what this tech CAN vs CAN'T do (for the tech-status popup's two columns).
// Empty/absent menu = does everything, so unavailable is empty. Catalog order is preserved in both lists.
export function _techServiceSplit(st, catalog) {
  const all = (catalog || []).filter(s => s && s.id);
  const list = st && st.services;
  if (!list || list.length === 0) return { available: all, unavailable: [] };
  const set = new Set(list);
  return { available: all.filter(s => set.has(s.id)), unavailable: all.filter(s => !set.has(s.id)) };
}
export function suggestTechForService(serviceId) {
  const order = getActiveTurnsOrder();
  if (order.length === 0) return null;
  const isBonus = isAlwaysBonusService(serviceId);
  const eligible = order.filter(id => {
    const st = staffById(id);
    if (!st) return false;
    if (cfg().turns_break.includes(id) || cfg().turns_off.includes(id)) return false;
    if (!_techDoesService(st, serviceId)) return false;   // skills checked FIRST — never suggest a tech who can't do it
    return getActiveTechEntries(id).length === 0;
  });
  if (eligible.length === 0) return null;
  const pool = _dropHolders(eligible, techHasPendingAssignment);   // skip techs holding a waiting customer (fallback if all are)
  // Fewest turns → (for a bonus service) fewest bonus turns → rotation order.
  pool.sort((a, b) => {
    const ta = getTechTurns(a), tb = getTechTurns(b);
    if (ta.total !== tb.total) return ta.total - tb.total;
    if (isBonus && ta.bonus !== tb.bonus) return ta.bonus - tb.bonus;
    return order.indexOf(a) - order.indexOf(b);
  });
  const best = pool[0];
  return { techId: best, techName: staffById(best)?.name || '?' };
}
// ── Coordinated per-customer suggestions (one tech per service) ───────────────
// Preference ranking for regular services — most preferred (largest) first. The
// most-preferred service is handed to the next-up (fewest-turns) tech. Wax / add-on
// are bonus: assigned first to the limited techs who can do them, and those techs
// are kept off regular work when a generalist can take it instead.
const SERVICE_PREF_ORDER = ['fullset','fill','dip','manicure','pedicure','polishchange','kidpedicure'];
const servicePrefRank = id => { const i = SERVICE_PREF_ORDER.indexOf(id); return i === -1 ? SERVICE_PREF_ORDER.length : i; };
// A limited bonus tech = a RESTRICTED menu that includes a bonus service (the
// "only 1–2 can do wax" specialists). Generalists (empty menu) are not flagged.
function isLimitedBonusTech(id) {
  const st = staffById(id); if (!st) return false;
  const list = st.services || [];
  return list.length > 0 && list.some(s => isAlwaysBonusService(s));
}

// W2-4 preferred-tech NUDGE (pure core). The caller has already confirmed `prefId` is ELIGIBLE
// (checked-in, not off/break, free, passed dropHolders). Given the customer's still-needed services,
// returns the ONE { techId, serviceId } to hand the preferred tech first, or null (no nudge → pure
// fairness). `canDo(sid)` = can the preferred tech do sid. If the preferred tech is a limited-bonus
// specialist and the customer needs a bonus service they can do, hand them THAT (so pre-assigning them
// a regular line doesn't strand a bonus service only they can take); otherwise their highest-preference
// doable service. Never changes turn counts — only which tech is suggested.
export function nudgeDecision(prefId, need, { canDo, isBonusSvc, isLimitedBonus, prefRank }) {
  if (!prefId) return null;
  const doable = (need || []).filter(sid => canDo(sid));
  if (!doable.length) return null;
  const byPref = arr => [...arr].sort((a, b) => prefRank(a) - prefRank(b));
  if (isLimitedBonus) {
    const bonus = doable.filter(isBonusSvc);
    if (bonus.length) return { techId: prefId, serviceId: byPref(bonus)[0] };
  }
  return { techId: prefId, serviceId: byPref(doable)[0] };
}

// For ONE customer: suggest a DIFFERENT tech for each still-waiting, unassigned
// service. Bonus services route to the specialists first; regular services then go
// out in preference order, the most-preferred to the fewest-turns tech, preferring
// generalists so the specialists stay free for bonus work. No tech is reused within
// the customer. Returns { serviceId: { techId, techName } }.
export function suggestTechsForEntry(entry) {
  const out = {};
  if (!entry) return out;
  const order = getActiveTurnsOrder();
  if (!order.length) return out;
  const need = (entry.services || []).filter(sid => {
    const a = (entry.assignments || []).find(x => x.serviceId === sid);
    const st = a ? getAssignmentStatus(entry, a) : 'waiting';
    return st === 'waiting' && !(a && a.techId);
  });
  if (!need.length) return out;
  const eligibleBase = _dropHolders(   // skip techs holding a waiting customer (fallback if all are)
    order.filter(id => !cfg().turns_break.includes(id) && !cfg().turns_off.includes(id) && getActiveTechEntries(id).length === 0),
    techHasPendingAssignment);
  const used = new Set();
  const canDo = (id, sid) => _techDoesService(staffById(id), sid);
  // kind 'bonus' = pure fairness rotation (fewest turns → fewest bonus → order). kind 'regular'
  // keeps generalists (empty menu) floated to the front so the limited-menu techs stay free.
  const pick = (sid, kind) => {
    const cands = eligibleBase.filter(id => !used.has(id) && canDo(id, sid));
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ta = getTechTurns(a), tb = getTechTurns(b);
      if (kind === 'regular') {
        const la = isLimitedBonusTech(a) ? 1 : 0, lb = isLimitedBonusTech(b) ? 1 : 0;
        if (la !== lb) return la - lb;   // generalist first
        return ta.total - tb.total || order.indexOf(a) - order.indexOf(b);
      }
      // bonus: fewest turns → fewest bonus → order
      return ta.total - tb.total || ta.bonus - tb.bonus || order.indexOf(a) - order.indexOf(b);
    });
    return cands[0];
  };
  const assign = (sid, kind) => { const id = pick(sid, kind); if (id) { used.add(id); out[sid] = { techId: id, techName: staffById(id)?.name || '?' }; } };
  // W2-4 nudge: if this customer has an explicit preferred tech who is ELIGIBLE right now, hand them
  // one of the customer's needed services first; the fairness passes below fill the rest. Only reorders
  // suggestions — turn counts are untouched, and an ineligible preferred tech silently falls back.
  let needList = need;
  const prefId = preferredTechIdFor(entry.phone);
  if (prefId && eligibleBase.includes(prefId)) {
    const nd = nudgeDecision(prefId, needList, {
      canDo: sid => canDo(prefId, sid),
      isBonusSvc: isAlwaysBonusService,
      isLimitedBonus: isLimitedBonusTech(prefId),
      prefRank: servicePrefRank,
    });
    if (nd) { used.add(nd.techId); out[nd.serviceId] = { techId: nd.techId, techName: staffById(nd.techId)?.name || '?' }; needList = needList.filter(s => s !== nd.serviceId); }
  }
  needList.filter(sid => isAlwaysBonusService(sid)).forEach(sid => assign(sid, 'bonus'));
  needList.filter(sid => !isAlwaysBonusService(sid))
    .sort((a, b) => servicePrefRank(a) - servicePrefRank(b))
    .forEach(sid => assign(sid, 'regular'));
  return out;
}

function buildSuggestions() {
  const suggestions = {};
  q().filter(e => !isPaidStatus(e.status)).forEach(e => { suggestions[e.id] = suggestTechsForEntry(e); });
  return suggestions;
}

// Accept a suggested tech for ONE service: assign it (status stays waiting) and
// open the assign/price modal so the front desk can price it, then advance to
// In Service or just save while still waiting.
export function acceptSuggestion(entryId, serviceId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const sug = suggestTechsForEntry(entry)[serviceId];
  if (!sug) { showToast('No available technician to suggest right now.'); return; }
  if (!entry.assignments) entry.assignments = [];
  let a = entry.assignments.find(x => x.serviceId === serviceId);
  if (!a) { a = { serviceId, status: 'waiting' }; entry.assignments.push(a); }
  a.techId = sug.techId;
  applyAssignmentStatus(a, 'waiting');
  if (!a.assignedAt) a.assignedAt = Date.now();
  dispatch('queue.upsert', { entry });
  showGroupAssignModal(String(entryId));
}
function acceptBtnHtml(entryId, serviceId, techName) {
  // onpointerdown stop: otherwise the card's drag engine arms pendingEntry on this tap,
  // then hijacks the first scroll gesture inside the modal we open (freezes scrolling).
  return ` <button onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();acceptSuggestion('${entryId}','${serviceId}')" title="Assign ${techName}" style="pointer-events:auto;cursor:pointer;color:#1a5252;vertical-align:middle" class="hover:opacity-70"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;font-variation-settings:'FILL' 1">check_circle</span></button>`;
}

// ── Render ────────────────────────────────────────
export function renderTurns() { _applyTurnsTextSize(); _applyTurnsTotals(); _applyTurnsHideOffBtn(); _applyTurnsTechColW(); _applyTurnsTotalColW(); renderTurnsTechGrid(); renderTurnsQueue(); applyTurnsApptStripVisibility(); startTurnsApptRefresh(); }

// ── Per-device "$ billed" totals show/hide (Turns toolbar) ────────────────────
// Device-local (like the text size) — hide each tech's billed dollar total on a
// shared screen so staff don't compare earnings. Applied as a panel class; the
// CSS hides .turns-billed. Turn counts stay visible.
let _turnsTotalsShow = localStorage.getItem('turndesk_turns_totals') !== '0';
function _applyTurnsTotals() {
  document.getElementById('panel-turns')?.classList.toggle('turns-hide-totals', !_turnsTotalsShow);
  const btn = document.getElementById('turns-totals-toggle');
  if (btn) {
    btn.classList.toggle('bg-primary', _turnsTotalsShow);
    btn.classList.toggle('text-on-primary', _turnsTotalsShow);
    btn.classList.toggle('border-primary', _turnsTotalsShow);
    btn.classList.toggle('text-on-surface-variant', !_turnsTotalsShow);
    btn.classList.toggle('border-surface-container-high', !_turnsTotalsShow);
    btn.title = _turnsTotalsShow ? 'Tech billed totals shown — tap to hide' : 'Tech billed totals hidden — tap to show';
  }
  const ic = document.getElementById('turns-totals-icon');
  if (ic) ic.textContent = _turnsTotalsShow ? 'visibility' : 'visibility_off';
}
export function toggleTurnsTotals() {
  _turnsTotalsShow = !_turnsTotalsShow;
  localStorage.setItem('turndesk_turns_totals', _turnsTotalsShow ? '1' : '0');
  _applyTurnsTotals();
  showToast(_turnsTotalsShow ? 'Tech totals shown (this device) ✓' : 'Tech totals hidden (this device) ✓');
}

// NL5: hide/show clocked-out ("Off") technicians on the board (per device, like Totals/Appointments).
let _turnsHideOff = localStorage.getItem('turndesk_turns_hide_off') === '1';
function _applyTurnsHideOffBtn() {
  const btn = document.getElementById('turns-hideoff-toggle');
  if (!btn) return;
  // Icon stays the static people glyph (distinct from the Totals eye); the highlight + title show state.
  btn.classList.toggle('bg-primary', _turnsHideOff);
  btn.classList.toggle('text-on-primary', _turnsHideOff);
  btn.classList.toggle('border-primary', _turnsHideOff);
  btn.classList.toggle('text-on-surface-variant', !_turnsHideOff);
  btn.classList.toggle('border-surface-container-high', !_turnsHideOff);
  btn.title = _turnsHideOff ? 'Off technicians hidden — tap to show' : 'Off technicians shown — tap to hide';
}
export function toggleTurnsHideOff() {
  _turnsHideOff = !_turnsHideOff;
  localStorage.setItem('turndesk_turns_hide_off', _turnsHideOff ? '1' : '0');
  _applyTurnsHideOffBtn();
  renderTurnsTechGrid();
  showToast(_turnsHideOff ? 'Off techs hidden (this device) ✓' : 'Off techs shown (this device) ✓');
}

// ── Per-device Turns text size (C8) ───────────────
// Device-local (like turndesk_cal_hours) — the front-desk monitor can run Large while the
// iPad stays Standard. Applied as a panel class; the size overrides live in styles.css.
const turnsLarge = () => localStorage.getItem('turndesk_turns_large') === '1';
function _applyTurnsTextSize() { document.getElementById('panel-turns')?.classList.toggle('turns-large', turnsLarge()); }
export function setTurnsLarge(on) {
  localStorage.setItem('turndesk_turns_large', on ? '1' : '0');
  _applyTurnsTextSize(); renderTurnsDisplaySettings();
  showToast(on ? 'Turns board: large text (this device) ✓' : 'Turns board: standard text (this device) ✓');
}
export function renderTurnsDisplaySettings() {
  const host = document.getElementById('turns-display-buttons');
  const on  = 'flex-1 px-4 py-3 rounded-xl border font-body font-bold text-sm bg-primary text-on-primary border-primary';
  const off = 'flex-1 px-4 py-3 rounded-xl border font-body font-semibold text-sm bg-surface-container-lowest text-on-surface border-surface-container-high hover:bg-surface-container';
  if (host) host.innerHTML = `
    <button onclick="setTurnsLarge(false)" class="${turnsLarge() ? off : on}">Standard</button>
    <button onclick="setTurnsLarge(true)" class="${turnsLarge() ? on : off}">Large<span class="block text-[10px] font-normal opacity-80">easier to read from a distance</span></button>`;
  renderTurnsSepSettings();
}

// ── Per-device Turns row separator (divider vs recessed lane) ──────────────────
// Device-local (like the text size) — how the tech box is set apart from the turn
// bubbles so they don't read as one merged block. 'divider' = a thin rule; 'lane' =
// the bubbles sit in a tinted recessed track. Applied in renderTurnsTechGrid.
const turnsSep = () => localStorage.getItem('turndesk_turns_sep') === 'lane' ? 'lane' : 'divider';
export function setTurnsSep(mode) {
  localStorage.setItem('turndesk_turns_sep', mode === 'lane' ? 'lane' : 'divider');
  if (!turnsViewingHistory) renderTurnsTechGrid();
  renderTurnsSepSettings();
  showToast(mode === 'lane' ? 'Turns board: recessed lane (this device) ✓' : 'Turns board: divider line (this device) ✓');
}
function renderTurnsSepSettings() {
  const host = document.getElementById('turns-sep-buttons'); if (!host) return;
  const on  = 'flex-1 px-4 py-3 rounded-xl border font-body font-bold text-sm bg-primary text-on-primary border-primary';
  const off = 'flex-1 px-4 py-3 rounded-xl border font-body font-semibold text-sm bg-surface-container-lowest text-on-surface border-surface-container-high hover:bg-surface-container';
  const sep = turnsSep();
  host.innerHTML = `
    <button onclick="setTurnsSep('divider')" class="${sep === 'divider' ? on : off}">Divider line<span class="block text-[10px] font-normal opacity-80">a thin rule between</span></button>
    <button onclick="setTurnsSep('lane')" class="${sep === 'lane' ? on : off}">Recessed lane<span class="block text-[10px] font-normal opacity-80">bubbles in a tinted track</span></button>`;
}

// ── Upcoming appointments (Google Calendar) on the Turns sheet ────────────────
// Strip = the "Next up" row (toggled by the Appointments button, device-local).
// In-grid note = an always-on amber card in a tech's next-turn slot when their next
// upcoming appt is ≤30 min away. Data comes from window.apptsForTurns() (calendar.js),
// which already filters to upcoming-only (not passed / no-show / checked-in).
let _turnsApptTimer = null;
let _turnsApptShow = localStorage.getItem('turndesk_turns_appts_show') === '1';
const _tEsc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function turnsUpcomingAppts() { try { return window.apptsForTurns?.() || []; } catch { return []; } }

export function toggleTurnsApptStrip() {
  _turnsApptShow = !_turnsApptShow;
  localStorage.setItem('turndesk_turns_appts_show', _turnsApptShow ? '1' : '0');
  applyTurnsApptStripVisibility();
}
function applyTurnsApptStripVisibility() {
  const strip = document.getElementById('turns-appts-strip'), btn = document.getElementById('turns-appts-toggle');
  const panel = document.getElementById('panel-turns');
  const hide = !_turnsApptShow || !!turnsViewingHistory;
  if (strip) strip.classList.toggle('hidden', hide);
  if (btn) {
    btn.classList.toggle('bg-primary', _turnsApptShow);
    btn.classList.toggle('text-on-primary', _turnsApptShow);
    btn.classList.toggle('border-primary', _turnsApptShow);
    btn.classList.toggle('text-on-surface-variant', !_turnsApptShow);
    btn.classList.toggle('border-surface-container-high', !_turnsApptShow);
  }
  if (!hide) renderTurnsApptStrip();
  // Keep the strip anchored under the header (no page scroll) by shrinking the
  // grid + side-panel scroll height to absorb the strip's height; only the grid
  // scrolls. 186px is the header budget (was 210; the ~24px color legend moved to the account menu);
  // +12 is the strip's bottom margin (mb-3).
  if (panel) { const extra = (!hide && strip) ? strip.offsetHeight + 12 : 0; panel.style.setProperty('--turns-offset', (186 + extra) + 'px'); }
}
export function renderTurnsApptStrip() {
  const host = document.getElementById('turns-appts-cards'); if (!host) return;
  const sub = document.getElementById('turns-appts-sub');
  // Collapse the per-tech entries back to one card per booking for the strip.
  const seen = new Map();
  turnsUpcomingAppts().forEach(a => { const k = a.startMs + '|' + a.name; if (!seen.has(k)) seen.set(k, { startMs: a.startMs, name: a.name, svc: a.svc, techs: new Set(), apptId: a.apptId, notes: a.notes }); if (a.techName) seen.get(k).techs.add(a.techName); });
  const cards = [...seen.values()];
  if (sub) sub.textContent = cards.length ? `· ${cards.length} upcoming` : '· nothing upcoming';
  if (!cards.length) { host.innerHTML = `<div class="text-xs text-on-surface-variant py-3 px-1 opacity-70">No upcoming appointments today.</div>`; return; }
  const now = Date.now();
  const _tJs = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').replace(/\r/g, '');
  // Compact bubble matching a turn-grid slot: w-[150px], rounded-xl, soft fill
  // (lavender = appointment, amber = ≤30 min). Two lines so the strip stays short.
  host.innerHTML = cards.map(a => {
    const time = new Date(a.startMs).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    const mins = Math.round((a.startMs - now)/60000), late = mins < 0, soon = !late && mins <= 30;
    const techLbl = [...a.techs].join(', ') || 'Unassigned';
    const bg = late ? '#ffd9d9' : soon ? '#ffe0b2' : '#ede7f6', fg = late ? '#7a1a1a' : soon ? '#6d3200' : '#42306b';
    const badge = late ? `<span class="text-[9px] font-bold flex-shrink-0" style="color:#b91c1c">${-mins}m late</span>`
               : soon ? `<span class="text-[9px] font-bold flex-shrink-0" style="color:#9a4a00">${mins}m</span>` : '';
    return `<div class="flex-shrink-0 w-[150px] px-0.5"><div onclick="calEventClick(event,'${_tJs(a.apptId)}')" class="w-full rounded-xl px-2 py-1 text-left text-xs font-body cursor-pointer active:scale-95 transition-transform" style="background:${bg};color:${fg}">
      <div class="flex items-center gap-1"><span class="font-bold text-[11px] flex-shrink-0">${time}</span><span class="font-semibold text-[11px] truncate" style="flex:1;min-width:0">${_tEsc(a.name)}</span>${badge}</div>
      <div class="text-[10px] leading-tight truncate" style="opacity:.8">${_tEsc(a.svc)} · ${_tEsc(techLbl)}</div>
    </div></div>`;
  }).join('');
}
function turnsDueNoteCard(a, mins, slotH) {
  const time = new Date(a.startMs).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  const late = mins < 0;
  const bg = late ? '#ffd9d9' : '#fff7e6', border = late ? '#dc2626' : '#f5a623', icon = late ? '#b91c1c' : '#c77700';
  const label = late ? 'Late appt' : 'Next appt', when = late ? `${-mins}m late` : `in ${mins}m`;
  const nameC = late ? '#7a1a1a' : '#5a3a00', whenC = late ? '#b91c1c' : '#8a5a00', svcC = late ? '#8a3030' : '#7a5a10';
  return `<div class="flex-shrink-0 w-[150px] px-1"><div class="w-full rounded-xl px-2 py-1.5 text-left text-xs font-body" style="background:${bg};border:2px solid ${border};min-height:${slotH || 66}px">
    <div class="flex items-center justify-between gap-0.5" style="margin-bottom:2px"><div class="flex items-center gap-1 min-w-0"><span class="material-symbols-outlined" style="font-size:13px;color:${icon}">notifications_active</span><span class="text-[9px] font-bold uppercase tracking-wide" style="color:${icon}">${label}</span></div><span class="font-bold text-[11px]" style="color:${whenC}">${when}</span></div>
    <div class="font-semibold text-[11px] truncate" style="color:${nameC}">${_tEsc(time)} · ${_tEsc(a.name)}</div>
    <div class="text-[10px] leading-tight truncate" style="color:${svcC}">${_tEsc(a.svc)}</div>
  </div></div>`;
}
function startTurnsApptRefresh() {
  if (_turnsApptTimer) return;
  _turnsApptTimer = setInterval(() => {
    const p = document.getElementById('panel-turns');
    if (!p || !p.classList.contains('active')) return;
    if (_turnsApptShow && !turnsViewingHistory) renderTurnsApptStrip();
    renderTurnsTechGrid();   // refresh the 30-min in-grid notes + countdowns
  }, 60000);
}

export function renderTurnsTechGrid() {
  const grid = document.getElementById('turns-tech-grid');
  if (!grid) return;
  if (turnsViewingHistory) { renderTurnsHistoryView(); return; }
  const { hideTime, hideSvc } = getBubblePrefs();   // W2-6 (tech is the column header here, so hideTech is N/A)

  const _db = document.getElementById('turns-date-btn-val'); if (_db) _db.textContent = dateBtnLabel(null);

  // NL5: optionally hide clocked-out ("Off") techs from the board (per device) — but NEVER hide one who
  // still holds a live guest (a waiting or in-service customer), or that customer vanishes from the board.
  const order = getActiveTurnsOrder().filter(id => {
    if (!(_turnsHideOff && (cfg().turns_off || []).includes(id))) return true;
    return techHasPendingAssignment(id) || getActiveTechEntries(id).length > 0;
  });
  const partyLetters = partyLetterMap(q());   // same party letter as the queue/side cards
  // A single customer can show up as several cards in the grid — multiple services, whether
  // with the SAME tech or split across techs. Tag every one of that customer's slots with a
  // matching colored link chip so the front desk sees at a glance it's the same person.
  const splitTags = new Map();   // entryId -> color
  let _splitN = 0;
  q().forEach(e => {
    const assigned = (e.assignments || []).filter(a => a.techId).length;
    if (assigned >= 2) { splitTags.set(String(e.id), GROUP_COLORS[_splitN % GROUP_COLORS.length]); _splitN++; }
  });
  const sep = turnsSep();
  let activeCount = 0;
  if (order.length === 0) {
    const allHiddenByOff = _turnsHideOff && getActiveTurnsOrder().length > 0;   // techs exist but the Off filter hid them all
    grid.innerHTML = allHiddenByOff
      ? '<div class="text-sm font-body text-on-surface-variant py-8 text-center opacity-60"><span class="material-symbols-outlined text-4xl block mb-2">group</span>All technicians are Off right now.<br>Tap <strong>Off techs</strong> to show them.</div>'
      : '<div class="text-sm font-body text-on-surface-variant py-8 text-center opacity-60"><span class="material-symbols-outlined text-4xl block mb-2">swap_vert</span>No technicians added today.<br>Click <strong>Technicians</strong> to set up the turn order.</div>';
    const el = document.getElementById('turns-active-count'); if (el) el.textContent = '0';
    return;
  }
  // Next upcoming appt per tech (for the 30-min in-grid note). Empty if Google
  // Calendar isn't connected/synced on this device.
  const _nowMs = Date.now(), _upcoming = turnsUpcomingAppts();
  const nextApptFor = id => _upcoming.filter(a => a.techStaffId === id).sort((a,b) => a.startMs - b.startMs)[0] || null;

  // Who gets the next walk-in: the AVAILABLE tech with the fewest turns; a tie goes to whoever
  // is higher in the turn order (scan top-down, replace only on strictly fewer turns). Flagged
  // in place — the row order itself never changes.
  // Candidates = Available, minus techs holding a still-waiting customer (fallback to all Available if that empties it).
  const _availForNext = _dropHolders(order.filter(sid => getTechStatusColor(sid).label === 'Available'), techHasPendingAssignment);
  let nextUpId = null, _nextUpTurns = Infinity;
  for (const sid of _availForNext) {
    const tt = getTechTurns(sid).total;
    if (tt < _nextUpTurns) { _nextUpTurns = tt; nextUpId = sid; }
  }

  // Dynamic turn-card height: roomier when few techs, denser when many fit on screen
  // (≤5 → 76px, 6–7 → 66px, 8+ → 56px) so a busy day shows more techs without scrolling.
  const slotH = order.length <= 5 ? 76 : order.length <= 7 ? 66 : 56;

  // v5.91: dedicated per-service bonus counters — resolved ONCE per render (not per tech).
  // Gated on bonus-by-service (the rule that makes these services bonus): off → no column, no dead zeros.
  const _tc = getTurnConfig();
  const dedServices = getDedicatedBonusServices();
  const showDedicated = _tc.dedicatedBonusCounters && _tc.bonusEnabled && _tc.bonusByService && dedServices.length > 0;

  const rows = order.map(staffId => {
    const st = staffById(staffId);
    if (!st) return '';
    const turns = getTechTurns(staffId);
    const allAssign = getTechAllAssignments(staffId);
    // Billed today = this tech's assignment costs for work performed (Complete OR
    // Paid) — the tech earns the turn when the work is done, regardless of payment.
    const billed = allAssign.reduce((sum, it) => { const ast = getAssignmentStatus(it.entry, it.assignment); return sum + ((ast === 'complete' || isPaidStatus(ast)) ? (it.assignment.cost || 0) : 0); }, 0);
    if (allAssign.some(a => getAssignmentStatus(a.entry, a.assignment) === 'inservice')) activeCount++;
    const sc = getTechStatusColor(staffId);
    const isNextUp = staffId === nextUpId;
    // Availability chip for the rotation column — matched to the FLOOR PLAN's color language so
    // the two views agree: IN-SERVICE ("Working now") = red (busy), AVAILABLE = green (free). It
    // used to be green-for-working + teal-for-available, which read as "both green." The available
    // tech due for the next walk-in still gets the filled teal "Next up" chip. getTechStatusColor
    // already uses this red/green on the floor; this brings the Turns chip in line.
    const _dot = c => `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block"></span>`;
    // avPres = the tech's TRUE availability. "Next up" is shown as its OWN pill next to this (NL4), so
    // it never hides the Available/On-break status; the teal avatar ring still flags the next-up tech.
    const avPres = sc.label === 'Off'        ? { ring: '#b0b6ba', chip: 'background:#eceef0;color:#7a858a', lead: _dot('#b0b6ba'), label: 'Off' }
                 : sc.label === 'On Break'   ? { ring: '#e0a83a', chip: 'background:#faedcf;color:#9a6b00', lead: _dot('#e0a83a'), label: 'On break' }
                 : sc.label === 'In Service' ? { ring: '#fa746f', chip: 'background:#fdecea;color:#c0362f', lead: _dot('#fa746f'), label: 'Working now' }
                 :                             { ring: '#2a7a4f', chip: 'background:#e9f4ee;color:#1b5e3b', lead: _dot('#2a7a4f'), label: 'Available' };
    const ringColor = isNextUp ? '#1a5252' : avPres.ring;
    // Icon-only so it sits beside the Available chip without wrapping the row (the teal ring + inset bar
    // already read as "next up"; the title spells it out on hover/press).
    const nextUpPill = isNextUp ? `<span title="Next up" aria-label="Next up" class="px-1 py-0.5 rounded-full leading-none inline-flex items-center flex-shrink-0" style="background:#1a5252;color:#fff"><span class="material-symbols-outlined" style="font-size:12px">arrow_upward</span></span>` : '';
    const photo = st.photo
      ? `<img src="${st.photo}" class="w-10 h-10 rounded-full object-cover border-2 flex-shrink-0" style="border-color:${ringColor}">`
      : `<div class="w-10 h-10 rounded-full flex items-center justify-center border-2 flex-shrink-0 text-sm font-headline font-bold" style="background:${ringColor}20;border-color:${ringColor};color:${ringColor}">${st.name.charAt(0).toUpperCase()}</div>`;
    const isHalf = !Number.isInteger(turns.total) && turns.total > 0;
    // A trailing "?" flags assigned work that can't be counted yet (no base/typed price) — added
    // after the count, never replacing it (title explains it on hover).
    const unk = turns.unknown > 0 ? `<span title="Has assigned service(s) with no price yet" style="color:#b0612a">?</span>` : '';
    const turnDisplay = turns.total > 0
      ? `<span class="text-sm font-headline font-bold flex-shrink-0 ${isHalf ? 'px-1.5 py-0.5 rounded-md' : ''}" style="${isHalf ? 'background:#f5c870;color:#3a2800' : 'color:#1a5252'}">${turns.total}t${unk}</span>`
      : `<span class="text-sm font-headline text-outline-variant flex-shrink-0">0t${unk}</span>`;
    // The turn count + billed total live in their own fixed column (turnsCountCol, below); this left
    // column is just the tech's photo, name, and status.
    const techCol = `<div class="flex items-center gap-2 flex-shrink-0 pr-2" style="width:var(--turns-techcol-w,155px)">
      <button onclick="showTechStatusMenu(event,'${staffId}')" class="focus:outline-none flex-shrink-0">${photo}</button>
      <div class="min-w-0" style="flex:1">
        <div class="leading-tight"><span class="font-headline font-semibold text-on-surface text-sm truncate" style="min-width:0;display:block">${st.name}</span></div>
        <div class="flex items-center gap-1 mt-0.5 flex-wrap"><span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold leading-none inline-flex items-center gap-1 flex-shrink-0" style="${avPres.chip}">${avPres.lead}${avPres.label}</span>${nextUpPill}</div>
        <div class="turns-billed text-[11px] font-headline font-bold leading-none mt-0.5" style="color:#1a5252">$${billed.toFixed(0)}</div>
      </div></div>`;

    const MIN_SLOTS = 5;
    // Merge real assignments with any manual "skipped turns" for this tech, ordered by time.
    const filled = [
      ...allAssign.map(it => ({ kind: 'a', ...it, _t: it.assignment.assignedAt || new Date(it.entry.checkinTime).getTime() })),
      ...todaySkips(staffId).map(sk => ({ kind: 'skip', skip: sk, _t: new Date(sk.at).getTime() })),
    ].sort((x, y) => x._t - y._t);
    const totalSlots = Math.max(MIN_SLOTS, filled.length + 1);
    let turnCounter = 0;
    const slotArr = Array.from({ length: totalSlots }, (_, slotIdx) => {
      const item = filled[slotIdx];
      if (item && item.kind === 'skip') {
        turnCounter += 1;
        const ts = new Date(item.skip.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const tl = Number.isInteger(turnCounter) ? turnCounter : turnCounter.toFixed(1);
        return `<div class="flex-shrink-0 w-[150px] px-1"><div class="w-full h-full rounded-xl px-2 py-1.5 text-left text-xs font-body relative" style="background:#e6e6e6;color:#777;min-height:${slotH}px;border:1px dashed #b5b5b5">
          <button onclick="event.stopPropagation();removeTurnSkip('${item.skip.id}')" title="Remove skipped turn" style="position:absolute;top:2px;right:3px;color:#999;line-height:1" class="hover:opacity-70"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>
          <div class="flex items-center gap-1 pr-4"><span class="material-symbols-outlined" style="font-size:14px">skip_next</span><span class="font-semibold text-[11px]">Skipped</span><span class="text-[11px] font-headline font-bold ml-auto" style="opacity:.75">${tl}</span></div>
          <div class="text-[10px] opacity-90 leading-tight mt-1">Turn passed · no customer</div>
          <div class="text-[9px] opacity-60 mt-1">${ts}</div>
        </div></div>`;
      }
      if (item) {
        const { entry: e, assignment: a } = item;
        const cost = a.cost || 0;
        const tt = turnClassOf(a);
        const estimated = isEstimatedTurn(a, tt);   // grey "~N" only on full/half counted from the expected price
        if (tt === 'full') turnCounter += 1; else if (tt === 'half') turnCounter += 0.5;
        const turnLabelNum = Number.isInteger(turnCounter) ? turnCounter : turnCounter.toFixed(1);
        const turnLabel = tt === 'bonus' ? 'Bonus' : tt === 'unpriced' ? '?' : (estimated ? '~' + turnLabelNum : '' + turnLabelNum);
        // Use the awaiting-price-aware status so a "Done — tech will price" service reads
        // as violet "Awaiting price", not the blue "Done" fill (its raw status is 'complete').
        const ss = effectiveServiceStatus(e, a);
        let bg, fg;
        if (isPaidStatus(ss)) { bg='#dde2e5'; fg='#555'; } else if (ss === 'awaiting') { bg='#e7e0f5'; fg='#3f2d6b'; } else if (ss === 'complete') { bg='#d3e4ef'; fg='#14425e'; } else if (ss === 'inservice') { bg='#d8ecdf'; fg='#1b4d33'; } else { bg='#ffe9c4'; fg='#5c4010'; }
        const outline = e.groupId ? `;outline:2px solid ${e.groupColor||'#e8a230'};outline-offset:-1px` : '';
        const s = svc(a.serviceId);
        const svcLabel = s ? s.label : (e.services.map(sid => svc(sid)?.label || '?').join(', '));
        const costStr = a.cost ? '$' + Number(a.cost).toFixed(0) : '';
        const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:${e.groupColor||'#888'};color:#fff;font-size:8px;font-weight:800;flex-shrink:0;margin-right:2px">${partyLetters.get(e.groupId)||'•'}</span>` : '';
        const splitColor = splitTags.get(String(e.id));
        const splitTag = splitColor ? `<span title="Same customer — multiple services" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:5px;background:${splitColor};color:#fff;flex-shrink:0;margin-right:2px"><span class="material-symbols-outlined" style="font-size:11px;font-variation-settings:'FILL' 1">link</span></span>` : '';
        // Appointment marker (lavender, matching the upcoming-appts strip), shown on the
        // time/status row so it never adds a line or crowds the name/chip row on a busy card.
        const apptPill = e.isAppointment ? `<span title="Booked appointment" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;background:#ede7f6;color:#42306b;font-size:8px;font-weight:700;line-height:1;padding:2px 5px;border-radius:999px"><span class="material-symbols-outlined" style="font-size:9px;font-variation-settings:'FILL' 1">event</span>Appt</span>` : '';
        return `<div class="flex-shrink-0 w-[150px] px-1 turns-filled-slot" data-entry-id="${e.id}" data-tech-id="${staffId}" data-slot="${slotIdx}">
          <button onclick="showGroupAssignModal('${e.id}')" class="w-full h-full rounded-xl px-2 py-1.5 text-left active:scale-95 transition-all text-xs font-body" style="background:${bg};color:${fg};min-height:${slotH}px${outline}">
            <div class="flex items-center justify-between gap-0.5 mb-0.5"><div class="flex items-center gap-0.5 min-w-0">${groupDot}${splitTag}<span class="font-semibold text-[11px] truncate">${escHtml(e.name)}</span></div>${turnLabel ? `<span class="text-[11px] font-headline font-bold flex-shrink-0 ml-1" style="${turnPillStyle(tt, turnLabel, estimated)}" ${estimated ? 'title="Estimated from the service’s expected price — updates when a real price is entered"' : ''}>${turnLabel}</span>` : ''}</div>
            <div class="text-[10px] opacity-90 leading-tight">${[hideSvc ? null : svcLabel, a.station || null, costStr || null].filter(Boolean).join(' · ')}</div>
            ${(() => { if (hideTime) return ''; const sti = serviceTimeInfo(a); return sti ? `<div class="text-[10px] font-bold leading-tight" style="color:${sti.color}">${sti.text}</div>` : ''; })()}
            <div class="flex items-center gap-1"><span class="text-[9px] opacity-60" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${timeStr} · ${statusTimeHtml(entryStatusSince(e), isPaidStatus(ss))}</span>${apptPill}</div>
          </button></div>`;
      }
      return `<div class="flex-shrink-0 w-[150px] px-1 turns-drop-zone" data-tech-id="${staffId}" data-slot="${slotIdx}">
        <div class="turns-empty-slot w-full h-full rounded-xl border-2 border-dashed border-outline-variant/40 flex items-center justify-center text-outline-variant cursor-pointer hover:border-primary hover:bg-primary/5 hover:text-primary transition-all" style="min-height:${slotH}px" onclick="openTurnsAssign('${staffId}',${slotIdx})"><span class="material-symbols-outlined" style="font-size:20px">add</span></div></div>`;
    });
    // 30-min note: drop an amber "next appt" card into this tech's next-turn position
    // (right after their filled slots) when their soonest upcoming appt is ≤30 min out.
    const nextAppt = nextApptFor(staffId);
    if (nextAppt) { const mins = Math.round((nextAppt.startMs - _nowMs) / 60000); if (mins <= 30) slotArr.splice(filled.length, 0, turnsDueNoteCard(nextAppt, mins, slotH)); }
    const slotHtml = slotArr.join('');

    // Inset bar (box-shadow, NOT border-left) so the next-up accent never shifts the row's columns right.
    const rowAccent = isNextUp ? 'box-shadow:inset 3px 0 0 #1a5252;background:#eef5f5;border-radius:0 8px 8px 0;' : '';
    const slotRow = `<div class="turns-slot-row flex gap-1.5 overflow-x-auto pb-0.5" style="min-width:0;flex:1;scrollbar-width:thin">${slotHtml}</div>`;
    // Per-device separation between the tech box and the turn bubbles (see turnsSep()).
    const rightSide = sep === 'lane'
      ? `<div class="flex min-w-0" style="flex:1;background:#eef1f2;border:0.5px solid #e0e5e7;border-radius:12px;padding:4px 2px 4px 6px">${slotRow}</div>`
      : `<div class="self-stretch flex-shrink-0" style="width:1px;background:#d3dbdc;margin:6px 0"></div>${slotRow}`;
    // Turn count sits in its OWN resizable column just left of the turn bubbles (same spot for every tech).
    // The tech's billed $ total now lives under the tech name (in techCol), not here. This column sits
    // OUTSIDE the scrolling slot row. When dedicated counters are on, the dedicated add-ons leave the
    // general "+Nb" (counted in their own column instead) — generalBonusCount is the single source
    // shared with the floor roster.
    // Only show a service's counter for a tech who actually does it (empty menu = does everything).
    // The SAME filtered list drives the column AND the "+Nb" subtraction, so a service the tech doesn't
    // do can never silently remove a (manually-assigned) bonus turn from their general +Nb.
    const techDed = showDedicated ? dedServices.filter(s => _techDoesService(st, s.id)) : [];
    const dedCounts = techDed.map(s => turns.dedicated[s.id] || 0);
    const generalBonus = showDedicated ? generalBonusCount(turns, techDed) : turns.bonus;
    const turnsCountCol = `<div class="flex-shrink-0 flex flex-col items-center justify-center self-stretch border-x border-surface-container-high px-1" style="width:var(--turns-totalcol-w,72px)">
      ${turnDisplay}${generalBonus > 0 ? `<span class="text-sm font-headline font-bold text-secondary leading-none mt-0.5 flex-shrink-0">+${generalBonus}b</span>` : ''}
    </div>`;
    // Dedicated add-on counter column (right of the turn count): one line per add-on, "ABBR N" — the
    // 3 services stacked. Same bonus color (text-secondary) as the "+Nb" it split from; a zero reads greyed.
    const bonusDedicatedCol = showDedicated
      ? `<div class="flex-shrink-0 flex flex-col items-center justify-center self-stretch border-r border-surface-container-high px-0.5 gap-0.5" style="width:var(--turns-totalcol-w,72px)">
          ${techDed.map((s, i) => `<div class="flex items-baseline justify-center gap-1 leading-none" title="${escHtml(s.label)} — bonus add-on">
            <span class="text-[9px] font-body font-semibold uppercase tracking-wide text-outline-variant truncate" style="max-width:28px">${escHtml(s.abbr)}</span>
            <span class="text-sm font-headline font-bold leading-none ${dedCounts[i] > 0 ? 'text-secondary' : 'text-outline-variant'}">${dedCounts[i]}</span>
          </div>`).join('')}
        </div>`
      : '';
    return `<div class="flex items-center border-b border-surface-container-high py-1 gap-2" style="${rowAccent}">${techCol}${turnsCountCol}${bonusDedicatedCol}${rightSide}</div>`;
  }).filter(Boolean).join('');

  grid.innerHTML = rows || '<div class="text-sm text-on-surface-variant py-4 text-center">No active technicians.</div>';
  const el = document.getElementById('turns-active-count'); if (el) el.textContent = activeCount;
  grid.querySelectorAll('.turns-slot-row').forEach(row => {
    row.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  });
  // Rebuilding innerHTML snaps every row's horizontal scroll back to the first turn.
  // Keep the NEXT open slot (first "+") in view — don't jump to the far end. If the row
  // fits without overflow, don't scroll at all. rAF lets layout settle first (iPad).
  requestAnimationFrame(() => grid.querySelectorAll('.turns-slot-row').forEach(row => {
    if (row.scrollWidth <= row.clientWidth + 1) return;            // fits — no scroll
    const next = row.querySelector('.turns-drop-zone');            // first empty slot
    if (!next) { row.scrollLeft = row.scrollWidth; return; }       // all full — show the end
    const delta = (next.getBoundingClientRect().right - row.getBoundingClientRect().left) - row.clientWidth + 12;
    if (delta > 0) row.scrollLeft += delta;                        // reveal just the next box
  }));
  // Column-resize handle: one draggable strip at the tech column's right edge (grid is
  // position:relative). Dragging updates the --turns-techcol-w var live (clamped) and persists on
  // release; stopPropagation keeps it from arming the bubble drag. Re-added each render because
  // grid.innerHTML above rebuilds the grid (so the prior handle + its listener are discarded).
  if (rows) {
    const handle = document.createElement('div');
    handle.className = 'turns-col-resizer';
    handle.title = 'Drag to resize the technician column';
    handle.style.left = (turnsTechColW() - 3) + 'px';
    handle.addEventListener('pointerdown', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const startX = ev.clientX, startW = turnsTechColW();
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      const panel = document.getElementById('panel-turns');
      const move = e => { const w = _clampTechColW(startW + (e.clientX - startX)); panel?.style.setProperty('--turns-techcol-w', w + 'px'); handle.style.left = (w - 3) + 'px'; };
      const end = e => {   // pointerup OR pointercancel (interrupted touch) — clean up + persist
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        setTurnsTechColW(startW + (Number(e && e.clientX) ? e.clientX - startX : 0));
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    });
    grid.appendChild(handle);
    // Handle at the turn-count column's right edge — which, when the dedicated bonus column shows, is the
    // SEAM between the two counter columns. Both share --turns-totalcol-w (NL7), so a 1:1 drag of this one
    // handle keeps them equal and resizes both together.
    const thandle = document.createElement('div');
    thandle.className = 'turns-col-resizer';
    thandle.title = 'Drag to resize the counter column(s)';
    thandle.style.left = (turnsTechColW() + 8 + turnsTotalColW() - 3) + 'px';
    thandle.addEventListener('pointerdown', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const startX = ev.clientX, startW = turnsTotalColW();
      try { thandle.setPointerCapture(ev.pointerId); } catch {}
      const panel = document.getElementById('panel-turns');
      const move = e => { const w = _clampTotalColW(startW + (e.clientX - startX)); panel?.style.setProperty('--turns-totalcol-w', w + 'px'); thandle.style.left = (turnsTechColW() + 8 + w - 3) + 'px'; };
      const end = e => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        setTurnsTotalColW(startW + (Number(e && e.clientX) ? e.clientX - startX : 0));
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    });
    grid.appendChild(thandle);
  }
}

export function renderTurnsQueue() {
  const waitingList = document.getElementById('turns-waiting-list');
  const activeList  = document.getElementById('turns-active-list');
  if (!waitingList || !activeList) return;
  const { hideTech, hideSvc } = getBubblePrefs();   // W2-6 (no per-service time on these cards, so hideTime is a no-op here)
  const waiting = q().filter(e => { if (isPaidStatus(e.status)) return false; if (!e.assignments || e.assignments.length === 0) return e.status === 'waiting'; return e.assignments.some(a => getAssignmentStatus(e, a) === 'waiting'); });
  const inservice = q().filter(e => { if (!e.assignments || e.assignments.length === 0) return e.status === 'inservice'; return e.assignments.some(a => getAssignmentStatus(e, a) === 'inservice'); });
  const complete = q().filter(e => e.status === 'complete');   // service done, payment pending
  const wLabel = document.getElementById('turns-waiting-label'); if (wLabel) wLabel.textContent = waiting.length + ' in queue';
  const aLabel = document.getElementById('turns-active-label'); if (aLabel) aLabel.textContent = (complete.length ? complete.length + ' complete · ' : '') + inservice.length + ' in service';
  const suggestions = buildSuggestions();
  const partyLetters = partyLetterMap(q());   // same party → same letter as the queue

  function buildCard(e) {
    const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:5px;background:${e.groupColor||'#888'};color:#fff;font-size:9px;font-weight:800;flex-shrink:0">${partyLetters.get(e.groupId) || '•'}</span>` : '';
    const groupLbl = e.groupLabel ? `<span class="text-[10px] font-body italic ml-0.5" style="color:${e.groupColor||'#888'}">${escHtml(e.groupLabel)}</span>` : '';
    // Avatar bubble is STATUS-colored + consistent for everyone (green in service · blue done ·
    // violet awaiting-price · amber waiting), so it reads at a glance and party members no longer
    // get a different-colored bubble. Party grouping still shows via the small letter badge
    // (groupDot) beside the name. effectiveEntryStatus maps a complete-but-unpriced ticket to the
    // violet "Awaiting price" cue so it doesn't look identical to a ready-to-pay "Done" ticket.
    const _es = effectiveEntryStatus(e);
    const _av = serviceLineStyle(_es).pill;
    const avatar = `<div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-headline font-bold" style="background:${_av.bg};color:${_av.fg}">${escHtml(e.name.charAt(0).toUpperCase())}</div>`;
    const assignments = (e.assignments||[]).filter(a => a.techId || a.serviceId);
    const es = suggestions[e.id] || {};
    // Unassigned-service row (shared): used for a fully-unassigned entry AND for the services of a MIXED
    // entry (some teched at check-in via W2-7, some left blank) that have no assignment — otherwise those
    // blank services would vanish from the turns card (the floor already shows the union).
    const _lsW = serviceLineStyle('waiting');
    const _unassignedRow = sid => { const s = svc(sid), sug = es[sid]; const arrow = hideSvc ? '' : '→ '; return `<div class="flex items-center gap-1 text-[10px] leading-tight rounded-r mt-0.5" style="border-left:2px solid ${_lsW.bar};padding-left:4px;opacity:${_lsW.rowOpacity}">
        <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;box-sizing:border-box;flex-shrink:0;${_lsW.dot}"></span>
        <span class="min-w-0 flex-1 truncate">
          ${hideSvc ? '' : `<span class="font-semibold text-on-surface">${escHtml(s ? s.label : sid)}</span>`}
          ${sug ? `<span class="text-on-surface-variant">${arrow}${escHtml(sug.techName)}?</span>` : ''}
        </span>
        ${sug ? acceptBtnHtml(e.id, sid, sug.techName) : ''}
        <span class="text-[9px] font-bold px-1 rounded-full flex-shrink-0" style="background:${_lsW.pill.bg};color:${_lsW.pill.fg}">${_lsW.pill.label}</span>
      </div>`; };
    let serviceContent;
    if (assignments.length > 0) {
      const _covered = new Set(assignments.map(a => String(a.serviceId)));
      serviceContent = assignments.map(a => {
        const tech = staffById(a.techId), s = svc(a.serviceId);
        const ls = serviceLineStyle(effectiveServiceStatus(e, a));
        const hot = ls.key === 'inservice';
        // hideTech hides the ASSIGNED tech name only; a tech SUGGESTION + its one-tap Accept
        // always stay (hiding a display bit must not kill the accept workflow). The leading
        // "→" is dropped under hideSvc so a tech line never reads as an orphaned arrow.
        const arrow = hideSvc ? '' : '→ ';
        let techHtml = '', accept = '';
        if (tech) { if (!hideTech) techHtml = `<span class="text-on-surface-variant">${arrow}${escHtml(tech.name)}</span>`; }
        else if (es[a.serviceId]) { techHtml = `<span class="text-on-surface-variant">${arrow}${escHtml(es[a.serviceId].techName)}?</span>`; accept = acceptBtnHtml(e.id, a.serviceId, es[a.serviceId].techName); }
        const rowStyle = `border-left:${hot ? 3 : 2}px solid ${ls.bar};padding-left:4px;${ls.tint ? `background:${ls.tint};` : ''}${ls.rowOpacity < 1 ? `opacity:${ls.rowOpacity};` : ''}`;
        return `<div class="flex items-center gap-1 text-[10px] leading-tight rounded-r mt-0.5" style="${rowStyle}">
          <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;box-sizing:border-box;flex-shrink:0;${ls.dot}"></span>
          <span class="min-w-0 flex-1 truncate">
            ${hideSvc ? '' : `<span class="${hot ? 'font-bold' : 'font-semibold'} text-on-surface">${escHtml(s ? s.label : 'Service')}</span>`}
            ${techHtml}${a.cost ? ` <span class="font-semibold text-primary">$${a.cost}</span>` : ''}
          </span>
          ${isTechPriced(a) ? `<span class="flex-shrink-0 text-[9px] font-bold px-1 rounded-full" style="background:#e1efe9;color:var(--primary,#1a5252)" title="Price entered by the tech">✓</span>` : ''}
          <span class="text-[9px] font-bold px-1 rounded-full flex-shrink-0" style="background:${ls.pill.bg};color:${ls.pill.fg}">${ls.pill.label}</span>${accept}
        </div>`;
      }).join('') + (e.services || []).filter(sid => !_covered.has(String(sid))).map(_unassignedRow).join('');   // W2-7: also show blank (un-teched) services
    } else {
      serviceContent = (e.services || []).map(_unassignedRow).join('');
    }
    // C9/D13 vocabulary (recolored v4.79): In Service = green, Done(complete) = blue,
    // Awaiting price = violet, Waiting = amber — match the status pills rendered inside this same
    // card (and the floor-plan tints). Uses the same awaiting-aware status as the avatar bubble.
    const borderColor = _es==='inservice' ? '#2a7a4f' : _es==='awaiting' ? '#6b4fb0' : _es==='complete' ? '#1a5c7a' : '#d4860a';
    const bgTint = _es==='inservice' ? 'rgba(42,122,79,0.10)' : _es==='awaiting' ? 'rgba(107,79,176,0.12)' : _es==='complete' ? 'rgba(26,92,122,0.12)' : 'rgba(255,224,178,0.25)';
    return `<div class="px-3 py-2 cursor-grab hover:brightness-95 transition-all select-none border-b border-surface-container-high border-l-4" style="border-left-color:${borderColor};background:${bgTint}" data-entry-id="${e.id}" onclick="showGroupAssignModal('${e.id}')">
      <div class="flex items-start gap-2 pointer-events-none">${avatar}
        <div class="min-w-0 flex-grow"><div class="flex items-center gap-1 flex-wrap leading-tight">${groupDot}<span class="font-headline font-semibold text-on-surface text-sm">${escHtml(e.name)}</span>${preferredTechBadgeHtml(e.phone, { fontSize: 10, iconOnly: true })}${groupLbl}<span class="text-[10px] font-body text-on-surface-variant ml-1">${timeStr} · <span data-checkin-ts="${entryStatusSince(e)}">${formatElapsed(entryStatusSince(e))}</span></span></div>${serviceContent}${cardNotePreview(e.phone, e.txnNote)}</div></div></div>`;
  }
  waitingList.innerHTML = waiting.length === 0 ? '<div class="px-4 py-3 text-xs text-on-surface-variant text-center">No one waiting</div>' : waiting.map(buildCard).join('');
  const activeCards = [...complete, ...inservice];   // completed (awaiting payment) at the top, then in-service
  activeList.innerHTML = activeCards.length === 0 ? '<div class="px-4 py-3 text-xs text-on-surface-variant text-center">No one active</div>' : activeCards.map(buildCard).join('');
}

function reorderTurnSlots(techId, moveEntryId, beforeEntryId) {
  const allAssign = getTechAllAssignments(techId);
  const moveItem = allAssign.find(a => String(a.entry.id) === String(moveEntryId));
  const beforeItem = allAssign.find(a => String(a.entry.id) === String(beforeEntryId));
  if (!moveItem || !beforeItem) return;
  const reordered = allAssign.filter(a => String(a.entry.id) !== String(moveEntryId));
  const idx = reordered.findIndex(a => String(a.entry.id) === String(beforeEntryId));
  reordered.splice(idx, 0, moveItem);
  const base = Date.now();
  const touched = new Set();
  reordered.forEach((item, i) => { item.assignment.assignedAt = base + i; touched.add(item.entry); });
  touched.forEach(entry => dispatch('queue.upsert', { entry }));
  renderTurns();
  showToast('Turn order updated ✓');
}

// ── N3 drag→tech: which services a dragged customer can be assigned/moved to a tech (pure cores) ──
// canDo is a FLAG (skills warn, not filter — the owner can override with a warning), never a filter.
export function eligibleWaitingServices(entry, techId, { statusOf, doesService, labelOf }) {
  const out = [];
  (entry.services || []).forEach(sid => {
    const a = (entry.assignments || []).find(x => x.serviceId === sid);
    const status = a ? statusOf(entry, a) : 'waiting';
    if (status !== 'waiting') return;               // only still-waiting work is "assignable"
    if (a && a.techId === techId) return;           // already on this tech
    out.push({ serviceId: sid, svcLabel: labelOf(sid), canDo: !!doesService(sid) });
  });
  return out;
}
// Case (b): the dragged customer's assignments currently on fromTechId that can move to another tech.
// Waiting/in-service move freely; done/paid are offered only to a manager, flagged needsOverride.
export function movableServices(entry, fromTechId, { isManager, doesService, labelOf, statusOf, isPaidStatus }) {
  const out = [];
  (entry.assignments || []).forEach(a => {
    if (a.techId !== fromTechId) return;
    const status = statusOf(entry, a);
    if (isPaidStatus(status)) return;               // a PAID service has a saved record — moving it would
                                                    // desync Reports/Payroll; it can't move from the board
    const free = status === 'waiting' || status === 'inservice';
    if (!free && !isManager) return;                // 'complete' (done, unpaid) → manager only
    out.push({ serviceId: a.serviceId, svcLabel: labelOf(a.serviceId), canDo: !!doesService(a.serviceId), status, needsOverride: !free });
  });
  return out;
}

// ── Assign-to-slot modal ──────────────────────────
let turnsAssignTarget = null;
export function openTurnsAssign(techId, slotIndex) {
  turnsAssignTarget = { techId, slotIndex };
  const tech = staffById(techId);
  document.getElementById('turns-assign-label').textContent = `Assign to ${tech?.name || ''}`;
  const options = [];
  q().forEach(e => {
    if (isPaidStatus(e.status)) return;
    e.services.forEach(sid => {
      const a = (e.assignments || []).find(x => x.serviceId === sid);
      const ss = a ? getAssignmentStatus(e, a) : 'waiting';
      // Only waiting services this tech can actually DO (skills checked) and isn't already on.
      if (ss !== 'waiting' || (a && a.techId === techId) || !_techDoesService(tech, sid)) return;
      options.push({ entry: e, serviceId: sid, svcLabel: svc(sid)?.label || sid });
    });
  });
  const list = document.getElementById('turns-assign-list');
  if (options.length === 0) list.innerHTML = `<div class="text-sm font-body text-on-surface-variant text-center py-4">No waiting services ${tech?.name || 'this tech'} can take</div>`;
  else {
    const byCustomer = {};
    options.forEach(o => { const k = String(o.entry.id); if (!byCustomer[k]) byCustomer[k] = { entry: o.entry, svcs: [] }; byCustomer[k].svcs.push(o); });
    list.innerHTML = Object.values(byCustomer).map(({ entry: e, svcs }) => {
      const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const svcButtons = svcs.map(({ serviceId, svcLabel }) => `<button onclick="assignServiceFromTurns('${e.id}','${serviceId}')" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-container transition-colors text-left border-t border-surface-container-high"><div class="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"></div><span class="text-sm font-body font-semibold text-on-surface">${svcLabel}</span></button>`).join('');
      return `<div class="border border-surface-container-high rounded-xl mb-2 overflow-hidden"><div class="px-4 py-2 bg-surface-container flex items-center justify-between"><span class="font-headline font-semibold text-on-surface text-sm">${escHtml(e.name)}</span><span class="text-[11px] font-body text-on-surface-variant">${timeStr}</span></div>${svcButtons}</div>`;
    }).join('');
  }
  const m = document.getElementById('turns-assign-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function assignServiceFromTurns(entryId, serviceId) {
  const techId = turnsAssignTarget?.techId;
  closeTurnsAssignModal();
  showGroupAssignModal(entryId);
  setTimeout(() => {
    // Scope to the dragged customer's rows (a party renders one [data-assign-entry] wrapper per guest),
    // so a shared service name (e.g. two guests both "Manicure") can't pre-fill another guest's row.
    // Fallback to the flat query for a single-customer modal that has no wrapper.
    let rows = document.querySelectorAll(`#group-assign-content [data-assign-entry="${entryId}"] [data-service-id]`);
    if (!rows.length) rows = document.querySelectorAll('#group-assign-content [data-service-id]');
    rows.forEach(row => {
      if (row.dataset.serviceId === serviceId) {
        const techSelect = row.querySelector('.assign-tech');
        if (techSelect && techId) techSelect.value = techId;
        row.style.outline = '2px solid #1a5252';
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => { row.style.outline = ''; }, 1500);
        window.updateGroupTotal?.();
      }
    });
  }, 250);
}
export function closeTurnsAssignModal() {
  _dragPickState = null;   // drop any pending drag-pick closures when the picker closes (X / backdrop / choice)
  const m = document.getElementById('turns-assign-modal'); m.classList.add('hidden'); m.style.display = '';
}

// ── N3 drag→tech flow (assign a waiting customer, or move an assigned one, scoped to the dragged guest) ──
// (_statusWord is shared with the history view, defined lower in this module.)
// Entry point from the drop handler. fromTech set = already assigned there (a MOVE); null = a waiting
// customer (an ASSIGN). Break/Off is folded into the SAME confirm as the skills/override warnings so a
// drag never stacks two modals. ctx carries everything the warning/copy needs.
function dragDropToTech(entryId, fromTech, targetTech) {
  const entry = q().find(x => String(x.id) === String(entryId)); if (!entry) return;
  const tech = staffById(targetTech), techName = tech?.name || 'this tech';
  const deps = { statusOf: getAssignmentStatus, doesService: sid => _techDoesService(tech, sid), labelOf: sid => svc(sid)?.label || sid };
  const breakOff = (cfg().turns_break || []).includes(targetTech) ? 'Break' : ((cfg().turns_off || []).includes(targetTech) ? 'Off' : null);
  const ctx = { techName, breakOff };
  if (fromTech) _dragMove(entry, fromTech, targetTech, ctx, deps);
  else _dragAssign(entry, targetTech, ctx, deps);
}
function _dragAssign(entry, targetTech, ctx, deps) {
  const options = eligibleWaitingServices(entry, targetTech, deps);
  if (!options.length) { showToast(`No waiting services to assign for ${entry.name}`); return; }   // xss-ok: showToast sets textContent, not HTML
  turnsAssignTarget = { techId: targetTech };
  _pickDragService('assign', `Assign ${entry.name} to ${ctx.techName}`, options, sid => assignServiceFromTurns(entry.id, sid), ctx);   // xss-ok: title → #turns-assign-label.textContent
}
function _dragMove(entry, fromTech, targetTech, ctx, deps) {
  const isManager = ['admin', 'manager'].includes(getActiveUser()?.role);
  const options = movableServices(entry, fromTech, { isManager, isPaidStatus, ...deps });
  if (!options.length) { showToast(`Nothing of ${entry.name}’s can move to ${ctx.techName}`); return; }   // xss-ok: showToast sets textContent, not HTML
  _pickDragService('move', `Move which of ${entry.name}’s services to ${ctx.techName}?`, options, sid => _commitDragMove(entry.id, sid, fromTech, targetTech, ctx.techName), ctx);   // xss-ok: title → #turns-assign-label.textContent
}
// Re-find the entry at commit time + patch ONLY the moved assignment (queue.assignmentPatch, which the
// store applies to the CURRENT entry by id). This is what keeps the async think-time in the picker/
// confirm from letting a stale whole-entry upsert clobber a concurrent fees/items/discount edit (§14).
function _commitDragMove(entryId, serviceId, fromTech, targetTech, techName) {
  const entry = q().find(x => String(x.id) === String(entryId)); if (!entry) return;
  const a0 = (entry.assignments || []).find(x => x.serviceId === serviceId && x.techId === fromTech);
  if (!a0) { showToast('That service is no longer there to move'); return; }
  const a = JSON.parse(JSON.stringify(a0));            // patch a clone of only this assignment
  a.techId = targetTech; a.assignedAt = Date.now();    // dispatch stamps updatedAt/updatedBy; lands as the new tech's newest turn
  dispatch('queue.assignmentPatch', { entryId, serviceId, techId: fromTech, assignment: a });
  renderQueue(); renderTurns();
  showToast(`Moved ${svc(serviceId)?.label || 'service'} to ${techName}`);
}
// 0 → caller already toasted; 1 → straight through (still confirms if warnings apply); 2+ → picker.
let _dragPickState = null;
function _pickDragService(action, title, options, onPick, ctx) {
  const pick = opt => _confirmThenCommit(action, opt, onPick, ctx);
  if (options.length === 1) { pick(options[0]); return; }
  _dragPickState = { options, pick };
  document.getElementById('turns-assign-label').textContent = title;
  document.getElementById('turns-assign-list').innerHTML = options.map((o, i) => `<button onclick="turnsDragPickChoose(${i})" class="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-container transition-colors text-left border-t border-surface-container-high">
    <div class="w-2 h-2 rounded-full ${o.canDo ? 'bg-amber-400' : 'bg-outline-variant'} flex-shrink-0"></div>
    <span class="text-sm font-body font-semibold text-on-surface flex-1">${escHtml(o.svcLabel)}</span>
    ${o.needsOverride ? `<span class="text-[10px] font-body text-on-surface-variant flex-shrink-0">${_statusWord(o.status)}</span>` : ''}
    ${!o.canDo ? '<span class="text-[10px] font-body text-on-surface-variant italic flex-shrink-0">not their usual</span>' : ''}
  </button>`).join('');
  const m = document.getElementById('turns-assign-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function turnsDragPickChoose(i) {
  const st = _dragPickState; _dragPickState = null; closeTurnsAssignModal();
  const opt = st && st.options[i]; if (opt) st.pick(opt);
}
// Break/Off + skills (menu) + done override reasons combine into ONE confirm (never stacked modals),
// phrased with the right verb for the action ('assign' | 'move'). `ctx.techName` is for copy only.
function _confirmThenCommit(action, opt, onPick, ctx) {
  const go = () => onPick(opt.serviceId);
  const verb = action === 'move' ? 'Move' : 'Assign';
  const warns = [];
  if (ctx.breakOff) warns.push(`${ctx.techName} is on ${ctx.breakOff}.`);
  if (!opt.canDo) warns.push(`${ctx.techName} doesn’t normally do ${opt.svcLabel}.`);
  if (opt.needsOverride) warns.push(`${opt.svcLabel} is already ${_statusWord(opt.status)}.`);
  if (warns.length && window.showWarnModal) window.showWarnModal(`${verb} anyway?`, warns.join(' '), go, `Yes, ${verb.toLowerCase()}`);
  else go();
}

// ── Tech status menu ──────────────────────────────
let _techStatusMenuId = null;
export function showTechStatusMenu(event, staffId) {
  event.stopPropagation();
  const menu = document.getElementById('tech-status-menu');
  if (_techStatusMenuId === staffId && menu && !menu.classList.contains('hidden')) { closeTechStatusMenu(); return; }
  _techStatusMenuId = staffId;
  const st = staffById(staffId);
  if (!menu || !st) return;
  document.getElementById('tech-status-menu-name').textContent = st.name;
  const photoEl = document.getElementById('tech-status-menu-photo');
  if (photoEl) {
    const sc = getTechStatusColor(staffId);
    photoEl.innerHTML = st.photo
      ? `<img src="${st.photo}" style="width:175px;height:175px;border-radius:50%;object-fit:cover;border:6px solid ${sc.bg}">`
      : `<div style="width:175px;height:175px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${sc.bg}20;border:6px solid ${sc.bg};color:${sc.bg};font-family:var(--font-headline);font-weight:700;font-size:72px">${(st.name||'?').charAt(0).toUpperCase()}</div>`;
  }
  // Highlight the tech's CURRENT state (available / on break / off); dim the other two.
  const cur = cfg().turns_off.includes(staffId) ? 'off' : cfg().turns_break.includes(staffId) ? 'break' : 'available';
  document.getElementById('tsm-available').style.opacity = cur === 'available' ? '1' : '0.4';
  document.getElementById('tsm-break').style.opacity = cur === 'break' ? '1' : '0.4';
  const offEl = document.getElementById('tsm-off'); if (offEl) offEl.style.opacity = cur === 'off' ? '1' : '0.4';
  // Services split into what the tech CAN do (green ✓) and CAN'T (red ✗); empty menu = does everything.
  const split = _techServiceSplit(st, cfg().services);
  const svcRow = (s, icon, color) => `<div class="flex items-start gap-1" style="break-inside:avoid;margin-bottom:2px"><span class="material-symbols-outlined" style="font-size:14px;color:${color};flex-shrink:0;line-height:1.35">${icon}</span><span>${escHtml(s.label)}</span></div>`;
  document.getElementById('tech-status-menu-services').innerHTML = split.available.length ? split.available.map(s => svcRow(s, 'check', '#1d9e75')).join('') : '<div class="italic text-outline">None</div>';
  const noEl = document.getElementById('tsm-svc-no'); if (noEl) noEl.innerHTML = split.unavailable.length ? split.unavailable.map(s => svcRow(s, 'close', '#e24b4a')).join('') : '<div class="italic text-outline">—</div>';
  // Notes/preferences: a per-note list (add/edit/remove), editable by managers, read-only for others.
  _tsmCanEdit = canDo('manageStaff');
  renderTechNotesColumn(staffId);
  const rect = event.currentTarget.getBoundingClientRect();
  // Wider popup (available | not-available | notes, 3 columns): clamp left to the viewport, floored at 8 so it never pins off-screen.
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 776)) + 'px';
  menu.classList.remove('hidden');
  // Content-aware: flip above the tech if it would overflow the bottom of the viewport.
  const menuH = menu.offsetHeight;
  const openAbove = (window.innerHeight - rect.bottom) < (menuH + 16) && rect.top > (menuH + 16);
  menu.style.top = (openAbove ? rect.top - menuH - 8 : rect.bottom + 8) + 'px';
  // Named outside-click handler (not {once:true}) that IGNORES clicks inside the popup, so the notes
  // textarea can be focused/typed without dismissing. addEventListener dedupes the same reference, so
  // re-opening never stacks it; closeTechStatusMenu removes it (the single close path → no leak).
  setTimeout(() => document.addEventListener('click', _tsmOutsideClick), 10);
}
function _tsmOutsideClick(e) {
  const m = document.getElementById('tech-status-menu');
  if (m && m.contains(e.target)) return;   // clicks inside the popup keep it open (textarea, etc.)
  closeTechStatusMenu();
}
export function closeTechStatusMenu() {
  flushTechNoteDraft();   // commit a half-typed add-box / open inline edit on EVERY close path (X, Break/Off, outside)
  document.removeEventListener('click', _tsmOutsideClick);
  document.getElementById('tech-status-menu')?.classList.add('hidden');
  _techStatusMenuId = null;
  _tsmRemovePending = null;
  _tsmEditingId = null;
}

// ── Tech notes list (per-note add/edit/remove via the staff.notePatch op) ─────
let _tsmCanEdit = false;        // manager-only edit controls
let _tsmRemovePending = null;   // noteId awaiting a 2nd tap to confirm removal
let _tsmEditingId = null;       // noteId currently being inline-edited
const _noteUid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

// Re-reads the tech's current notes from the store and repaints the notes column in place (the popup
// is built imperatively with no store subscription, so each add/edit/remove calls this).
export function renderTechNotesColumn(staffId) {
  const list = document.getElementById('tsm-notes-list'); if (!list) return;
  const notes = normalizeNotesList(staffById(staffId));
  const canEdit = _tsmCanEdit;
  const rows = notes.map(n => `<div class="flex items-start gap-1.5 py-1 border-b border-surface-container-high" data-note-id="${n.id}">
      <span class="flex-1 text-xs font-body text-on-surface" style="white-space:pre-wrap;word-break:break-word">${escHtml(n.text)}</span>
      ${canEdit ? `<button onclick="tsmEditNote('${n.id}')" title="Edit" class="text-outline hover:text-primary flex-shrink-0 p-1 -m-0.5"><span class="material-symbols-outlined" style="font-size:15px">edit</span></button><button onclick="tsmRemoveNote('${n.id}', this)" title="Remove" class="text-outline hover:text-error flex-shrink-0 p-1 -m-0.5"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>` : ''}
    </div>`).join('') || `<div class="text-xs font-body italic text-outline py-1">${canEdit ? 'No notes yet — add one below.' : 'No notes yet.'}</div>`;
  const addBox = canEdit ? `<div class="flex items-center gap-1.5 mt-2">
      <input id="tsm-note-input" type="text" maxlength="${NOTE_MAX}" placeholder="Add a note…" onkeydown="if(event.key==='Enter')tsmAddNote()" class="flex-1 min-w-0 border border-surface-container-high rounded-lg px-2 py-1 text-xs font-body text-on-surface bg-transparent outline-none focus:border-primary">
      <button onclick="tsmAddNote()" class="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-body font-semibold" style="background:#2a7a4f;color:#fff">Add</button>
    </div>` : '';
  list.innerHTML = rows + addBox;
}
export function tsmAddNote() {
  const inp = document.getElementById('tsm-note-input'), id = _techStatusMenuId; if (!inp || !id) return;
  const text = (inp.value || '').trim(); if (!text) return;
  dispatch('staff.notePatch', { id, action: 'add', note: { id: _noteUid(), text } });
  renderTechNotesColumn(id);
  document.getElementById('tsm-note-input')?.focus();
}
export function tsmEditNote(noteId) {
  const row = document.querySelector(`#tsm-notes-list [data-note-id="${noteId}"]`), id = _techStatusMenuId; if (!row || !id) return;
  const n = normalizeNotesList(staffById(id)).find(x => x.id === noteId); if (!n) return;
  _tsmEditingId = noteId;
  row.innerHTML = `<input id="tsm-edit-input" type="text" maxlength="${NOTE_MAX}" onkeydown="if(event.key==='Enter')tsmEditSave('${noteId}')" class="flex-1 min-w-0 border border-primary rounded-lg px-2 py-1 text-xs font-body text-on-surface bg-transparent outline-none">
    <button onclick="tsmEditSave('${noteId}')" title="Save" class="text-primary flex-shrink-0"><span class="material-symbols-outlined" style="font-size:16px">check</span></button>`;
  const inp = row.querySelector('#tsm-edit-input'); if (inp) { inp.value = n.text; inp.focus(); }
}
export function tsmEditSave(noteId) {
  const inp = document.getElementById('tsm-edit-input'), id = _techStatusMenuId; if (!id) return;
  _tsmEditingId = null;
  const text = (inp?.value || '').trim();
  dispatch('staff.notePatch', text
    ? { id, action: 'edit', note: { id: noteId, text } }
    : { id, action: 'remove', note: { id: noteId } });   // cleared to empty → remove it
  renderTechNotesColumn(id);
}
export function tsmRemoveNote(noteId, btn) {
  const id = _techStatusMenuId; if (!id) return;
  if (_tsmRemovePending === noteId) {   // 2nd tap confirms
    _tsmRemovePending = null;
    dispatch('staff.notePatch', { id, action: 'remove', note: { id: noteId } });
    renderTechNotesColumn(id);
    return;
  }
  _tsmRemovePending = noteId;
  if (btn) btn.innerHTML = '<span class="text-[10px] font-semibold text-error">Remove?</span>';
  setTimeout(() => { if (_tsmRemovePending === noteId && _techStatusMenuId === id) { _tsmRemovePending = null; renderTechNotesColumn(id); } }, 3000);
}
// On close: commit a pending inline edit, then a non-empty add-box draft, so nothing typed is lost.
export function flushTechNoteDraft() {
  const id = _techStatusMenuId; if (!id) return;
  const draft = (document.getElementById('tsm-note-input')?.value || '').trim();   // snapshot BEFORE edit-save repaints the column
  if (_tsmEditingId && document.getElementById('tsm-edit-input')) tsmEditSave(_tsmEditingId);
  if (draft) dispatch('staff.notePatch', { id, action: 'add', note: { id: _noteUid(), text: draft } });
}
export function setTechBreak(isBreak) {
  if (!_techStatusMenuId) return;
  const id = _techStatusMenuId;
  let brk = cfg().turns_break.filter(x => x !== id);
  if (isBreak) brk.push(id);
  setBreak(brk);
  setOff(cfg().turns_off.filter(x => x !== id));
  closeTechStatusMenu();
  renderTurnsTechGrid();
}
export function setTechOff() {
  if (!_techStatusMenuId) return;
  toggleTurnsOffStaff(_techStatusMenuId);
  closeTechStatusMenu();
}
export function toggleTurnsOffStaff(staffId) {
  const off = cfg().turns_off;
  if (off.includes(staffId)) setOff(off.filter(id => id !== staffId));
  else { setOff([...off, staffId]); setBreak(cfg().turns_break.filter(id => id !== staffId)); }
  renderTurns();
}

// ── Tech selector modal (roster) ──────────────────
export function showTurnsTechSelector() {
  const list = document.getElementById('turns-tech-selector-list');
  const currentOrder = getActiveTurnsOrder();
  const activeOnly = activeStaff();
  if (activeOnly.length === 0) {
    list.innerHTML = `<div class="text-sm font-body text-on-surface-variant py-6 text-center">No staff found. Add staff in <strong>Settings → Staff Management</strong> first.</div>`;
    const m = document.getElementById('turns-tech-modal'); m.classList.remove('hidden'); m.style.display = 'flex'; return;
  }
  const remaining = activeOnly.filter(s => !currentOrder.includes(s.id)).sort(byName);
  const allForDisplay = [...currentOrder.map(id => activeOnly.find(s => s.id === id)).filter(Boolean), ...remaining];
  list.innerHTML = allForDisplay.map(st => {
    const inOrder = currentOrder.includes(st.id), orderIdx = currentOrder.indexOf(st.id);
    const photo = st.photo ? `<img src="${st.photo}" class="w-9 h-9 rounded-full object-cover flex-shrink-0">` : `<div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0"><span class="text-xs font-headline font-bold text-on-surface">${st.name.charAt(0)}</span></div>`;
    return `<div class="flex items-center gap-3 p-3 rounded-xl mb-1 cursor-pointer select-none tech-order-item ${inOrder ? 'bg-primary/10 border border-primary/30' : 'bg-surface-container border border-transparent'}" data-staff-id="${st.id}" data-in-order="${inOrder}" onclick="toggleTurnsTechOrder('${st.id}')">
      <span class="material-symbols-outlined text-outline-variant cursor-grab tech-drag-handle" style="font-size:20px" onpointerdown="startTechReorder(event)">drag_indicator</span>${photo}
      <div class="flex-grow"><div class="font-headline font-semibold text-on-surface text-sm">${st.name}</div>${inOrder ? `<div class="text-[11px] font-body text-primary">Turn order: #${orderIdx+1}</div>` : '<div class="text-[11px] font-body text-on-surface-variant">Not in today\'s rotation</div>'}</div>
      <div class="w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${inOrder ? 'bg-primary border-primary' : 'border-outline-variant'}">${inOrder ? '<span class="material-symbols-outlined text-on-primary" style="font-size:14px;font-variation-settings:\'FILL\' 1">check</span>' : ''}</div></div>`;
  }).join('');
  const m = document.getElementById('turns-tech-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function checkAllTechs() { setOrder([...activeStaff()].sort(byName).map(s => s.id)); showTurnsTechSelector(); }
export function uncheckAllTechs() { setOrder([]); showTurnsTechSelector(); }
export function toggleTurnsTechOrder(staffId) {
  const order = getActiveTurnsOrder();
  setOrder(order.includes(staffId) ? order.filter(id => id !== staffId) : [...order, staffId]);
  showTurnsTechSelector();
}
export function saveTurnsTechOrder() {
  closeTurnsTechModal();
  renderTurns();
  showToast(getActiveTurnsOrder().length + ' technician' + (getActiveTurnsOrder().length !== 1 ? 's' : '') + ' in today\'s rotation');
}
export function closeTurnsTechModal() { const m = document.getElementById('turns-tech-modal'); m.classList.add('hidden'); m.style.display = ''; }

// Tech selector drag-reorder
let _reorderDragging = null, _reorderClone = null, _reorderList = null;
export function startTechReorder(e) {
  e.stopPropagation();
  const item = e.currentTarget.closest('.tech-order-item');
  if (!item) return;
  _reorderDragging = item; _reorderList = item.parentNode;
  const rect = item.getBoundingClientRect();
  _reorderClone = item.cloneNode(true);
  _reorderClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.9;pointer-events:none;z-index:9999;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,0.28);transform:rotate(-1.5deg) scale(1.02);`;
  document.body.appendChild(_reorderClone);
  item.style.opacity = '0.3';
  document.addEventListener('pointermove', onTechReorderMove);
  document.addEventListener('pointerup', onTechReorderEnd, { once: true });
  e.preventDefault();
}
function onTechReorderMove(e) {
  if (!_reorderClone) return;
  _reorderClone.style.top = (e.clientY - 25) + 'px';
  const items = [..._reorderList.querySelectorAll('.tech-order-item')];
  items.forEach(i => i.classList.remove('drop-above'));
  const hovered = items.find(i => { if (i === _reorderDragging) return false; const r = i.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
  if (hovered) hovered.classList.add('drop-above');
}
function onTechReorderEnd(e) {
  document.removeEventListener('pointermove', onTechReorderMove);
  if (_reorderClone) { _reorderClone.remove(); _reorderClone = null; }
  if (!_reorderDragging) return;
  _reorderDragging.style.opacity = '';
  const items = [..._reorderList.querySelectorAll('.tech-order-item')];
  items.forEach(i => i.classList.remove('drop-above'));
  const hovered = items.find(i => { if (i === _reorderDragging) return false; const r = i.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
  if (hovered && hovered !== _reorderDragging) {
    _reorderList.insertBefore(_reorderDragging, hovered);
    setOrder([..._reorderList.querySelectorAll('.tech-order-item[data-in-order="true"]')].map(el => el.dataset.staffId));
    showTurnsTechSelector();
  }
  _reorderDragging = null; _reorderList = null;
}


// ── History (device-local archive) ────────────────
// Archive one day's turns snapshot into the device-local history (a fallback for the
// history grids; Reports + turns grids primarily rebuild from synced records). Filtered to
// the given day so the rollover keys the JUST-ENDED day correctly — the old "archive today
// at 4 AM" mis-keyed it, since todayStr() was already the new day by then.
export function archiveTurnsForDay(dateStr) {
  turnsHistory[dateStr] = {
    order: [...cfg().turns_order],
    snapshot: q().filter(e => localDateStr(new Date(e.checkinTime)) === dateStr)
      .map(e => ({ id: String(e.id), name: e.name, phone: e.phone||'', services: e.services, assignments: e.assignments||[], totalCost: e.totalCost||0, status: e.status, checkinTime: e.checkinTime })),
  };
  const keys = Object.keys(turnsHistory).sort().slice(-90);
  const pruned = {}; keys.forEach(k => pruned[k] = turnsHistory[k]);
  turnsHistory = pruned; saveTurnsHistory();
}
// Close out a finished day during the daily rollover: archive it, then clear the rotation
// so the new day starts fresh.
export function rolloverTurns(closedDateStr) { archiveTurnsForDay(closedDateStr); setOrder([]); setOff([]); }
export function openTurnsHistoryPicker(ev) {
  const today = new Date();
  const presets = [0, 1, 2, 3, 4, 5, 6].map(n => {
    const d = new Date(today); d.setDate(d.getDate() - n);
    return { label: n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`, date: localDateStr(d) };
  });
  window.openDayPicker?.(ev, { value: turnsViewingHistory || todayStr(), onPick: loadTurnsHistory, presets });
}
export function loadTurnsHistory(dateStr) {
  const today = todayStr();
  if (!dateStr || dateStr === today) { clearTurnsHistory(); return; }
  turnsViewingHistory = dateStr;
  const btn = document.getElementById('turns-date-btn-val'); if (btn) btn.textContent = dateBtnLabel(dateStr);
  renderTurnsTechGrid(); renderTurnsQueue();
}
export function clearTurnsHistory() {
  turnsViewingHistory = null;
  const btn = document.getElementById('turns-date-btn-val'); if (btn) btn.textContent = dateBtnLabel(null);
  renderTurns();
}
// Prev/next-day arrows on the Date bubble. Stepping to today (or a future day) returns
// to the live grid; you can't go past today (no future turns).
export function shiftTurnsDate(dir) {
  const cur = turnsViewingHistory ? new Date(turnsViewingHistory + 'T12:00:00') : new Date();
  cur.setDate(cur.getDate() + dir);
  const today = new Date(); today.setHours(0,0,0,0); cur.setHours(0,0,0,0);
  if (cur >= today) { clearTurnsHistory(); return; }
  loadTurnsHistory(localDateStr(cur));
}
// Past-day grid: built from the synced transaction records for the date (the same
// source Reports uses, so the two always agree), grouped per technician like the
// live grid. The device-local turndesk_turns_history snapshot is used only as a
// fallback for the tech ordering. Renders IDENTICALLY to the live grid — party
// dots (multiple guests on one ticket), split-tech link chips (one guest under
// 2+ techs), and group outlines — but greyed + read-only so a past day can't be
// changed by accident. Filled bubbles still open the historical edit modal for
// managers (intentional edit), so the look matches the live "paid" bubble exactly.
function histDayRecords(dateStr) {
  return (window.buildCombinedRecords?.() || []).filter(r => isPaidStatus(r.status) && localDateStr(new Date(r.checkinTime)) === dateStr);
}
function histAssignmentsByTech(recs) {
  const byTech = {};
  recs.forEach(r => (r.assignments || []).forEach(a => {
    const tid = a.techId || '__unassigned__';
    (byTech[tid] ||= []).push({ entry: r, assignment: a });
  }));
  Object.values(byTech).forEach(list => list.sort((x, y) =>
    (x.assignment.assignedAt || new Date(x.entry.checkinTime).getTime()) -
    (y.assignment.assignedAt || new Date(y.entry.checkinTime).getTime())));
  return byTech;
}
function renderTurnsHistoryView() {
  const grid = document.getElementById('turns-tech-grid');
  if (!grid) return;
  const dateStr = turnsViewingHistory;
  const dayRecs = histDayRecords(dateStr);
  const byTech = histAssignmentsByTech(dayRecs);
  const snap = turnsHistory[dateStr];

  // Same markers the live grid computes — fed from the day's records instead of q().
  // Party letters tie multiple guests on one ticket together; link chips flag one
  // guest with multiple service cards (same tech or split across techs).
  const partyLetters = partyLetterMap(dayRecs);
  const splitTags = new Map(); let _splitN = 0;
  dayRecs.forEach(r => {
    const assigned = (r.assignments || []).filter(a => a.techId).length;
    if (assigned >= 2) { splitTags.set(String(r.id), GROUP_COLORS[_splitN % GROUP_COLORS.length]); _splitN++; }
  });

  let order = (snap?.order || []).filter(id => id && staffById(id));
  if (order.length === 0) order = getActiveTurnsOrder();
  Object.keys(byTech).forEach(tid => { if (tid !== '__unassigned__' && !order.includes(tid)) order.push(tid); });

  const canAdd = canDo('historicalEntry');
  const addBtn = canAdd
    ? `<button onclick="showHistoricalEntryModal(null,'${dateStr}')" class="ml-auto flex items-center gap-1 bg-primary text-on-primary px-3 py-1.5 rounded-lg text-xs font-headline font-bold active:scale-95 transition-all"><span class="material-symbols-outlined" style="font-size:16px">add</span> Add turn to this day</button>`
    : '';
  const banner = `<div class="bg-secondary-container/30 rounded-xl px-4 py-2 mb-3 text-sm font-body text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">history</span> Past day — built from saved transactions${canAdd ? '. Tap a turn to edit.' : ''}${addBtn}</div>`;

  const hasData = Object.values(byTech).some(l => l.length);
  if (!hasData) {
    grid.innerHTML = banner + `<div class="text-sm font-body text-on-surface-variant py-8 text-center opacity-70">No completed turns recorded for this day.${canAdd ? '<br>Use “Add turn to this day” to recreate them.' : ''}</div>`;
    return;
  }

  const rowFor = (tid) => {
    const items = byTech[tid] || [];
    if (!items.length) return '';
    const isUnassigned = tid === '__unassigned__';
    const st = isUnassigned ? null : staffById(tid);
    if (!isUnassigned && !st) return '';
    const name = isUnassigned ? 'Unassigned' : st.name;
    const accent = isUnassigned ? '#9aa0a3' : '#1a5252';

    let full = 0, half = 0, bonus = 0, billed = 0;
    items.forEach(({ assignment: a }) => {
      const t = classifyTurn(a.cost || 0, a.serviceId || '');
      if (t === 'full') full++; else if (t === 'half') half += 0.5; else if (t === 'bonus') bonus++;
      billed += a.cost || 0;
    });
    const total = full + half;
    const isHalf = !Number.isInteger(total) && total > 0;
    const photo = (!isUnassigned && st.photo)
      ? `<img src="${st.photo}" class="w-10 h-10 rounded-full object-cover border-2 flex-shrink-0" style="border-color:${accent}">`
      : `<div class="w-10 h-10 rounded-full flex items-center justify-center border-2 flex-shrink-0 text-sm font-headline font-bold" style="background:${accent}20;border-color:${accent};color:${accent}">${isUnassigned ? '?' : name.charAt(0).toUpperCase()}</div>`;
    const turnDisplay = total > 0
      ? `<span class="text-sm font-headline font-bold ${isHalf ? 'px-1.5 py-0.5 rounded-md' : ''}" style="${isHalf ? 'background:#f5c870;color:#3a2800' : 'color:' + accent}">${total}t</span>`
      : `<span class="text-sm font-headline text-outline-variant">0t</span>`;
    const techCol = `<div class="flex items-center gap-2 flex-shrink-0 pr-2" style="width:var(--turns-techcol-w,155px)">${photo}
      <div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate leading-tight">${name}</div>
      <div class="flex items-center gap-1.5 mt-0.5">${turnDisplay}${bonus > 0 ? `<span class="text-[10px] text-secondary">+${bonus}b</span>` : ''}</div>
      <div class="turns-billed text-[10px] font-body font-semibold mt-0.5" style="color:#1a5252">$${billed.toFixed(0)} billed</div></div></div>`;

    let turnCounter = 0;
    const slotHtml = items.map(({ entry: e, assignment: a }) => {
      const cost = a.cost || 0;
      const tt = classifyTurn(cost, a.serviceId || '');
      if (tt === 'full') turnCounter += 1; else if (tt === 'half') turnCounter += 0.5;
      const turnLabelNum = Number.isInteger(turnCounter) ? turnCounter : turnCounter.toFixed(1);
      const turnLabel = tt === 'bonus' ? 'Bonus' : (cost === 0 ? '?' : '' + turnLabelNum);
      const s = svc(a.serviceId);
      const svcLabel = s ? s.label : (e.services || []).map(sid => svc(sid)?.label || '?').join(', ');
      const costStr = cost ? '$' + Number(cost).toFixed(0) : '';
      const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // Same group outline + party dot + split-tech link chip as the live grid.
      const outline = e.groupId ? `;outline:2px solid ${e.groupColor||'#e8a230'};outline-offset:-1px` : '';
      const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:${e.groupColor||'#888'};color:#fff;font-size:8px;font-weight:800;flex-shrink:0;margin-right:2px">${partyLetters.get(e.groupId)||'•'}</span>` : '';
      const splitColor = splitTags.get(String(e.id));
      const splitTag = splitColor ? `<span title="Same customer — multiple services" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:5px;background:${splitColor};color:#fff;flex-shrink:0;margin-right:2px"><span class="material-symbols-outlined" style="font-size:11px;font-variation-settings:'FILL' 1">link</span></span>` : '';
      const tap = canAdd ? `onclick="showHistoricalEntryModal('${e.id}')"` : '';
      return `<div class="flex-shrink-0 w-[150px] px-1">
        <button ${tap} class="w-full rounded-xl px-2 py-1.5 text-left ${canAdd ? 'active:scale-95 cursor-pointer' : 'cursor-default'} transition-all text-xs font-body" style="background:#dde2e5;color:#555;min-height:66px${outline}">
          <div class="flex items-center justify-between gap-0.5 mb-0.5"><div class="flex items-center gap-0.5 min-w-0">${groupDot}${splitTag}<span class="font-semibold text-[11px] truncate">${escHtml(e.name)}</span></div>${turnLabel ? `<span class="text-[11px] font-headline font-bold flex-shrink-0 ml-1" style="${turnPillStyle(tt, turnLabel)}">${turnLabel}</span>` : ''}</div>
          <div class="text-[10px] opacity-90 leading-tight">${svcLabel}${a.station ? ' · ' + a.station : ''}${costStr ? ' · ' + costStr : ''}</div>
          <div class="text-[9px] opacity-60">${timeStr}</div>
        </button></div>`;
    }).join('');

    return `<div class="flex items-center border-b border-surface-container-high py-1 gap-2">${techCol}
      <div class="turns-slot-row flex gap-1.5 overflow-x-auto pb-0.5" style="min-width:0;flex:1;scrollbar-width:thin">${slotHtml}</div></div>`;
  };

  grid.innerHTML = banner + order.map(rowFor).filter(Boolean).join('') + rowFor('__unassigned__');
  // Mouse-wheel → horizontal scroll for each tech's turn row (same as the live grid; the past-day
  // rows were missing this handler, so the wheel didn't scroll them).
  grid.querySelectorAll('.turns-slot-row').forEach(row => {
    row.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  });
}

// ── Export (CSV + PDF) — the currently-viewed day (today or a history date) ────
const _statusWord = ss => isPaidStatus(ss) ? 'Paid' : ss === 'complete' ? 'Done' : ss === 'inservice' ? 'In service' : 'Waiting';
// Roll an assignment list (+ today's skips) into a per-tech summary + per-turn detail.
function _turnRowsFromItems(items, skips, isHistory) {
  const merged = [
    ...items.map(it => ({ kind: 'a', it, t: it.assignment.assignedAt || new Date(it.entry.checkinTime).getTime() })),
    ...(skips || []).map(sk => ({ kind: 'skip', sk, t: new Date(sk.at).getTime() })),
  ].sort((a, b) => a.t - b.t);
  let counter = 0, full = 0, half = 0, bonus = 0, billed = 0;
  const detail = [];
  merged.forEach(m => {
    if (m.kind === 'skip') {
      counter += 1; full += 1;
      detail.push({ turn: counter, customer: '(skipped turn)', service: 'Turn passed · no customer', station: '', cost: 0, status: 'Skipped', time: new Date(m.sk.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      return;
    }
    const { entry: e, assignment: a } = m.it;
    const tt = classifyTurn(a.cost || 0, a.serviceId || '');
    if (tt === 'full') { counter += 1; full += 1; } else if (tt === 'half') { counter += 0.5; half += 0.5; } else if (tt === 'bonus') bonus += 1;
    const ss = getAssignmentStatus(e, a);
    if (isHistory || ss === 'complete' || isPaidStatus(ss)) billed += a.cost || 0;   // earned once the work is done
    const s = svc(a.serviceId);
    detail.push({
      turn: tt === 'bonus' ? 'Bonus' : (a.cost ? (Number.isInteger(counter) ? counter : counter.toFixed(1)) : '?'),
      customer: e.name, service: s ? s.label : (e.services || []).map(sid => svc(sid)?.label || '?').join(', '),
      station: a.station || '', cost: a.cost || 0, status: _statusWord(ss),
      time: new Date(e.checkinTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });
  return { turnsTotal: full + half, bonus, billed, detail };
}
function turnsExportData() {
  const dateStr = turnsViewingHistory || todayStr();
  const isHistory = !!turnsViewingHistory;
  const rows = [];
  if (isHistory) {
    const byTech = histAssignmentsByTech(histDayRecords(dateStr));
    const snap = turnsHistory[dateStr];
    let order = (snap?.order || []).filter(id => id && staffById(id));
    if (order.length === 0) order = getActiveTurnsOrder();
    Object.keys(byTech).forEach(tid => { if (tid !== '__unassigned__' && !order.includes(tid)) order.push(tid); });
    if (byTech['__unassigned__']) order.push('__unassigned__');
    order.forEach(tid => {
      const items = byTech[tid] || []; if (!items.length) return;
      const name = tid === '__unassigned__' ? 'Unassigned' : staffById(tid)?.name; if (!name) return;
      rows.push({ name, status: '—', ..._turnRowsFromItems(items, [], true) });
    });
  } else {
    getActiveTurnsOrder().forEach(staffId => {
      const st = staffById(staffId); if (!st) return;
      rows.push({ name: st.name, status: getTechStatusColor(staffId).label, ..._turnRowsFromItems(getTechAllAssignments(staffId), todaySkips(staffId), false) });
    });
  }
  return { dateStr, isHistory, rows };
}
export function exportTurnsCSV() {
  const { dateStr, rows } = turnsExportData();
  const m = [];
  m.push(['Technician Turns', new Date(dateStr + 'T12:00:00').toLocaleDateString()]);
  m.push([]); m.push(['SUMMARY']); m.push(['Technician', 'Status', 'Turns', 'Bonus', 'Billed']);
  rows.forEach(r => m.push([r.name, r.status, r.turnsTotal, r.bonus, '$' + r.billed.toFixed(2)]));
  m.push([]); m.push(['DETAIL']); m.push(['Technician', 'Turn', 'Customer', 'Service', 'Station', 'Cost', 'Status', 'Time']);
  rows.forEach(r => r.detail.forEach(d => m.push([r.name, d.turn, d.customer, d.service, d.station, d.cost ? '$' + Number(d.cost).toFixed(2) : '', d.status, d.time])));
  const csv = m.map(line => line.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `muse-turns-${dateStr}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Turns exported as CSV (opens in Excel)');
}
export function exportTurnsPDF() {
  const { dateStr, rows } = turnsExportData();
  const dt = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const totalTurns = rows.reduce((s, r) => s + r.turnsTotal, 0), totalBilled = rows.reduce((s, r) => s + r.billed, 0);
  const sumRows = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td style="text-align:center">${r.turnsTotal}</td><td style="text-align:center">${r.bonus}</td><td style="text-align:right">$${r.billed.toFixed(2)}</td></tr>`).join('');
  const detRows = rows.flatMap(r => r.detail.map(d => `<tr><td>${esc(r.name)}</td><td style="text-align:center">${esc(d.turn)}</td><td>${esc(d.customer)}</td><td>${esc(d.service)}</td><td>${esc(d.station)}</td><td style="text-align:right">${d.cost ? '$' + Number(d.cost).toFixed(2) : ''}</td><td>${esc(d.status)}</td><td>${esc(d.time)}</td></tr>`)).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Muse Turns — ${esc(dt)}</title>
    <style>@page{size:8.5in 11in;margin:0.5in}body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a}h1{font-size:18px;margin:0 0 2px}h2{font-size:13px;margin:18px 0 6px;border-bottom:2px solid #1a5252;padding-bottom:2px}.sub{color:#666;font-size:12px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f0f4f4}</style></head>
    <body><h1>Technician Turns</h1><div class="sub">${esc(dt)} · ${rows.length} technician${rows.length !== 1 ? 's' : ''} · ${totalTurns} turns · $${totalBilled.toFixed(2)} billed</div>
    <h2>Summary</h2><table><thead><tr><th>Technician</th><th>Status</th><th style="text-align:center">Turns</th><th style="text-align:center">Bonus</th><th style="text-align:right">Billed</th></tr></thead><tbody>${sumRows || '<tr><td colspan="5">No turns this day.</td></tr>'}</tbody></table>
    <h2>Detail</h2><table><thead><tr><th>Technician</th><th style="text-align:center">Turn</th><th>Customer</th><th>Service</th><th>Station</th><th style="text-align:right">Cost</th><th>Status</th><th>Time</th></tr></thead><tbody>${detRows || '<tr><td colspan="8">No turns this day.</td></tr>'}</tbody></table>
    </body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(u, '_blank'); if (w) setTimeout(() => w.print(), 600); else showToast('Allow pop-ups to print');
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

// ── Drag & drop (event delegation) ────────────────
(function initTurnsDrag() {
  let dragEntryId = null, dragTechId = null, dragClone = null, isDragging = false;
  const DRAG_THRESH = 6; let startX = 0, startY = 0, pendingEntry = null;
  let justDragged = false;   // suppress the click that trails a real drag (so a reorder doesn't also open Assign&Price)
  // Touch: a customer bubble only becomes draggable after a tap-and-hold, so a normal
  // swipe scrolls the tech's turn row (overflow-x) / the waiting list instead of grabbing
  // the bubble. Mouse keeps the move-threshold drag (no drag-to-scroll on desktop).
  let longPressTimer = null, longPressArmed = false, pointerKind = 'mouse';
  const LONG_PRESS_MS = 400;   // hold this long before a bubble lifts
  const TOUCH_CANCEL = 10;     // finger travel (px) before the hold fires = "scroll", not "grab"
  function getTarget(e, selector) { let el = e.target; while (el && el !== document.body) { if (el.matches && el.matches(selector)) return el; el = el.parentElement; } return null; }
  function startDrag(card) {
    isDragging = true; dragEntryId = card.dataset.entryId; dragTechId = card.dataset.techId || null;
    const rect = card.getBoundingClientRect();
    dragClone = card.cloneNode(true);
    dragClone.style.cssText = ['position:fixed',`left:${rect.left}px`,`top:${rect.top}px`,`width:${rect.width}px`,'opacity:0.92','pointer-events:none','z-index:9999','border-radius:12px','box-shadow:0 14px 44px rgba(0,0,0,0.28)','transform:rotate(1.5deg) scale(1.03)','transition:none','background:white'].join(';');
    document.body.appendChild(dragClone);
    card.style.opacity = '0.2'; card.style.transform = 'scale(0.97)';
  }
  function endDrag(e) {
    if (!isDragging) { pendingEntry = null; return; }
    isDragging = false;
    justDragged = true; setTimeout(() => { justDragged = false; }, 400);
    if (dragClone) { dragClone.remove(); dragClone = null; }
    document.querySelectorAll('#turns-waiting-list [data-entry-id], #turns-active-list [data-entry-id], .turns-filled-slot').forEach(c => { c.style.opacity = ''; c.style.transform = ''; });
    document.querySelectorAll('.turns-empty-slot').forEach(s => s.classList.remove('turns-drop-highlight'));
    document.querySelectorAll('.turns-reorder-target').forEach(s => s.classList.remove('turns-reorder-target'));
    const capturedId = dragEntryId, capturedTech = dragTechId;
    dragEntryId = null; dragTechId = null; pendingEntry = null;
    if (!capturedId) return;
    const pt = document.elementFromPoint(e.clientX, e.clientY);
    const filledTarget = pt?.closest('.turns-filled-slot');
    if (filledTarget && filledTarget.dataset.techId === capturedTech && filledTarget.dataset.entryId !== capturedId) {
      window.showWarnModal?.('Reorder turns?', 'Move this customer before the selected slot? All other turns shift accordingly.', () => reorderTurnSlots(capturedTech, capturedId, filledTarget.dataset.entryId));
      return;
    }
    // Resolve the target tech from anywhere on a tech's row — the empty "+" slot OR a filled slot — so
    // "drop onto this tech" always works, not only on the empty slot.
    const targetTech = pt?.closest('.turns-drop-zone')?.dataset.techId || filledTarget?.dataset.techId;
    if (!targetTech) return;
    // Dropped an assigned customer back on their OWN tech (not a reorder) → nothing to reassign.
    if (capturedTech && capturedTech === targetTech) return;
    // capturedTech set = this customer is already assigned there → a MOVE; null = waiting → an ASSIGN.
    // Both route through the scoped "which service?" flow (only the dragged customer).
    dragDropToTech(capturedId, capturedTech, targetTech);
  }
  document.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    const card = getTarget(e, '.turns-filled-slot, #turns-waiting-list [data-entry-id], #turns-active-list [data-entry-id]');
    if (!card) return;
    // We don't preventDefault, so a tap still fires the button's click (opens
    // Assign&Price); a drag suppresses the trailing click via justDragged.
    startX = e.clientX; startY = e.clientY; pendingEntry = card; longPressArmed = false;
    pointerKind = e.pointerType || 'mouse';
    clearTimeout(longPressTimer);
    if (pointerKind === 'touch') {
      // Arm the drag only after a stationary hold; a swipe cancels it (below) so the row scrolls.
      longPressTimer = setTimeout(() => {
        if (pendingEntry && !isDragging) { longPressArmed = true; startDrag(pendingEntry); if (navigator.vibrate) navigator.vibrate(12); }
      }, LONG_PRESS_MS);
    }
  });
  document.addEventListener('pointermove', function(e) {
    if (isDragging && dragClone) {
      const w = parseFloat(dragClone.style.width);
      dragClone.style.left = (e.clientX - w/2) + 'px'; dragClone.style.top = (e.clientY - 30) + 'px';
      document.querySelectorAll('.turns-empty-slot').forEach(slot => { const r = slot.getBoundingClientRect(); slot.classList.toggle('turns-drop-highlight', e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom); });
      // Reorder target: highlight the same-tech filled slot the dragged customer would land before.
      document.querySelectorAll('.turns-filled-slot').forEach(slot => {
        const r = slot.getBoundingClientRect();
        const over = e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom;
        slot.classList.toggle('turns-reorder-target', over && slot.dataset.techId === dragTechId && slot.dataset.entryId !== dragEntryId);
      });
      return;
    }
    if (pendingEntry && !isDragging) {
      const dx = e.clientX - startX, dy = e.clientY - startY, dist = Math.sqrt(dx*dx + dy*dy);
      if (pointerKind === 'touch') {
        // Moved before the hold fired → it's a scroll, not a grab: stand down.
        if (dist > TOUCH_CANCEL) { clearTimeout(longPressTimer); pendingEntry = null; }
      } else if (dist > DRAG_THRESH) {
        startDrag(pendingEntry);
      }
    }
  });
  document.addEventListener('pointerup', function(e) { clearTimeout(longPressTimer); if (isDragging) endDrag(e); else pendingEntry = null; isDragging = false; longPressArmed = false; });
  document.addEventListener('pointercancel', function() {
    clearTimeout(longPressTimer); longPressArmed = false;
    isDragging = false; if (dragClone) { dragClone.remove(); dragClone = null; }
    document.querySelectorAll('.turns-filled-slot, #turns-waiting-list [data-entry-id], #turns-active-list [data-entry-id]').forEach(c => { c.style.opacity=''; c.style.transform=''; });
    document.querySelectorAll('.turns-empty-slot').forEach(s => s.classList.remove('turns-drop-highlight'));
    document.querySelectorAll('.turns-reorder-target').forEach(s => s.classList.remove('turns-reorder-target'));
    pendingEntry = null; dragEntryId = null; dragTechId = null;
  });
  // While a touch-drag is live, stop the page/row from scrolling under the clone.
  // Non-passive so preventDefault actually cancels the scroll on iOS Safari.
  document.addEventListener('touchmove', function(e) { if (isDragging) e.preventDefault(); }, { passive: false });
  // After a real drag, swallow the trailing click so a filled slot's onclick
  // (open Assign&Price) doesn't fire on top of the reorder. Capture phase → runs
  // before the inline onclick and stops it reaching the target.
  document.addEventListener('click', function(e) {
    if (justDragged) { justDragged = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

// ── Resizable Turns/Waiting divider (device-local width) ──────────────────────
// Drag #turns-split-handle to widen/narrow the waiting+active panel; the tech grid
// (flex-grow) takes the rest. Width persists per device (like the calendar-hours pref).
(function initTurnsSplit() {
  const KEY = 'turndesk_turns_split', MIN = 260, MAX = 680;
  const panel = () => document.getElementById('turns-side-panel');
  function restore() { const v = parseInt(localStorage.getItem(KEY) || '', 10); const p = panel(); if (p && v >= MIN && v <= MAX) p.style.width = v + 'px'; }
  document.addEventListener('DOMContentLoaded', restore); restore();
  let dragging = false;
  document.addEventListener('pointerdown', e => {
    if (!(e.target.closest && e.target.closest('#turns-split-handle'))) return;
    dragging = true; e.preventDefault(); document.body.style.userSelect = 'none';
  });
  document.addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = panel(); if (!p) return;
    const w = Math.max(MIN, Math.min(MAX, p.getBoundingClientRect().right - e.clientX));
    p.style.width = w + 'px';
  });
  document.addEventListener('pointerup', () => {
    if (!dragging) return; dragging = false; document.body.style.userSelect = '';
    const p = panel(); if (p) localStorage.setItem(KEY, String(parseInt(p.style.width, 10) || 380));
  });
})();
