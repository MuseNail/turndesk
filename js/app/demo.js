// Public "request a live demo" lead form — pre-salon, standalone. Plain fetch
// (no session/app modules), mirroring signup.js. Posts to /demo/request, which the
// Worker forwards to the reserved registry DO for the operator to follow up on.
const ORIGIN = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://localhost:8787' : 'https://turndesk.musenailandspa.workers.dev';
const $ = id => document.getElementById(id);
function showErr(m) { const e = $('demo-error'); e.textContent = m; e.classList.remove('hidden'); }

export async function submitDemoRequest() {
  const btn = $('demo-submit');
  $('demo-error').classList.add('hidden');
  const body = {
    name: $('d-name').value, email: $('d-email').value,
    phone: $('d-phone').value, lookingFor: $('d-looking').value,
  };
  if (!body.name.trim() || !body.email.trim()) { showErr('Please fill in your name and email.'); return; }
  if (!body.lookingFor.trim()) { showErr('Tell us a little about what you’re looking for.'); return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch(ORIGIN + '/demo/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { $('demo-form').classList.add('hidden'); $('demo-done').classList.remove('hidden'); return; }
    showErr(j.error || 'Something went wrong — please try again.');
  } catch (e) { showErr('Couldn’t reach the server — check your connection and try again.'); }
  finally { btn.disabled = false; btn.textContent = 'Request my demo'; }
}
window.submitDemoRequest = submitDemoRequest;
