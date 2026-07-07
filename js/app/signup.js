// Public self-serve signup — pre-salon, standalone. Plain fetch (no session/app modules).
const ORIGIN = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://localhost:8787' : 'https://turndesk.musenailandspa.workers.dev';
const $ = id => document.getElementById(id);
function showErr(m) { const e = $('signup-error'); e.textContent = m; e.classList.remove('hidden'); }

export async function submitSignup() {
  const btn = $('signup-submit');
  $('signup-error').classList.add('hidden');
  const body = {
    business: $('su-business').value, ownerName: $('su-name').value, email: $('su-email').value,
    password: $('su-password').value, phone: $('su-phone').value, note: $('su-note').value,
  };
  if (!body.business.trim() || !body.ownerName.trim() || !body.email.trim() || !body.password) { showErr('Please fill in your business, name, email, and password.'); return; }
  if (body.password.length < 6) { showErr('Password must be at least 6 characters.'); return; }
  if (body.password !== $('su-password2').value) { showErr('Passwords don’t match.'); return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch(ORIGIN + '/signup/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { $('signup-form').classList.add('hidden'); $('signup-done').classList.remove('hidden'); return; }
    showErr(j.error || 'Something went wrong — please try again.');
  } catch (e) { showErr('Couldn’t reach the server — check your connection and try again.'); }
  finally { btn.disabled = false; btn.textContent = 'Request access'; }
}
window.submitSignup = submitSignup;
