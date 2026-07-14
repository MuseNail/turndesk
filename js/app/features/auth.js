// ── Auth: PIN login + front-desk users ──────────────────────────────────────
// activeUser lives in session.js (per-device). Front-desk users are synced config.

import { getState } from '../store.js';
import { dispatch, resync } from '../sync.js';
import { showToast, escHtml, throttleWaitMsg } from '../utils.js';
import { getActiveUser, setActiveUser } from '../session.js';
import { serverLogin, serverFindLogin, urlSalonSlug } from '../apptoken.js';

const cfg = () => getState().config;
const isAdmin = () => getActiveUser()?.role === 'admin';   // only admins manage login accounts
let pinBuffer = '';

// ── Logged-in user display ────────────────────────
export function updateLoggedInDisplay() {
  const nameEl   = document.getElementById('logged-in-name');
  const avatarEl = document.getElementById('logged-in-avatar');
  if (!nameEl || !avatarEl) return;
  const au   = getActiveUser();
  const name = au?.name || 'Manager';
  nameEl.textContent = name;

  const fdUser    = cfg().fd_users.find(u => u.id === au?.id);
  const staffUser = cfg().staff.find(s => s.id === au?.id) || cfg().staff.find(s => s.name === name);
  const photo     = fdUser?.photo || staffUser?.photo || null;

  if (photo) avatarEl.innerHTML = `<img src="${escHtml(photo)}" class="w-full h-full rounded-full object-cover">`;
  else { avatarEl.innerHTML = ''; avatarEl.textContent = name.charAt(0).toUpperCase(); }

  window.updateHistoricalButtonVisibility?.();
  window.updatePermissionGatedUI?.();
  window.applyUserTheme?.();   // load the logged-in user's per-login theme
  window.renderClockButton?.();   // show the time-clock button for a front-desk user
}

// ── PIN modal ─────────────────────────────────────
// { ownerLogin:true } opens straight to the email/password toggle (the sign-in
// screen's "Forgot PIN? · Owner sign-in" link) instead of the numeric pad — avoids
// racing two separate autofocus timers (pad vs owner email) against each other.
export function showPinModal({ ownerLogin = false } = {}) {
  pinBuffer = '';
  setActiveUser(null);
  window.applyUserTheme?.();   // revert to the default palette on the login screen
  updatePinDots();
  document.getElementById('pin-error').classList.add('hidden');
  document.getElementById('pin-matched-user').textContent = '';
  _setPinStatus();
  const m = document.getElementById('pin-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  if (ownerLogin) {
    showOwnerLogin();
  } else {
    showPinEntry();   // always open on the PIN view (not a stale owner form)
    setTimeout(() => { const kb = document.getElementById('pin-keyboard-input'); if (kb) { kb.value = ''; kb.focus(); } }, 100);
  }
}

// Log out the current user: confirm, clear the session, then return to THIS device's
// signed-out landing — the customer kiosk (+ PIN keypad) on a front-desk device, or the
// business sign-in everywhere else.
export function logout() {
  const doLogout = () => {
    setActiveUser(null);
    if (isKioskDevice()) { window.goTo?.('screen-welcome'); showPinModal(); }
    else {
      const e = document.getElementById('signin-email');    if (e) e.value = '';
      const p = document.getElementById('signin-password'); if (p) p.value = '';
      document.getElementById('signin-error')?.classList.add('hidden');
      window.goTo?.('screen-signin');
      renderSigninScreen({ openPin: true });   // same adaptive lead-with-PIN behavior as boot
    }
  };
  if (window.showWarnModal) window.showWarnModal('Log out?', 'You will need to sign in again.', doLogout);
  else doLogout();
}

export function pinCancel() {
  const m = document.getElementById('pin-modal');
  m.classList.add('hidden'); m.style.display = '';
  pinBuffer = '';
}

export function pinInput(d) {
  if (pinBuffer.length >= 6) return;
  pinBuffer += d;
  updatePinDots();
  checkPin();
}

export function onPinKeyboard(val) {
  pinBuffer = (val || '').replace(/\D/g, '').slice(0, 6);
  document.getElementById('pin-keyboard-input').value = pinBuffer;
  updatePinDots();
  checkPin();
}

export function pinBackspace() {
  pinBuffer = pinBuffer.slice(0, -1);
  document.getElementById('pin-keyboard-input').value = pinBuffer;
  updatePinDots();
  document.getElementById('pin-matched-user').textContent = '';
}

// Shared success path for both the local PIN match and the server (§13) login.
function _finishPinLogin(user) {
  setActiveUser(user);
  window.logAudit?.('Login', `${getActiveUser().name} signed in`);
  pinCancel();
  updateLoggedInDisplay();
  window.goTo?.('screen-desk');
  window.refreshWelcomeBanner?.();
  setTimeout(() => maybePromptManagerSetup(), 500);   // brand-new salon → prompt for a real manager PIN
  window.showDashPanel?.('turns');
  showToast(`Welcome, ${getActiveUser().name}`);
  // Cash-drawer reminder: non-Admin staff are prompted to open a drawer when none is open
  // (taking cash is blocked until they do — see features/cashdrawer.js). Admin is exempt.
  const cu = getActiveUser();
  if (cu && cu.role !== 'admin' && !cfg().cash_drawer) {
    setTimeout(() => window.showWarnModal?.('Open a cash drawer?', 'No cash drawer is open yet. Open one to take cash payments and track the register.', () => window.openCashRegister?.(), 'Open drawer'), 800);
  }
}

// ── First-run manager PIN (brand-new salon) ───────────────────────────────────
// A freshly provisioned salon has an owner (email/password) but no front-desk users.
// The owner signs in with email/password ("Owner sign-in"); on that first admin sign-in
// we prompt them to set a real 4-digit manager PIN — which creates the front-desk
// 'Manager' user the front desk then signs in with. There is no 1234 fallback (the
// server never accepts it). The operator can also see/change this PIN from the console.
export function maybePromptManagerSetup() {
  const au = getActiveUser();
  if (!au || au.role !== 'admin' || au.kind === 'appadmin') return;   // owners/managers only; never the master app-admin
  if (!getState().rev) return;                                        // state not hydrated yet (rev bumps on first hydrate/change) → don't false-prompt an established salon before its fd_users load
  if ((cfg().fd_users || []).length > 0) return;                       // already has front-desk users → nothing to bootstrap
  const m = document.getElementById('manager-pin-modal'); if (!m) return;
  document.getElementById('manager-pin-error')?.classList.add('hidden');
  const inp = document.getElementById('manager-pin-input'); if (inp) inp.value = '';
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('manager-pin-input')?.focus(), 100);
}
export function dismissManagerPin() {
  const m = document.getElementById('manager-pin-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; }
}
export function saveManagerPin() {
  const inp = document.getElementById('manager-pin-input');
  const err = document.getElementById('manager-pin-error');
  const pin = (inp?.value || '').trim();
  if (!/^\d{4,8}$/.test(pin)) { if (err) { err.textContent = 'Enter a 4-digit PIN (numbers only).'; err.classList.remove('hidden'); } return; }
  // Merge, don't clobber: update the manager if one exists, else prepend it — never
  // drop any front-desk users a concurrent edit may have added.
  const cur = cfg().fd_users || [];
  const next = cur.some(u => u.id === 'fd-manager')
    ? cur.map(u => u.id === 'fd-manager' ? { ...u, pin, role: u.role || 'admin' } : u)
    : [{ id: 'fd-manager', name: 'Manager', pin, role: 'admin' }, ...cur];
  dispatch('config.set', { key: 'fd_users', value: next });
  dismissManagerPin();
  showToast('Manager PIN set. Sign in with it at the front desk — add more staff in Settings.');
  window.logAudit?.('Manager PIN set', 'Front-desk manager PIN configured');
}

function _showPinError() {
  _setPinStatus();   // back to "Enter your PIN" — the error line below carries the detail
  document.getElementById('pin-error')?.classList.remove('hidden');
  pinBuffer = '';
  const kb = document.getElementById('pin-keyboard-input'); if (kb) kb.value = '';
  updatePinDots();
  const matchedEl = document.getElementById('pin-matched-user'); if (matchedEl) matchedEl.textContent = '';
  setTimeout(() => document.getElementById('pin-error')?.classList.add('hidden'), 2000);
}

// ── Owner / manager sign-in (email + password) — toggles within the PIN modal ──
// The salon slug is already fixed by the per-salon link; serverLogin() scopes the
// request to it. Owners get full ('admin') access; the credential is verified
// server-side against this salon's DO only. (TurnDesk-specific — re-applied after
// the Muse v5.36–v5.38 resync overlaid this file.)
export function showOwnerLogin() {
  document.getElementById('pin-entry-view')?.classList.add('hidden');
  document.getElementById('owner-login-view')?.classList.remove('hidden');
  document.getElementById('owner-error')?.classList.add('hidden');
  setTimeout(() => document.getElementById('owner-email')?.focus(), 50);
}

export function showPinEntry() {
  document.getElementById('owner-login-view')?.classList.add('hidden');
  document.getElementById('pin-entry-view')?.classList.remove('hidden');
  const e = document.getElementById('owner-email'); if (e) e.value = '';
  const p = document.getElementById('owner-password'); if (p) p.value = '';
  document.getElementById('owner-error')?.classList.add('hidden');
  _setPinStatus();   // clear any stale "Signing in…"/error status from a previous attempt
}

let _ownerLoginBusy = false;
export async function ownerLogin() {
  if (_ownerLoginBusy) return;
  const email = (document.getElementById('owner-email')?.value || '').trim();
  const password = document.getElementById('owner-password')?.value || '';
  const errEl = document.getElementById('owner-error');
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
  if (!email || !password) { showErr('Enter your email and password.'); return; }
  _ownerLoginBusy = true;
  try {
    const res = await serverLogin({ email, password, device: 'dashboard' });
    if (res.ok) { _finishPinLogin(res.user); resync(); return; }
    showErr(
      res.error === 'slow_down' ? throttleWaitMsg(res.retryInSec) :
      res.error === 'offline'   ? 'Offline — check your connection.' :
      res.error === 'no_salon'  ? 'No salon selected.' :
                                  'Incorrect email or password.'
    );
    const p = document.getElementById('owner-password'); if (p) p.value = '';
  } finally { _ownerLoginBusy = false; }
}

// ── Business sign-in screen (owner/manager email + password — the dedicated front door) ──
// Same server credential as ownerLogin(), but from the full-screen sign-in (screen-signin)
// that non-kiosk devices land on, instead of the keypad-modal toggle.
//
// Two paths, chosen by whether the LINK (?salon=) names a salon — urlSalonSlug(), NOT
// salonSlug(): on the bare front door a stale cached td_salon must NOT hijack the flow
// into that salon's per-salon login. The screen matches (renderSigninScreen keys off the
// same urlSalonSlug()), so the visible "find your salon" form always finds the salon.
//  - salon link (?salon=) → the per-salon serverLogin() (email scoped to THIS salon's DO).
//  - bare link (no ?salon=, "Find your salon") → serverFindLogin() asks the registry which
//    salon this email/password belongs to, then reloads scoped to it (?salon=<slug>) — the
//    simplest robust way to re-point the sync layer, which was on no chosen salon before.
let _bizLoginBusy = false;
export async function businessSignin() {
  if (_bizLoginBusy) return;
  const email = (document.getElementById('signin-email')?.value || '').trim();
  const password = document.getElementById('signin-password')?.value || '';
  const errEl = document.getElementById('signin-error');
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
  if (errEl) errEl.classList.add('hidden');
  if (!email || !password) { showErr('Enter your email and password.'); return; }
  _bizLoginBusy = true;
  try {
    if (!urlSalonSlug()) {
      const res = await serverFindLogin({ email, password });
      if (res.ok) { location.href = location.pathname + '?salon=' + encodeURIComponent(res.slug); return; }
      showErr(
        res.error === 'slow_down' ? throttleWaitMsg(res.retryInSec) :
        res.error === 'disabled'  ? 'This salon isn’t active right now — please contact support.' :
        res.error === 'offline'   ? 'Offline — check your connection.' :
                                    'Incorrect email or password.'
      );
      const p = document.getElementById('signin-password'); if (p) p.value = '';
      return;
    }
    const res = await serverLogin({ email, password, device: 'dashboard' });
    if (res.ok) { _finishPinLogin(res.user); resync(); return; }
    showErr(
      res.error === 'slow_down' ? throttleWaitMsg(res.retryInSec) :
      res.error === 'offline'   ? 'Offline — check your connection.' :
      res.error === 'no_salon'  ? 'No salon selected.' :
                                  'Incorrect email or password.'
    );
    const p = document.getElementById('signin-password'); if (p) p.value = '';
  } finally { _bizLoginBusy = false; }
}

// ── Device mode: front-desk kiosk vs business sign-in (per-device, NEVER synced) ──
// One TurnDesk salon link serves two contexts: the owner's own laptop/phone → the
// business sign-in, and the in-salon iPad customers walk up to → the check-in kiosk.
// A device flagged as the kiosk opens to the customer welcome (with the staff lock);
// every other device opens to the business sign-in. Device-local, like the session.
const KIOSK_KEY = 'turndesk_kiosk_device';
export function isKioskDevice() { try { return localStorage.getItem(KIOSK_KEY) === '1'; } catch { return false; } }
function setKioskFlag(on) { try { on ? localStorage.setItem(KIOSK_KEY, '1') : localStorage.removeItem(KIOSK_KEY); } catch {} }

// From the sign-in screen (signed out): turn this device into the kiosk and go there now.
export function makeThisDeviceKiosk() {
  setKioskFlag(true);
  showToast('This device is now the front-desk kiosk');
  window.goTo?.('screen-welcome');
}
// From Settings (usually signed in): flip the mode; it takes effect on the next sign-out/reload.
export function toggleKioskDevice() {
  const on = !isKioskDevice();
  setKioskFlag(on);
  showToast(on ? 'Kiosk mode on — this device will open to customer check-in'
               : 'Kiosk mode off — this device opens to the business sign-in');
  window.renderAppInfo?.();
}

// The signed-out landing for THIS device. Called on boot and after logout. A live
// session (activeUser) is left untouched so a reload mid-shift doesn't bounce anyone out.
export function routeSignedOut() {
  if (getActiveUser()) return;
  if (isKioskDevice()) { window.goTo?.('screen-welcome'); return; }
  window.goTo?.('screen-signin');
  renderSigninScreen({ openPin: true });
}

// ── Adaptive sign-in screen ────────────────────────────────────────────────────
// screen-signin adapts to the LINK THIS DEVICE OPENED — decided by the URL's ?salon=
// ONLY (urlSalonSlug), never the cached td_salon, so the bare public link (…/turndesk/)
// is always the "find your salon" front door even on a device that once visited a salon:
//  - salon link (?salon=<slug>) → PIN-first: lead with the PIN pad (opens #pin-modal).
//  - bare link (no ?salon=)     → email-first welcome: TurnDesk mark + "Welcome to
//    TurnDesk", no PIN pad at all (a PIN is meaningless — and unsafe against a stale
//    cached salon — without a chosen salon). businessSignin() runs the cross-salon lookup.
// Called on every route-to-signed-out (boot, logout) AND again whenever config syncs in.
export function renderSigninScreen({ openPin = false } = {}) {
  const pinFirst = !!urlSalonSlug();
  document.getElementById('signin-pin-mode')?.classList.toggle('hidden', !pinFirst);
  document.getElementById('signin-email-mode')?.classList.toggle('hidden', pinFirst);
  document.getElementById('signin-kiosk-btn')?.classList.toggle('hidden', !pinFirst);
  document.getElementById('signin-brand')?.classList.toggle('hidden', pinFirst);   // TurnDesk welcome mark only on the bare front door
  document.getElementById('screen-signin')?.classList.toggle('landing-active', !pinFirst);   // marketing landing wraps the bare front door only (CSS reveals #landing)
  const bizName = ((cfg().business || {}).name || '').trim();
  const heading = document.getElementById('signin-heading');
  const sub     = document.getElementById('signin-subheading');
  if (heading) heading.textContent = pinFirst ? (bizName || 'Sign in to your business') : 'Welcome to TurnDesk';
  if (sub)     sub.textContent     = pinFirst ? 'Manage your salon — sales, staff, and reports' : 'Sign in to open your salon';
  if (openPin && pinFirst) showPinModal();
}

// Status line shown under "Staff Access" (the #pin-subtitle paragraph) — every PIN
// attempt resolves to a visible state (Enter your PIN → Signing in… → success/error),
// never a silent dead end.
function _setPinStatus(msg) {
  const el = document.getElementById('pin-subtitle');
  if (el) el.textContent = msg || 'Enter your PIN';
}

// §13 server login: the server checks the PIN, returns who it is, and mints the
// session. Used both for a FRESH browser (no synced fd_users yet, so the local list
// can't answer at all) AND for a complete PIN that matches nobody in a non-empty
// local list (a stale/never-synced device, or a PIN added on another device that
// hasn't landed here yet) — either way we never just sit there doing nothing.
// Debounced by the caller so a multi-digit PIN doesn't fire half-typed attempts
// (each miss feeds the server's slow-down counter).
let _srvLoginTimer = null, _srvLoginBusy = false;
async function _serverPinLogin(pin) {
  if (_srvLoginBusy || pin.length < 4) return;
  _srvLoginBusy = true;
  _setPinStatus('Signing in…');
  const res = await serverLogin({ pin, device: 'dashboard' });
  _srvLoginBusy = false;
  if (pin !== pinBuffer) return;                       // kept typing — attempt is stale
  if (res.ok) {
    resync();                                          // reconnect with the new session → snapshot
    _finishPinLogin(res.user);
    return;
  }
  // Every outcome below resolves to a visible status — no silent dead end regardless
  // of how many digits were entered.
  if (res.error === 'slow_down' || res.retryInSec) {
    showToast(throttleWaitMsg(res.retryInSec));
    _showPinError();
  } else if (res.error === 'offline') {
    _setPinStatus('No connection — check your internet and try again.');
    showToast('No connection — this browser needs internet for its first sign-in.');
  } else {
    _showPinError();   // bad_pin (or anything unrecognized): a definitive "incorrect"
  }
}

function checkPin() {
  const fd = cfg().fd_users || [];
  // No 1234 fallback: a brand-new salon has no front-desk PIN. The owner signs in with
  // "Owner sign-in" (email/password) and sets a manager PIN at first run; the front desk
  // then uses that PIN. The server likewise never accepts 1234 (see authLogin).
  const matched = fd.find(u => u.pin === pinBuffer);
  const matchedEl = document.getElementById('pin-matched-user');
  matchedEl.textContent = (matched && pinBuffer.length >= 4) ? `Welcome, ${matched.name}` : '';

  if (pinBuffer.length < 4) { _setPinStatus(); return; }
  const user = fd.find(u => u.pin === pinBuffer);

  if (user) {
    const pin = pinBuffer;
    _setPinStatus('Signing in…');
    setTimeout(() => {
      _finishPinLogin(user);
      // Background §13 session mint/refresh — the server reads the same PIN list,
      // so this normally just succeeds silently; resync makes the WS pick it up.
      // But if the server WON'T issue a session for this code (a PIN that isn't a
      // registered front-desk user), the device unlocks locally yet can never sync —
      // so say that plainly instead of silently going offline.
      serverLogin({ pin, userId: user.id, device: 'dashboard' }).then(r => {
        if (r.ok) { resync(); return; }
        // Only warn if the device GENUINELY can't sync: with enforcement off, a code the
        // server rejects still syncs tokenless, so don't cry wolf. Give the WS/snapshot a
        // moment to settle, then check the real connection state.
        if (r.error === 'bad_pin') setTimeout(() => {
          const st = getState();
          if (!st.connected || st.authNeeded) showToast('You’re in, but this code can’t sync. Sign in with your front-desk PIN to connect.');
        }, 3000);
      });
    }, 300);
    return;
  }

  // No local match on a complete PIN — NEVER a dead end (this used to silently do
  // nothing here when fd.length > 0 and the buffer hadn't yet reached 6 digits).
  // Always ask the server, whether the local list is empty or just doesn't have
  // this PIN. Debounced so we don't fire on every half-typed digit.
  clearTimeout(_srvLoginTimer);
  _setPinStatus('Signing in…');
  _srvLoginTimer = setTimeout(() => _serverPinLogin(pinBuffer), 650);
}

function updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((dot, i) => {
    dot.classList.toggle('bg-primary', i < pinBuffer.length);
    dot.classList.toggle('bg-surface-container-highest', i >= pinBuffer.length);
    dot.classList.toggle('scale-110', i === pinBuffer.length - 1);
  });
}

// ── Admin-code gate (for destructive actions) ─────
// A code is "admin" if it belongs to an fd_user with role 'admin'. (There is no 1234
// fallback: on a brand-new salon the owner sets a manager PIN at first run, and that
// admin PIN is what authorizes destructive actions.)
let _adminCodeOnSuccess = null;
function isAdminCode(code) {
  if (!code) return false;
  const fd = cfg().fd_users || [];
  return fd.some(u => u.pin === code && u.role === 'admin');
}
export function requireAdminCode(onSuccess, msg) {
  _adminCodeOnSuccess = onSuccess;
  const m = document.getElementById('admin-code-modal');
  if (!m) { showToast('Admin verification unavailable — action blocked.'); return; }   // fail CLOSED: never run a gated action without the gate
  const input = document.getElementById('admin-code-input'); if (input) input.value = '';
  document.getElementById('admin-code-err')?.classList.add('hidden');
  if (msg) { const el = document.getElementById('admin-code-msg'); if (el) el.textContent = msg; }
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('admin-code-input')?.focus(), 100);
}
export function closeAdminCode() {
  const m = document.getElementById('admin-code-modal');
  if (m) { m.classList.add('hidden'); m.style.display = ''; }
  _adminCodeOnSuccess = null;
}
export function submitAdminCode() {
  const code = (document.getElementById('admin-code-input')?.value || '').trim();
  if (!isAdminCode(code)) { document.getElementById('admin-code-err')?.classList.remove('hidden'); return; }
  const cb = _adminCodeOnSuccess; _adminCodeOnSuccess = null;
  closeAdminCode();
  cb?.();
}

// ── Front desk users CRUD (synced config.fd_users) ────────────────────────────
function setFdUsers(users) { dispatch('config.set', { key: 'fd_users', value: users }); }

// Reveal PINs inline next to each staff name (in the list), not in a separate
// section. Persists until toggled off or the page reloads.
let _fdPinsVisible = false;
export function togglePinViewer() {
  if (!isAdmin()) { showToast('Only an admin can view login PINs.'); return; }
  _fdPinsVisible = !_fdPinsVisible;
  renderFdUsersList();
}

export function renderFdUsersList() {
  const list = document.getElementById('fdusers-list');
  if (!list) return;
  const au = getActiveUser();
  const isAdminUser = au?.role === 'admin';
  const pinSection = document.getElementById('pin-viewer-section');
  if (pinSection) pinSection.classList.toggle('hidden', !['admin','manager'].includes(au?.role));
  const pinList = document.getElementById('pin-viewer-list');   // legacy separate section — now unused
  const pinLabel = document.getElementById('pin-viewer-label');
  if (pinList) { pinList.classList.add('hidden'); pinList.innerHTML = ''; }
  if (!isAdminUser) _fdPinsVisible = false;   // only an admin may reveal PINs
  if (pinLabel) pinLabel.textContent = _fdPinsVisible ? 'Hide PINs' : 'View Login PINs';

  const fd = cfg().fd_users;
  if (fd.length === 0) {
    list.innerHTML = '<p class="text-sm font-body text-on-surface-variant py-4 text-center">No front desk users yet. Add one above.</p>';
    return;
  }
  list.innerHTML = fd.map(u => {
    const photoHtml = u.photo
      ? `<img src="${escHtml(u.photo)}" class="w-10 h-10 rounded-full object-cover border-2 border-surface-container-high">`
      : `<div class="w-10 h-10 rounded-full bg-primary flex items-center justify-center"><span class="text-sm font-headline font-bold text-on-primary">${escHtml(u.name.charAt(0).toUpperCase())}</span></div>`;
    return `
      <div onclick="showEditFdUser('${u.id}')" title="Edit ${escHtml(u.name)}" class="bg-surface-container-lowest rounded-xl px-5 py-4 border border-surface-container-high flex items-center justify-between cursor-pointer hover:bg-surface-container transition-colors">
        <div class="flex items-center gap-4">
          ${photoHtml}
          <div>
            <div class="font-headline font-semibold text-on-surface text-base">${escHtml(u.name)}</div>
            <div class="text-xs font-body text-on-surface-variant capitalize">${escHtml(u.role)} · PIN: <span class="${_fdPinsVisible ? 'font-headline font-bold text-primary tracking-widest' : ''}">${_fdPinsVisible ? escHtml(u.pin) : '•'.repeat(u.pin.length)}</span></div>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="event.stopPropagation();showPhotoUpload('fduser','${u.id}')" title="Photo" class="w-9 h-9 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors">
            <span class="material-symbols-outlined" style="font-size:18px">photo_camera</span>
          </button>
          <button onclick="event.stopPropagation();deleteFdUser('${u.id}')" title="Delete" class="w-9 h-9 rounded-full hover:bg-error/10 flex items-center justify-center text-on-surface-variant hover:text-error transition-colors">
            <span class="material-symbols-outlined" style="font-size:18px">delete</span>
          </button>
        </div>
      </div>`;
  }).join('');
}

export function selectRole(role) {
  document.getElementById('fduser-role-input').value = role;
  ['admin','manager','frontdesk','reviewer'].forEach(r => {
    const btn = document.getElementById(`role-btn-${r}`);
    if (!btn) return;
    if (r === role) { btn.classList.add('bg-primary','text-on-primary','border-primary'); btn.classList.remove('bg-transparent','border-outline-variant','text-on-surface'); }
    else { btn.classList.remove('bg-primary','text-on-primary','border-primary'); btn.classList.add('bg-transparent','border-outline-variant','text-on-surface'); }
  });
}

export function showAddFdUser() {
  if (!isAdmin()) { showToast('Only an admin can manage users.'); return; }
  document.getElementById('fduser-modal-title').textContent = 'Add Front Desk User';
  document.getElementById('fduser-name-input').value = '';
  document.getElementById('fduser-pin-input').value = '';
  const rateEl = document.getElementById('fduser-rate-input'); if (rateEl) rateEl.value = '';
  document.getElementById('fduser-edit-id').value = '';
  selectRole('frontdesk');
  const m = document.getElementById('fduser-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('fduser-name-input').focus(), 100);
}

export function showEditFdUser(id) {
  if (!isAdmin()) { showToast('Only an admin can manage users.'); return; }
  const u = cfg().fd_users.find(x => x.id === id);
  if (!u) return;
  document.getElementById('fduser-modal-title').textContent = 'Edit User';
  document.getElementById('fduser-name-input').value = u.name;
  document.getElementById('fduser-pin-input').value = u.pin;
  const rateEl = document.getElementById('fduser-rate-input'); if (rateEl) rateEl.value = u.hourlyRate != null ? u.hourlyRate : '';
  document.getElementById('fduser-edit-id').value = id;
  selectRole(u.role);
  const m = document.getElementById('fduser-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}

export function closeFdUserModal() {
  const m = document.getElementById('fduser-modal');
  m.classList.add('hidden'); m.style.display = '';
}

export function saveFdUser() {
  if (!isAdmin()) { showToast('Only an admin can manage users.'); return; }
  const name = document.getElementById('fduser-name-input').value.trim();
  const pin  = document.getElementById('fduser-pin-input').value.trim();
  const role = document.getElementById('fduser-role-input').value;
  const editId = document.getElementById('fduser-edit-id').value;
  if (!name) { showToast('Please enter a name.'); return; }
  if (!pin || pin.length < 4) { showToast('PIN must be at least 4 digits.'); return; }
  if (!/^\d+$/.test(pin)) { showToast('PIN must be numbers only.'); return; }
  const hourlyRate = Math.max(0, parseFloat(document.getElementById('fduser-rate-input')?.value) || 0);
  const fd = cfg().fd_users;
  const dup = fd.find(u => u.pin === pin && u.id !== editId);
  if (dup) { showToast(`PIN already used by ${dup.name}.`); return; }
  // PINs are sign-in identity across BOTH lists now (§13 server login scans
  // front desk first, then technicians) — a cross-list duplicate would shadow
  // the tech's login entirely.
  const techDup = (cfg().staff || []).find(s => s.pin && String(s.pin) === pin);
  if (techDup) { showToast(`PIN already used by technician ${techDup.name}.`); return; }

  let next;
  if (editId) next = fd.map(u => u.id === editId ? { ...u, name, pin, role, hourlyRate } : u);
  else        next = [...fd, { id: `fd-${Date.now()}`, name, pin, role, hourlyRate }];
  setFdUsers(next);
  closeFdUserModal();
  renderFdUsersList();
  showToast(editId ? 'User updated' : `${name} added`);
}

export function deleteFdUser(id) {
  if (!isAdmin()) { showToast('Only an admin can manage users.'); return; }
  const u = cfg().fd_users.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`Remove ${u.name} from front desk users?`)) return;
  setFdUsers(cfg().fd_users.filter(x => x.id !== id));
  renderFdUsersList();
  showToast(`${u.name} removed`);
}

// ── User account menu (top-right bubble → clock in/out + log out) ─────────────
export function toggleUserMenu() {
  const m = document.getElementById('user-menu');
  if (!m) return;
  m.classList.toggle('hidden');
}
export function closeUserMenu() {
  document.getElementById('user-menu')?.classList.add('hidden');
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('user-menu');
  if (!m || m.classList.contains('hidden')) return;
  if (!document.getElementById('logged-in-user-btn')?.contains(e.target) && !m.contains(e.target)) {
    m.classList.add('hidden');
  }
});
