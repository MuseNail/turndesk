// ── Auth: PIN login + front-desk users ──────────────────────────────────────
// activeUser lives in session.js (per-device). Front-desk users are synced config.

import { getState } from '../store.js';
import { dispatch, resync } from '../sync.js';
import { showToast, escHtml } from '../utils.js';
import { getActiveUser, setActiveUser } from '../session.js';
import { STAFF_PIN } from '../config.js';
import { serverLogin } from '../apptoken.js';

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
export function showPinModal() {
  pinBuffer = '';
  setActiveUser(null);
  window.applyUserTheme?.();   // revert to the default palette on the login screen
  updatePinDots();
  document.getElementById('pin-error').classList.add('hidden');
  document.getElementById('pin-matched-user').textContent = '';
  const m = document.getElementById('pin-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => { const kb = document.getElementById('pin-keyboard-input'); if (kb) { kb.value = ''; kb.focus(); } }, 100);
}

// Log out the current front-desk user: confirm, clear the session, return to the welcome
// screen, then prompt for a PIN. (showPinModal also clears activeUser + opens the keypad.)
export function logout() {
  const doLogout = () => { setActiveUser(null); window.goTo?.('screen-welcome'); showPinModal(); };
  if (window.showWarnModal) window.showWarnModal('Log out?', 'You will need to re-enter your PIN.', doLogout);
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
  window.showDashPanel?.('turns');
  showToast(`Welcome, ${getActiveUser().name}`);
  // Cash-drawer reminder: non-Admin staff are prompted to open a drawer when none is open
  // (taking cash is blocked until they do — see features/cashdrawer.js). Admin is exempt.
  const cu = getActiveUser();
  if (cu && cu.role !== 'admin' && !cfg().cash_drawer) {
    setTimeout(() => window.showWarnModal?.('Open a cash drawer?', 'No cash drawer is open yet. Open one to take cash payments and track the register.', () => window.openCashRegister?.(), 'Open drawer'), 800);
  }
}

function _showPinError() {
  document.getElementById('pin-error')?.classList.remove('hidden');
  pinBuffer = '';
  const kb = document.getElementById('pin-keyboard-input'); if (kb) kb.value = '';
  updatePinDots();
  const matchedEl = document.getElementById('pin-matched-user'); if (matchedEl) matchedEl.textContent = '';
  setTimeout(() => document.getElementById('pin-error')?.classList.add('hidden'), 2000);
}

// §13 server login on a FRESH browser (no synced data yet, so the local list
// can't answer): the server checks the PIN, returns who it is, and mints the
// session. Debounced so a 6-digit PIN doesn't fire half-typed attempts (each
// miss feeds the server's slow-down counter).
let _srvLoginTimer = null, _srvLoginBusy = false;
async function _serverPinLogin(pin) {
  if (_srvLoginBusy || pin.length < 4) return;
  _srvLoginBusy = true;
  const res = await serverLogin({ pin, device: 'dashboard' });
  _srvLoginBusy = false;
  if (pin !== pinBuffer) return;                       // kept typing — attempt is stale
  if (res.ok) {
    resync();                                          // reconnect with the new session → snapshot
    _finishPinLogin(res.user);
    return;
  }
  if (res.error === 'slow_down' || res.retryInSec) {
    showToast(`Too many tries — wait ${res.retryInSec || 5}s and try again.`);
    _showPinError();
  } else if (res.error === 'offline') {
    showToast('No connection — this browser needs internet for its first sign-in.');
  } else if (pin.length >= 6) {
    _showPinError();
  }
}

function checkPin() {
  const fd = cfg().fd_users;
  const matched = fd.find(u => u.pin === pinBuffer) || (pinBuffer === STAFF_PIN ? { name: 'Manager', role: 'admin' } : null);
  const matchedEl = document.getElementById('pin-matched-user');
  matchedEl.textContent = (matched && pinBuffer.length >= 4) ? `Welcome, ${matched.name}` : '';

  if (pinBuffer.length < 4) return;
  const user = fd.find(u => u.pin === pinBuffer);
  const isFallback = pinBuffer === STAFF_PIN;

  if (user || isFallback) {
    const pin = pinBuffer;
    setTimeout(() => {
      _finishPinLogin(user || { id: 'fallback', name: 'Manager', pin: STAFF_PIN, role: 'admin' });
      // Background §13 session mint/refresh — the server reads the same PIN list,
      // so this normally just succeeds silently; resync makes the WS pick it up.
      serverLogin({ pin, userId: user?.id, device: 'dashboard' }).then(r => { if (r.ok) resync(); });
    }, 300);
  } else if (!fd.length) {
    // Fresh browser: nothing synced yet — the server owns the PIN check (§13).
    clearTimeout(_srvLoginTimer);
    _srvLoginTimer = setTimeout(() => _serverPinLogin(pinBuffer), 650);
  } else if (pinBuffer.length >= 6) {
    _showPinError();
  }
}

function updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((dot, i) => {
    dot.classList.toggle('bg-primary', i < pinBuffer.length);
    dot.classList.toggle('bg-surface-container-highest', i >= pinBuffer.length);
    dot.classList.toggle('scale-110', i === pinBuffer.length - 1);
  });
}

// ── Admin-code gate (for destructive actions) ─────
// A code is "admin" if it's the default Manager PIN or an fd_user with role 'admin'.
let _adminCodeOnSuccess = null;
function isAdminCode(code) {
  if (!code) return false;
  if (code === STAFF_PIN) return true;
  return cfg().fd_users.some(u => u.pin === code && u.role === 'admin');
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
