// TurnDesk marketing site — contact form. Standalone (no app modules); posts a demo-request
// lead to the Worker's existing /demo/request (validated + rate-limited server-side).
//
// The ?api= test override is deliberately NOT the app's apiorigin.js: same EXACT-match
// allow-list (a wildcard would let a look-alike worker on an attacker's account receive
// visitors' contact info via a crafted link), but NEVER persisted — this page shares the
// github.io origin with the live app, so writing localStorage here could silently repoint
// the real app (td_api_origin) or send future real leads to the staging queue.
export const PROD_ORIGIN = 'https://turndesk.musenailandspa.workers.dev';
export const STAGING_ORIGIN = 'https://turndesk-staging.musenailandspa.workers.dev';
const LOCAL_ORIGIN = 'http://localhost:8787';
const OVERRIDE_ALLOWED = [STAGING_ORIGIN, LOCAL_ORIGIN];

export function resolveApiOrigin(search) {
  let api = null;
  try { api = new URLSearchParams(search || '').get('api'); } catch {}
  return OVERRIDE_ALLOWED.includes(api) ? api : PROD_ORIGIN;
}

// Client-side mirror of cloudflare/demo-util.js validateDemoRequest (same limits + messages),
// so nearly every rejection is caught before the network. The server re-validates regardless.
export function validateContact(body) {
  const b = body || {};
  const name       = String(b.name || '').trim();
  const email      = String(b.email || '').trim().toLowerCase();
  const phone      = String(b.phone || '').trim();
  const lookingFor = String(b.lookingFor || '').trim();
  if (name.length < 1)   return { ok: false, error: 'Please enter your name.' };
  if (name.length > 60)  return { ok: false, error: 'Name is too long.' };
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email.' };
  if (phone.length > 40)  return { ok: false, error: 'Phone number is too long.' };
  if (lookingFor.length < 1)   return { ok: false, error: 'Tell us a little about what you’re looking for.' };
  if (lookingFor.length > 500) return { ok: false, error: 'Please shorten that a little (500 characters max).' };
  return { ok: true, value: { name, email, phone, lookingFor } };
}

// ── Browser wiring (skipped under node tests) ─────────────────────────────────
if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const showErr = m => { const e = $('contact-error'); e.textContent = m; e.classList.remove('hidden'); };

  const form = $('contact-form');
  if (form) form.addEventListener('submit', async ev => {
    ev.preventDefault();
    $('contact-error').classList.add('hidden');
    const checked = validateContact({
      name: $('c-name').value, email: $('c-email').value,
      phone: $('c-phone').value, lookingFor: $('c-looking').value,
    });
    if (!checked.ok) { showErr(checked.error); return; }
    const btn = $('contact-submit');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch(resolveApiOrigin(location.search) + '/demo/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checked.value),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        $('contact-card').classList.add('hidden');
        const done = $('contact-done');
        done.classList.remove('hidden');
        done.focus();
        return;
      }
      showErr(j.error || 'Something went wrong — please try again.');
    } catch {
      showErr('Couldn’t reach the server — check your connection and try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Request my demo';
    }
  });
}
