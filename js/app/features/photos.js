// ── Photos & Logo (Cloudflare R2) ───────────────────────────────────────────
// Photo URLs are stored ON the member objects (config.staff[i].photo,
// config.fd_users[i].photo) and config.logo — all synced config. R2 holds the
// binary; the URL is the synced value. No separate photo dict, no globals.

import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast } from '../utils.js';
import { PHOTOS_PROXY, LOGO_PATH } from '../config.js';

const cfg = () => getState().config;

// ── R2 helpers ────────────────────────────────────
async function _uploadToR2(key, dataUrl, mimeType) {
  try {
    const [, b64] = dataUrl.split(',');
    const binary  = atob(b64);
    const bytes   = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const res = await fetch(`${PHOTOS_PROXY}/${key}`, { method: 'PUT', body: bytes, headers: { 'Content-Type': mimeType } });
    if (!res.ok) throw new Error(res.status);
    return (await res.json()).url || null;
  } catch (e) { console.warn('[Photos] Upload failed:', e); return null; }
}
async function _deleteFromR2(key) {
  try { await fetch(`${PHOTOS_PROXY}/${key}`, { method: 'DELETE' }); } catch (e) { console.warn('[Photos] Delete failed:', e); }
}

// ── Store helpers ─────────────────────────────────
function setStaffPhoto(id, url) {
  dispatch('config.set', { key: 'staff', value: cfg().staff.map(s => s.id === id ? (url ? { ...s, photo: url } : (({ photo, ...rest }) => rest)(s)) : s) });
}
function setFdUserPhoto(id, url) {
  dispatch('config.set', { key: 'fd_users', value: cfg().fd_users.map(u => u.id === id ? (url ? { ...u, photo: url } : (({ photo, ...rest }) => rest)(u)) : u) });
}
function photoUrlFor(type, id) {
  if (type === 'logo')   return cfg().logo || null;
  if (type === 'staff')  return cfg().staff.find(s => s.id === id)?.photo || null;
  if (type === 'fduser') return cfg().fd_users.find(u => u.id === id)?.photo || null;
  return null;
}

// ── Logo ──────────────────────────────────────────
export function setLogo() {
  const logoSrc = cfg().logo || LOGO_PATH;
  const bizName = ((cfg().business || {}).name || '').trim();
  ['logo-welcome','logo-checkin','logo-desk','logo-signin'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'logo-signin' && !logoSrc) { el.style.display = 'none'; return; }   // no logo → heading carries the sign-in screen
    if (!logoSrc) el.style.display = 'none';              // no logo → the business-name text fallback carries the header
    else { el.style.display = ''; el.src = logoSrc; }
    if (id === 'logo-welcome') { const t = document.getElementById('logo-text-welcome'); if (t) t.style.display = logoSrc ? 'none' : 'block'; }
    if (id === 'logo-checkin') { const t = document.getElementById('logo-text-checkin'); if (t) t.style.display = logoSrc ? 'none' : 'block'; }
  });
  // Per-salon branding: fill the name fallback (replaces the old hardcoded "MUSE") + tab title.
  document.querySelectorAll('[data-biz-name]').forEach(n => { n.textContent = bizName || 'Welcome'; });
  if (bizName) document.title = bizName;
  const preview   = document.getElementById('logo-settings-preview');
  const recropBtn = document.getElementById('logo-recrop-btn');
  if (preview) {
    if (cfg().logo) {
      preview.innerHTML = `<img src="${cfg().logo}" class="w-full h-full object-contain">`;
      if (recropBtn) recropBtn.classList.remove('hidden');
    } else {
      preview.innerHTML = `<img src="${LOGO_PATH}" class="w-full h-full object-contain" onerror="this.style.display='none'"><span class="material-symbols-outlined text-2xl text-on-surface-variant" id="logo-settings-placeholder">store</span>`;
      if (recropBtn) recropBtn.classList.add('hidden');
    }
  }
}

export function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  _photoCropTarget = { type: 'logo', id: 'business' };
  _resetCropState();
  const cropArea = document.querySelector('#photo-crop-modal .relative.mb-4');
  if (cropArea) cropArea.style.height = '200px';
  _openCropModal('Upload Logo', false);
  const reader = new FileReader();
  reader.onload = ev => _loadImageIntoCrop(ev.target.result);
  reader.readAsDataURL(file);
  input.value = '';
}

export function removeLogo() {
  _deleteFromR2('logo_business').catch(() => {});
  dispatch('config.set', { key: 'logo', value: null });
  setLogo();
  showToast('Logo removed');
}

export function recropLogo() {
  if (!cfg().logo) { showToast('No logo uploaded yet.'); return; }
  _photoCropTarget = { type: 'logo', id: 'business' };
  _resetCropState();
  const cropArea = document.querySelector('#photo-crop-modal .relative.mb-4');
  if (cropArea) cropArea.style.height = '200px';
  _openCropModal('Re-crop Logo', false);
  _loadImageIntoCrop(cfg().logo);
}

// ── Photo crop modal ──────────────────────────────
let _photoCropTarget = null, _photoCropImg = null, _photoCropRotation = 0, _photoCropZoom = 1, _photoCropOffset = { x: 0, y: 0 };

function _resetCropState() { _photoCropImg = null; _photoCropRotation = 0; _photoCropZoom = 1; _photoCropOffset = { x: 0, y: 0 }; }

function _openCropModal(title, showCanvas) {
  document.getElementById('photo-crop-zoom').value = 1;
  document.getElementById('photo-crop-canvas').classList.toggle('hidden', !showCanvas);
  document.getElementById('photo-crop-placeholder').classList.toggle('hidden', !!showCanvas);
  document.getElementById('photo-crop-controls').classList.toggle('hidden', !showCanvas);
  document.getElementById('photo-crop-save').disabled = !showCanvas;
  const h2 = document.querySelector('#photo-crop-modal h2');
  if (h2) h2.textContent = title;
  const m = document.getElementById('photo-crop-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}

function _loadImageIntoCrop(src) {
  const img = new Image();
  // Re-cropping an existing logo/photo loads it from the cross-origin R2/Worker URL. We
  // draw it to a canvas and call toDataURL on Save — which throws (SecurityError) if the
  // canvas is tainted by a non-CORS image. The Worker serves photos with
  // Access-Control-Allow-Origin:*, so request it as a CORS image; the cache-buster avoids
  // reusing a previously-cached non-CORS response for the same URL.
  const isRemote = /^https?:/i.test(src);
  if (isRemote) img.crossOrigin = 'anonymous';
  img.onload = () => {
    _photoCropImg = img; _photoCropZoom = 1; _photoCropOffset = { x: 0, y: 0 };
    document.getElementById('photo-crop-zoom').value = 1;
    document.getElementById('photo-crop-canvas').classList.remove('hidden');
    document.getElementById('photo-crop-placeholder').classList.add('hidden');
    document.getElementById('photo-crop-controls').classList.remove('hidden');
    document.getElementById('photo-crop-save').disabled = false;
    requestAnimationFrame(() => { updatePhotoCrop(); attachCropDrag(); });
  };
  img.onerror = () => showToast('Could not load that image to edit.');
  img.src = isRemote ? src + (src.includes('?') ? '&' : '?') + 'cb=' + Date.now() : src;
}

export function showPhotoUpload(type, id) {
  _photoCropTarget = { type, id };
  _resetCropState();
  document.getElementById('photo-crop-input').value = '';
  _openCropModal('Upload Photo', false);
  const existing = photoUrlFor(type, id);
  if (existing) _loadImageIntoCrop(existing);
}

export function closePhotoCrop() {
  const m = document.getElementById('photo-crop-modal');
  m.classList.add('hidden'); m.style.display = '';
  const cropArea = document.querySelector('#photo-crop-modal .relative.mb-4');
  if (cropArea) cropArea.style.height = '240px';
  const h2 = document.querySelector('#photo-crop-modal h2');
  if (h2) h2.textContent = 'Upload Photo';
  _photoCropTarget = null; _photoCropImg = null;
}

export function loadPhotoCrop(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => _loadImageIntoCrop(ev.target.result);
  reader.readAsDataURL(file);
}

export function updatePhotoCrop() {
  const canvas = document.getElementById('photo-crop-canvas');
  if (!canvas || !_photoCropImg) return;
  _photoCropZoom = parseFloat(document.getElementById('photo-crop-zoom').value) || 1;
  const isLogo = _photoCropTarget?.type === 'logo';
  const ctx = canvas.getContext('2d');
  if (isLogo) {
    const W = 600, H = 300; canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H); ctx.save();
    ctx.translate(W/2 + _photoCropOffset.x, H/2 + _photoCropOffset.y);
    ctx.rotate((_photoCropRotation * Math.PI) / 180); ctx.scale(_photoCropZoom, _photoCropZoom);
    const aspect = _photoCropImg.width / _photoCropImg.height;
    let dw, dh; if (aspect >= W/H) { dh = H; dw = H * aspect; } else { dw = W; dh = W / aspect; }
    ctx.drawImage(_photoCropImg, -dw/2, -dh/2, dw, dh); ctx.restore();
  } else {
    const SIZE = 300; canvas.width = canvas.height = SIZE;
    ctx.clearRect(0, 0, SIZE, SIZE); ctx.save();
    ctx.beginPath(); ctx.arc(SIZE/2, SIZE/2, SIZE/2, 0, Math.PI*2); ctx.clip();
    ctx.translate(SIZE/2 + _photoCropOffset.x, SIZE/2 + _photoCropOffset.y);
    ctx.rotate((_photoCropRotation * Math.PI) / 180); ctx.scale(_photoCropZoom, _photoCropZoom);
    const aspect = _photoCropImg.width / _photoCropImg.height;
    let dw, dh; if (aspect >= 1) { dh = SIZE; dw = SIZE * aspect; } else { dw = SIZE; dh = SIZE / aspect; }
    ctx.drawImage(_photoCropImg, -dw/2, -dh/2, dw, dh); ctx.restore();
  }
}

export function rotateCrop(deg) { _photoCropRotation = (_photoCropRotation + deg + 360) % 360; updatePhotoCrop(); }

export function attachCropDrag() {
  const canvas = document.getElementById('photo-crop-canvas');
  if (!canvas) return;
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);
  newCanvas.id = 'photo-crop-canvas';
  let dragStart = null;
  newCanvas.addEventListener('pointerdown', e => { dragStart = { x: e.clientX, y: e.clientY, ox: _photoCropOffset.x, oy: _photoCropOffset.y }; newCanvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  newCanvas.addEventListener('pointermove', e => { if (!dragStart) return; _photoCropOffset.x = dragStart.ox + (e.clientX - dragStart.x); _photoCropOffset.y = dragStart.oy + (e.clientY - dragStart.y); updatePhotoCrop(); });
  newCanvas.addEventListener('pointerup',     () => { dragStart = null; });
  newCanvas.addEventListener('pointercancel', () => { dragStart = null; });
}

export async function savePhotoCrop() {
  const canvas = document.getElementById('photo-crop-canvas');
  if (!canvas || !_photoCropTarget) return;
  const { type, id } = _photoCropTarget;

  if (type === 'logo') {
    const dataUrl = canvas.toDataURL('image/png');
    closePhotoCrop();
    showToast('Uploading logo…');
    const url = await _uploadToR2('logo_business', dataUrl, 'image/png');
    if (!url) { showToast('Logo upload failed — check connection'); return; }
    dispatch('config.set', { key: 'logo', value: url });
    setLogo();
    showToast('Logo saved ✓');
    return;
  }

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  closePhotoCrop();
  showToast('Uploading photo…');
  const url = await _uploadToR2(`${type}_${id}`, dataUrl, 'image/jpeg');
  if (!url) { showToast('Photo upload failed — check connection'); return; }

  if (type === 'staff') {
    setStaffPhoto(id, url);
    window.renderStaffList?.(); window.renderSchedule?.(); window.renderTurns?.(); window.updateLoggedInDisplay?.();
  } else if (type === 'fduser') {
    setFdUserPhoto(id, url);
    window.renderFdUsersList?.(); window.updateLoggedInDisplay?.();
  }
  showToast('Photo saved ✓');
}

export function clearPhotoCrop() {
  if (!_photoCropTarget) return;
  const { type, id } = _photoCropTarget;
  closePhotoCrop();
  _deleteFromR2(`${type}_${id}`).catch(() => {});
  if (type === 'staff') { setStaffPhoto(id, null); window.renderStaffList?.(); window.renderTurns?.(); window.updateLoggedInDisplay?.(); }
  else if (type === 'fduser') { setFdUserPhoto(id, null); window.renderFdUsersList?.(); window.updateLoggedInDisplay?.(); }
  showToast('Photo removed');
}

// ── Legacy staff-photo modal (routes into the crop modal) ───────────────────────
export function showStaffPhotoModal(staffId) {
  const st = cfg().staff.find(s => s.id === staffId);
  if (!st) return;
  document.getElementById('staff-photo-target-id').value = staffId;
  document.getElementById('staff-photo-initial').textContent = st.name.charAt(0).toUpperCase();
  const preview   = document.getElementById('staff-photo-preview');
  const recropBtn = document.getElementById('staff-recrop-btn');
  if (st.photo) {
    preview.innerHTML = `<img src="${st.photo}" class="w-full h-full object-cover rounded-full">`;
    if (recropBtn) recropBtn.classList.remove('hidden');
  } else {
    preview.innerHTML = `<span class="text-3xl font-headline font-bold text-on-surface-variant">${st.name.charAt(0).toUpperCase()}</span>`;
    if (recropBtn) recropBtn.classList.add('hidden');
  }
  document.getElementById('staff-photo-input').value = '';
  const m = document.getElementById('staff-photo-modal');
  m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeStaffPhotoModal() {
  const m = document.getElementById('staff-photo-modal');
  m.classList.add('hidden'); m.style.display = '';
}
export function recropStaffPhoto() {
  const id = document.getElementById('staff-photo-target-id').value;
  if (!id) return;
  if (!photoUrlFor('staff', id)) { showToast('No photo to re-crop'); return; }
  closeStaffPhotoModal();
  showPhotoUpload('staff', id);
}
export function handleStaffPhotoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('Photo must be under 2MB.'); return; }
  const id = document.getElementById('staff-photo-target-id').value;
  closeStaffPhotoModal();
  showPhotoUpload('staff', id);
  const reader = new FileReader();
  reader.onload = ev => _loadImageIntoCrop(ev.target.result);
  reader.readAsDataURL(file);
  input.value = '';
}
export function clearStaffPhoto() {
  const id = document.getElementById('staff-photo-target-id').value;
  if (!id) return;
  _deleteFromR2(`staff_${id}`).catch(() => {});
  setStaffPhoto(id, null);
  closeStaffPhotoModal();
  window.renderStaffList?.(); window.renderSchedule?.();
  showToast('Photo removed');
}
