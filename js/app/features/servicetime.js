// ── Per-tech / per-service service-time analytics ────────────────────────────
// Each assignment carries its own in-service clock (a.serviceMs + a.svcStartedAt,
// stamped in status.js applyAssignmentStatus). This module turns those durations
// into a per-(tech, service) average with outlier rejection, and a live badge that
// compares a customer's elapsed service time against the responsible tech's average.

import { getState } from '../store.js';

// Outlier window + minimum sample size. A pedicure that "took 2 minutes" because the
// front desk marked it In Service late sits far below the median and is dropped; a
// "3-hour" service from a forgotten Complete sits far above and is dropped too.
const OUTLIER_LO = 0.4;   // drop samples below 40% of the median
const OUTLIER_HI = 2.5;   // drop samples above 250% of the median
const MIN_SAMPLES = 3;    // need at least this many clean samples to show an average

export function fmtDur(ms) {
  if (ms == null || !(ms >= 0)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Average completed service time for a (tech, service) pair, in ms.
// Returns { avgMs:null, n } when there isn't enough clean data to be meaningful.
export function avgServiceTime(techId, serviceId) {
  if (!techId || !serviceId) return { avgMs: null, n: 0 };
  // Per-tech reset: ignore visits before this tech's benchmark cutoff (non-destructive —
  // records are untouched; the average just rebuilds from visits on/after the reset).
  const resetTs = getState().config?.svc_time_reset?.[techId] || 0;
  const samples = [];
  (getState().records || []).forEach(r => {
    if (resetTs && new Date(r.checkinTime).getTime() < resetTs) return;
    (r.assignments || []).forEach(a => {
      if (a.techId === techId && a.serviceId === serviceId && a.serviceMs > 0) samples.push(a.serviceMs);
    });
  });
  if (samples.length < MIN_SAMPLES) return { avgMs: null, n: samples.length };
  const med = median([...samples].sort((x, y) => x - y));
  const kept = samples.filter(s => s >= med * OUTLIER_LO && s <= med * OUTLIER_HI);
  if (kept.length < MIN_SAMPLES) return { avgMs: null, n: kept.length };
  return { avgMs: kept.reduce((s, x) => s + x, 0) / kept.length, n: kept.length };
}

// Elapsed in-service time for one assignment right now (live spell + any banked ms).
export function liveAssignmentMs(a) {
  if (!a) return null;
  const banked = a.serviceMs || 0;
  if ((a.status === 'inservice') && a.svcStartedAt) return banked + (Date.now() - a.svcStartedAt);
  return banked > 0 ? banked : null;
}

// Badge data for a bubble: elapsed (live or final) vs the tech's average, with a
// color cue. Returns null when there's no tech+service or no elapsed time yet.
export function serviceTimeInfo(a) {
  if (!a || !a.techId || !a.serviceId) return null;
  const elapsed = liveAssignmentMs(a);
  if (elapsed == null) return null;
  const { avgMs, n } = avgServiceTime(a.techId, a.serviceId);
  let color = '#6b7280';                          // grey: no benchmark yet
  if (avgMs != null) {
    if (elapsed <= avgMs) color = '#2a7a4f';        // green: at/under average
    else if (elapsed <= avgMs * 1.2) color = '#b07a1a'; // amber: slightly over
    else color = '#c0392b';                          // red: well over
  }
  const live = a.status === 'inservice';
  const text = fmtDur(elapsed) + (avgMs != null ? ` ▸ ~${fmtDur(avgMs)}` : '');
  return { text, color, live, elapsed, avgMs, n };
}
