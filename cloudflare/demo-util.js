// Pure helpers for the "Request a live demo" lead form (no Cloudflare APIs -> unit-testable
// + wrangler-bundled into worker.js). Mirrors signup-util.js's validateSignupRequest shape;
// a demo request is a lead, not an account — no password, no slug, just contact + intent.
export function validateDemoRequest(body) {
  const b = body || {};
  const name       = String(b.name || '').trim();
  const email      = String(b.email || '').trim().toLowerCase();
  const phone      = String(b.phone || '').trim();
  const lookingFor = String(b.lookingFor || '').trim();
  if (name.length < 1)   return { ok: false, error: 'Enter your name.' };
  if (name.length > 60)  return { ok: false, error: 'Name is too long.' };
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email.' };
  if (phone.length > 40)  return { ok: false, error: 'Phone number is too long.' };
  if (lookingFor.length < 1)   return { ok: false, error: 'Tell us what you’re looking for.' };
  if (lookingFor.length > 500) return { ok: false, error: 'Please shorten that a little (500 characters max).' };
  return { ok: true, value: { name, email, phone, lookingFor } };
}
