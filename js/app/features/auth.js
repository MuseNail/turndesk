// ── Auth: PIN login + front-desk users ──────────────────────────────────────
// activeUser lives in session.js (per-device). Front-desk users are synced config.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast } from '../utils.js';
import { getActiveUser, setActiveUser } from '../session.js';
import { STAFF_PIN } from '../config.js';

const cfg = () => getState().config;
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

  if (photo) avatarEl.innerHTML = `<img src="${photo}" class="w-full h-full rounded-full object-cover">`;
  else { avatarEl.innerHTML = ''; avatarEl.textContent = name.charAt(0).toUpperCase(); }

  window.updateHistoricalButtonVisibility?.();
  window.updatePermissionGatedUI?.();
  window.applyUserTheme?.();   // load the logged-in user's per-login theme
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

function checkPin() {
  const fd = cfg().fd_users;
  const matched = fd.find(u => u.pin === pinBuffer) || (pinBuffer === STAFF_PIN ? { name: 'Manager', role: 'admin' } : null);
  const matchedEl = document.getElementById('pin-matched-user');
  matchedEl.textContent = (matched && pinBuffer.length >= 4) ? `Welcome, ${matched.name}` : '';

  if (pinBuffer.length < 4) return;
  const user = fd.find(u => u.pin === pinBuffer);
  const isFallback = pinBuffer === STAFF_PIN;

  if (user || isFallback) {
    setTimeout(() => {
      setActiveUser(user || { id: 'fallback', name: 'Manager', pin: STAFF_PIN, role: 'admin' });
      window.logAudit?.('Login', `${getActiveUser().name} signed in`);
      pinCancel();
      updateLoggedInDisplay();
      window.goTo?.('screen-desk');
      window.showDashPanel?.('turns');
      showToast(`Welcome, ${getActiveUser().name}`);
    }, 300);
  } else if (pinBuffer.length >= 6) {
    document.getElementById('pin-error').classList.remove('hidden');
    pinBuffer = '';
    document.getElementById('pin-keyboard-input').value = '';
    updatePinDots();
    matchedEl.textContent = '';
    setTimeout(() => document.getElementById('pin-error').classList.add('hidden'), 2000);
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
  if (!m) { onSuccess?.(); return; }   // modal missing → don't hard-block
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

export function togglePinViewer() {
  const list  = document.getElementById('pin-viewer-list');
  const label = document.getElementById('pin-viewer-label');
  if (!list) return;
  const isHidden = list.classList.contains('hidden');
  if (isHidden) {
    const users = [
      { name: 'Manager (default)', pin: STAFF_PIN, role: 'manager' },
      ...cfg().fd_users.map(u => ({ name: u.name, pin: u.pin, role: u.role })),
    ];
    list.innerHTML = users.map(u => `
      <div class="flex items-center justify-between px-4 py-3 border-b border-surface-container-high last:border-0">
        <div>
          <span class="font-body font-semibold text-on-surface text-sm">${u.name}</span>
          <span class="text-xs font-body text-on-surface-variant capitalize ml-2">${u.role}</span>
        </div>
        <span class="font-headline font-bold text-primary tracking-widest text-base">${u.pin}</span>
      </div>`).join('');
    label.textContent = 'Hide PINs';
  } else {
    list.innerHTML = '';
    label.textContent = 'View Login PINs';
  }
  list.classList.toggle('hidden', !isHidden);
}

export function renderFdUsersList() {
  const list = document.getElementById('fdusers-list');
  if (!list) return;
  const au = getActiveUser();
  const pinSection = document.getElementById('pin-viewer-section');
  if (pinSection) pinSection.classList.toggle('hidden', !['admin','manager'].includes(au?.role));
  const pinList = document.getElementById('pin-viewer-list');
  const pinLabel = document.getElementById('pin-viewer-label');
  if (pinList) { pinList.classList.add('hidden'); pinList.innerHTML = ''; }
  if (pinLabel) pinLabel.textContent = 'View Login PINs';

  const fd = cfg().fd_users;
  if (fd.length === 0) {
    list.innerHTML = '<p class="text-sm font-body text-on-surface-variant py-4 text-center">No front desk users yet. Add one above.</p>';
    return;
  }
  list.innerHTML = fd.map(u => {
    const photoHtml = u.photo
      ? `<img src="${u.photo}" class="w-10 h-10 rounded-full object-cover border-2 border-surface-container-high">`
      : `<div class="w-10 h-10 rounded-full bg-primary flex items-center justify-center"><span class="text-sm font-headline font-bold text-on-primary">${u.name.charAt(0).toUpperCase()}</span></div>`;
    return `
      <div class="bg-surface-container-lowest rounded-xl px-5 py-4 border border-surface-container-high flex items-center justify-between">
        <div class="flex items-center gap-4">
          ${photoHtml}
          <div>
            <div class="font-headline font-semibold text-on-surface text-base">${u.name}</div>
            <div class="text-xs font-body text-on-surface-variant capitalize">${u.role} · PIN: ${'•'.repeat(u.pin.length)}</div>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="showPhotoUpload('fduser','${u.id}')" title="Photo" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors">
            <span class="material-symbols-outlined" style="font-size:18px">photo_camera</span>
          </button>
          <button onclick="showEditFdUser('${u.id}')" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors">
            <span class="material-symbols-outlined" style="font-size:18px">edit</span>
          </button>
          <button onclick="deleteFdUser('${u.id}')" class="w-9 h-9 rounded-full hover:bg-error/10 flex items-center justify-center text-on-surface-variant hover:text-error transition-colors">
            <span class="material-symbols-outlined" style="font-size:18px">delete</span>
          </button>
        </div>
      </div>`;
  }).join('');
}

export function selectRole(role) {
  document.getElementById('fduser-role-input').value = role;
  ['admin','manager','frontdesk'].forEach(r => {
    const btn = document.getElementById(`role-btn-${r}`);
    if (!btn) return;
    if (r === role) { btn.classList.add('bg-primary','text-on-primary','border-primary'); btn.classList.remove('bg-transparent','border-outline-variant','text-on-surface'); }
    else { btn.classList.remove('bg-primary','text-on-primary','border-primary'); btn.classList.add('bg-transparent','border-outline-variant','text-on-surface'); }
  });
}

export function showAddFdUser() {
  document.getElementById('fduser-modal-title').textContent = 'Add Front Desk User';
  document.getElementById('fduser-name-input').value = '';
  document.getElementById('fduser-pin-input').value = '';
  document.getElementById('fduser-edit-id').value = '';
  selectRole('frontdesk');
  const m = document.getElementById('fduser-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('fduser-name-input').focus(), 100);
}

export function showEditFdUser(id) {
  const u = cfg().fd_users.find(x => x.id === id);
  if (!u) return;
  document.getElementById('fduser-modal-title').textContent = 'Edit User';
  document.getElementById('fduser-name-input').value = u.name;
  document.getElementById('fduser-pin-input').value = u.pin;
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
  const name = document.getElementById('fduser-name-input').value.trim();
  const pin  = document.getElementById('fduser-pin-input').value.trim();
  const role = document.getElementById('fduser-role-input').value;
  const editId = document.getElementById('fduser-edit-id').value;
  if (!name) { showToast('Please enter a name.'); return; }
  if (!pin || pin.length < 4) { showToast('PIN must be at least 4 digits.'); return; }
  if (!/^\d+$/.test(pin)) { showToast('PIN must be numbers only.'); return; }
  const fd = cfg().fd_users;
  const dup = fd.find(u => u.pin === pin && u.id !== editId);
  if (dup) { showToast(`PIN already used by ${dup.name}.`); return; }

  let next;
  if (editId) next = fd.map(u => u.id === editId ? { ...u, name, pin, role } : u);
  else        next = [...fd, { id: `fd-${Date.now()}`, name, pin, role }];
  setFdUsers(next);
  closeFdUserModal();
  renderFdUsersList();
  showToast(editId ? 'User updated' : `${name} added`);
}

export function deleteFdUser(id) {
  const u = cfg().fd_users.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`Remove ${u.name} from front desk users?`)) return;
  setFdUsers(cfg().fd_users.filter(x => x.id !== id));
  renderFdUsersList();
  showToast(`${u.name} removed`);
}
