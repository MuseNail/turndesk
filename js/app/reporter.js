// ── reporter.js — automatic error / bug reporting ────────────────────────────
// On a headless front-desk iPad nobody watches the console, so a failure the owner
// doesn't witness in the moment is otherwise lost. This captures uncaught errors and
// explicit reportError() calls and POSTs them to the Worker's /report endpoint, where
// they are deduped, capped, and (for new/serious ones) pushed to the owner.
//
// Design rules (this code must be the MOST defensive in the app):
//   • It must NEVER throw — a bug in the reporter must not create the very failures it
//     reports, nor break the surrounding code that called it.
//   • It must NOT recurse — reporting a failure must not itself trigger a report.
//   • It must survive offline — reports queue in localStorage and flush on reconnect.
// Import it FIRST (right after apptoken) in every entry point so it's armed before any
// other module can throw.
import { APP_VERSION, REPORT_PROXY } from './config.js';

const APP     = 'turndesk';
const QKEY    = 'turndesk_error_queue';   // durable offline queue of un-sent reports
const MAX_Q   = 30;                   // cap the queue so a long offline spell can't bloat localStorage
const crumbs  = [];                   // rolling breadcrumb trail (last ~20 actions), attached to each report
let   sending = false;                // re-entrancy + self-recursion guard
let   installed = false;

// Leave a trail of what happened just before a crash. Cheap; call it from notable
// actions (nav, save, pay, sync events) to make a report actionable.
export function breadcrumb(msg) {
  try {
    const t = new Date().toISOString().slice(11, 19);   // HH:MM:SS, no Date.now math needed
    crumbs.push(t + ' ' + String(msg).slice(0, 120));
    if (crumbs.length > 20) crumbs.shift();
  } catch (e) { /* never throw from a breadcrumb */ }
}

function activeContext() {
  let user = '', view = '';
  try { user = (window.getActiveUser && window.getActiveUser() || {}).name || ''; } catch (e) {}
  try {
    const nav = document.querySelector('.nav-btn.active, .nav-item.active, [data-nav].active');
    view = (nav && nav.textContent || '').trim().slice(0, 60) || (location.hash || '').slice(0, 60);
  } catch (e) {}
  return { user, view };
}

// Stable id for an error: same bug repeats → same fingerprint → the server bumps a
// count instead of piling up duplicates. Message + first app stack frame + context.
function fingerprintOf(message, stack, context) {
  let frame = '';
  try { frame = (String(stack).split('\n').find(l => /\.js/.test(l)) || '').trim().slice(0, 120); } catch (e) {}
  const s = String(context || '') + '|' + String(message).slice(0, 140) + '|' + frame;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return APP + ':' + (h >>> 0).toString(36);
}

function loadQ() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]') || []; } catch (e) { return []; } }
function saveQ(q) { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-MAX_Q))); } catch (e) {} }

// The one entry point. `context` = where it happened ("chargeOnHelcim", "window.error").
// `err` = an Error or string. `opts.serious` = payment/data-loss class → always alerts.
export function reportError(context, err, opts) {
  try {
    const message = String((err && (err.message || err)) || 'unknown error').slice(0, 500);
    const stack   = String((err && err.stack) || '').slice(0, 4000);
    const { user, view } = activeContext();
    let device = ''; try { device = localStorage.getItem('turndesk_device_id') || ''; } catch (e) {}
    const rep = {
      app: APP,
      version: APP_VERSION,
      context: String(context || '').slice(0, 120),
      message, stack, view, user, device,
      ua: (navigator.userAgent || '').slice(0, 200),
      online: navigator.onLine !== false,
      breadcrumbs: crumbs.slice(-20),
      fingerprint: fingerprintOf(message, stack, context),
      serious: !!(opts && opts.serious),
      ts: Date.now(),
    };
    const q = loadQ();
    q.push(rep);
    saveQ(q);
    flush();
  } catch (e) { /* a reporter that throws is worse than a lost report */ }
}

// Send queued reports oldest-first, one at a time; stop on the first network failure and
// leave the rest queued for the next flush (reconnect / next report / next boot).
async function flush() {
  if (sending) return;
  if (!loadQ().length) return;
  sending = true;
  try {
    let guard = 0;
    while (loadQ().length && guard++ < MAX_Q + 5) {
      const rep = loadQ()[0];
      let ok = false;
      try {
        const r = await fetch(REPORT_PROXY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rep),
          keepalive: true,   // best-effort deliver even if the tab is closing
        });
        ok = !!(r && r.ok);
      } catch (e) { ok = false; }
      if (!ok) break;                       // still offline / server down → keep queued
      const q = loadQ(); q.shift(); saveQ(q);   // re-read so reports added mid-flush aren't lost
    }
  } catch (e) { /* swallow */ }
  sending = false;
}

// Arm the reporter: flush anything left from a previous session and re-flush on reconnect.
// The window 'error'/'unhandledrejection' hooks live in main.js (they also show the toast)
// and call reportError — so we do NOT add duplicate listeners here.
export function initReporter() {
  if (installed) return;
  installed = true;
  try {
    window.addEventListener('online', () => { try { flush(); } catch (e) {} });
    flush();
  } catch (e) {}
}
