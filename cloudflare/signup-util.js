// Pure helpers for self-serve signup (no Cloudflare APIs -> unit-testable + wrangler-bundled into worker.js).
export function slugify(name) {
  let s = String(name || '').normalize('NFKD').replace(/\p{Mn}/gu, '')  // strip accents (nonspacing marks)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, 32).replace(/-+$/g, '');
  if (s.length < 3) s = 'salon';
  return s;
}

export function validateSignupRequest(body) {
  const b = body || {};
  const business  = String(b.business || '').trim();
  const ownerName = String(b.ownerName || '').trim();
  const email     = String(b.email || '').trim().toLowerCase();
  const password  = String(b.password || '');
  const phone     = String(b.phone || '').trim();
  const note      = String(b.note || '').trim();
  if (business.length < 1 || business.length > 80)   return { ok: false, error: 'Enter your business name.' };
  if (ownerName.length < 1 || ownerName.length > 60) return { ok: false, error: 'Enter your name.' };
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email.' };
  if (password.length < 6 || password.length > 200)  return { ok: false, error: 'Password must be at least 6 characters.' };
  if (phone.length > 40)  return { ok: false, error: 'Phone number is too long.' };
  if (note.length > 500)  return { ok: false, error: 'Note is too long.' };
  return { ok: true, value: { business, ownerName, email, password, phone, note } };
}
