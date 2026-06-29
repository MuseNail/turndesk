// ── Staff CRUD + weekly schedule ────────────────────────────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, localDateStr, byName, setSwitchVisual, escHtml } from '../utils.js';
import { SCHEDULE_COLORS } from '../config.js';

const cfg = () => getState().config;
const setStaff = (staff) => dispatch('config.set', { key: 'staff', value: staff });

// ── Active staff (config.inactive_staff) ──────────
export function isStaffActive(id) { return !cfg().inactive_staff.includes(id); }
export function toggleActiveStaff(id, btn) {
  const inactive = cfg().inactive_staff;
  const nowActive = inactive.includes(id);   // currently inactive → toggling activates
  dispatch('config.set', { key: 'inactive_staff', value: inactive.includes(id) ? inactive.filter(x => x !== id) : [...inactive, id] });
  if (!btn) { renderStaffList(); return; }
  setSwitchVisual(btn, nowActive);
  btn.title = nowActive ? 'Active — shown in menus' : 'Inactive — hidden from menus';
  // Reflect the same active/inactive state on the technician's name (struck-through when off).
  const name = btn.closest('div[onclick]')?.querySelector('.font-headline.font-semibold');
  if (name) { name.classList.toggle('line-through', !nowActive); name.classList.toggle('text-outline-variant', !nowActive); }
}
export function toggleAllActiveStaff() {
  dispatch('config.set', { key: 'inactive_staff', value: cfg().inactive_staff.length === 0 ? cfg().staff.map(s => s.id) : [] });
  renderStaffList();
}

// Re-render the list view, ensuring schedule view is hidden (settings leaf entry).
export function renderStaffMerged() { window.showStaffListView?.(); renderStaffList(); }

// ── Staff CRUD ────────────────────────────────────
export function renderStaffList() {
  const list = document.getElementById('staff-list');
  if (!list) return;
  list.innerHTML = [...cfg().staff].sort(byName).map(st => {
    const active = isStaffActive(st.id);
    const photoHtml = st.photo
      ? `<button onclick="event.stopPropagation();showTechPhoto('${st.id}')" title="View photo" class="flex-shrink-0 focus:outline-none"><img src="${st.photo}" class="w-10 h-10 rounded-full object-cover border border-surface-container-high hover:opacity-80 transition-opacity"></button>`
      : `<button onclick="event.stopPropagation();showTechPhoto('${st.id}')" title="View photo" class="flex-shrink-0 focus:outline-none"><div class="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors"><span class="text-sm font-headline font-bold text-on-surface">${escHtml(st.name.charAt(0).toUpperCase())}</span></div></button>`;
    const staffSvcs = (st.services && st.services.length > 0)
      ? st.services.map(sid => cfg().services.find(s => s.id === sid)?.abbr || '?').join(', ')
      : 'All services';
    return `
    <div onclick="showEditStaff('${st.id}')" title="Edit technician" class="bg-surface-container-lowest rounded-xl px-5 py-4 border border-surface-container-high flex items-center justify-between cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all">
      <div class="flex items-center gap-4 min-w-0">
        ${photoHtml}
        <div class="min-w-0">
          <div class="font-headline font-semibold text-on-surface text-base ${active ? '' : 'line-through text-outline-variant'}">${escHtml(st.name)}</div>
          <div class="flex gap-3 flex-wrap mt-0.5">
            ${st.commission != null ? `<span class="text-xs font-body text-on-surface-variant">${st.commission}% commission</span>` : ''}
            <span class="text-xs font-body text-primary truncate">${staffSvcs}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <button onclick="event.stopPropagation();toggleActiveStaff('${st.id}',this)" title="${active ? 'Active — shown in menus' : 'Inactive — hidden from menus'}" class="flex flex-col items-center gap-1 px-1 py-1">
          <span class="text-[9px] font-body uppercase tracking-wider ${active ? 'text-primary' : 'text-outline-variant'}">Active</span>
          <div class="mswitch relative w-14 h-7 rounded-full transition-colors ${active ? 'bg-primary' : 'bg-surface-container-high'}"><div class="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${active ? 'left-7' : 'left-0.5'}"></div></div>
        </button>
        <div class="flex items-center gap-1">
          <button onclick="event.stopPropagation();showPhotoUpload('staff','${st.id}')" title="Photo" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant transition-colors"><span class="material-symbols-outlined" style="font-size:18px">photo_camera</span></button>
          <button onclick="event.stopPropagation();deleteStaff('${st.id}')" class="w-9 h-9 rounded-full hover:bg-error/10 flex items-center justify-center text-on-surface-variant hover:text-error transition-colors"><span class="material-symbols-outlined" style="font-size:18px">delete</span></button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Full-size photo lightbox for a technician (tap the avatar in Turns / Staff).
export function showTechPhoto(staffId) {
  const st = (cfg().staff || []).find(s => String(s.id) === String(staffId));
  if (!st) return;
  const inner = st.photo
    ? `<img src="${st.photo}" style="max-width:90vw;max-height:78vh;object-fit:contain;border-radius:16px;box-shadow:0 10px 50px rgba(0,0,0,.55)">`
    : `<div style="width:220px;height:220px;border-radius:50%;background:#1a5252;color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--font-headline);font-weight:700;font-size:96px;box-shadow:0 10px 50px rgba(0,0,0,.55)">${escHtml((st.name || '?').charAt(0).toUpperCase())}</div>`;
  const m = document.createElement('div');
  m.className = 'fixed inset-0 z-[95] flex flex-col items-center justify-center bg-black/80 p-4';
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  m.onclick = close;
  document.addEventListener('keydown', onKey);
  m.innerHTML = `${inner}<div style="color:#fff;margin-top:16px;font-family:var(--font-headline);font-weight:700;font-size:18px">${escHtml(st.name || '')}</div><div style="color:#cbd5d5;margin-top:4px;font-size:12px">Tap anywhere or press Esc to close</div>`;
  document.body.appendChild(m);
}

export function renderStaffServicesPicker(selectedServices) {
  const picker = document.getElementById('staff-services-picker');
  if (!picker) return;
  picker.innerHTML = cfg().services.map(s => {
    const sel = selectedServices && selectedServices.includes(s.id);
    return `<button type="button" onclick="this.classList.toggle('selected')" data-service="${s.id}"
      class="service-btn flex flex-col items-center justify-center py-2 rounded-lg border transition-all text-xs bg-surface-container text-on-surface-variant border-outline-variant/30${sel ? ' selected' : ''}">
      <span class="font-headline font-bold">${s.abbr}</span>
      <span class="text-[9px] font-body mt-0.5 uppercase tracking-tighter">${s.label}</span>
    </button>`;
  }).join('');
}

export function showAddStaff() {
  document.getElementById('staff-modal-title').textContent = 'Add Technician';
  document.getElementById('staff-name-input').value = '';
  { const ln = document.getElementById('staff-legalname-input'); if (ln) ln.value = ''; }
  document.getElementById('staff-commission-input').value = '';
  const pinEl = document.getElementById('staff-pin-input'); if (pinEl) pinEl.value = '';
  document.getElementById('staff-edit-id').value = '';
  _setStaffCheckFields('variable', '');
  _setStaffDeductFields('', '');
  renderStaffServicesPicker([]);
  _setStaffAppFields({});   // new tech → all staff-app features on
  const m = document.getElementById('staff-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('staff-name-input').focus(), 100);
}

export function showEditStaff(id) {
  const st = cfg().staff.find(s => s.id === id);
  if (!st) return;
  document.getElementById('staff-modal-title').textContent = 'Edit Technician';
  document.getElementById('staff-name-input').value = st.name;
  { const ln = document.getElementById('staff-legalname-input'); if (ln) ln.value = st.legalName || ''; }
  document.getElementById('staff-commission-input').value = st.commission != null ? st.commission : '';
  const pinEl = document.getElementById('staff-pin-input'); if (pinEl) pinEl.value = st.pin || '';
  document.getElementById('staff-edit-id').value = id;
  _setStaffCheckFields(st.checkType || 'variable', st.checkValue != null ? st.checkValue : '');
  _setStaffDeductFields(st.cashDeductPct != null ? st.cashDeductPct : '', st.cashDeductThreshold != null ? st.cashDeductThreshold : '');
  _setStaffAppFields(st.app || {});
  renderStaffServicesPicker(st.services || []);
  const m = document.getElementById('staff-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
// Staff-app feature switches — `app[key] !== false` is the read rule everywhere, so a
// missing/legacy staff object (no `app` at all) keeps every feature ON.
function _setStaffAppFields(app) {
  const set = (id, on) => { const el = document.getElementById(id); if (el) el.checked = on; };
  set('staff-app-pdf', app.pdf !== false);
  set('staff-app-history', app.history !== false);
  set('staff-app-histnames', app.histNames !== false);
  staffAppHistChanged();
}
export function staffAppHistChanged() {
  const histOn = !!document.getElementById('staff-app-history')?.checked;
  const row = document.getElementById('staff-app-histnames-row');
  if (row) { row.style.opacity = histOn ? '' : '0.4'; const cb = row.querySelector('input'); if (cb) cb.disabled = !histOn; }
}

export function closeStaffModal() {
  const m = document.getElementById('staff-modal'); m.classList.add('hidden'); m.style.display = '';
}
// Paycheck (gross) config — how the tech's check portion is set on the Payroll page.
function _setStaffCheckFields(type, value) {
  const ts = document.getElementById('staff-check-type'); if (ts) ts.value = type;
  const vi = document.getElementById('staff-check-value'); if (vi) vi.value = value;
  staffCheckTypeChanged();
}
export function staffCheckTypeChanged() {
  const type = document.getElementById('staff-check-type')?.value || 'variable';
  const wrap = document.getElementById('staff-check-value-wrap');
  const lbl = document.getElementById('staff-check-value-label');
  if (wrap) wrap.classList.toggle('hidden', type === 'variable');
  if (lbl) lbl.textContent = type === 'percent' ? '% of commission' : 'Check amount ($)';
}
// Cash-deduction config — % taken from the cash portion above an exempt threshold.
function _setStaffDeductFields(pct, threshold) {
  const p = document.getElementById('staff-cashdeduct-pct'); if (p) p.value = pct;
  const t = document.getElementById('staff-cashdeduct-threshold'); if (t) t.value = threshold;
}

export function saveStaff() {
  const name = document.getElementById('staff-name-input').value.trim();
  const legalName = (document.getElementById('staff-legalname-input')?.value || '').trim();
  const commRaw = document.getElementById('staff-commission-input').value.trim();
  const commission = commRaw !== '' ? parseFloat(commRaw) : null;
  const pin = (document.getElementById('staff-pin-input')?.value || '').trim();
  const checkType = document.getElementById('staff-check-type')?.value || 'variable';
  const checkValue = checkType === 'variable' ? null : (parseFloat(document.getElementById('staff-check-value')?.value) || 0);
  const dedPctRaw = (document.getElementById('staff-cashdeduct-pct')?.value || '').trim();
  const dedThrRaw = (document.getElementById('staff-cashdeduct-threshold')?.value || '').trim();
  const cashDeductPct = dedPctRaw !== '' ? parseFloat(dedPctRaw) : null;
  const cashDeductThreshold = dedThrRaw !== '' ? parseFloat(dedThrRaw) : null;
  const editId = document.getElementById('staff-edit-id').value;
  const selectedSvcs = [...document.querySelectorAll('#staff-services-picker .service-btn.selected')].map(b => b.dataset.service);
  if (!name) { showToast('Please enter a name.'); return; }
  if (commission !== null && (isNaN(commission) || commission < 0 || commission > 100)) { showToast('Commission must be 0–100.'); return; }
  if (cashDeductPct !== null && (isNaN(cashDeductPct) || cashDeductPct < 0 || cashDeductPct > 100)) { showToast('Cash deduction % must be 0–100.'); return; }
  if (cashDeductThreshold !== null && (isNaN(cashDeductThreshold) || cashDeductThreshold < 0)) { showToast('Exempt threshold must be 0 or more.'); return; }
  // Soft-warn (don't block) if this Staff-App PIN collides with another tech's — same PIN logs in as whoever matches first.
  if (pin && cfg().staff.some(s => s.id !== editId && s.pin === pin)) showToast('Heads up: another tech already uses that PIN.');
  // §13: server login scans front-desk users FIRST — a PIN shared with an fd user would shadow this tech's sign-in entirely.
  if (pin && (cfg().fd_users || []).some(u => String(u.pin) === pin)) showToast('Heads up: a front-desk user already uses that PIN — this tech won’t be able to sign in with it.');
  const app = {
    pdf: !!document.getElementById('staff-app-pdf')?.checked,
    history: !!document.getElementById('staff-app-history')?.checked,
    histNames: !!document.getElementById('staff-app-histnames')?.checked,
  };
  const staff = [...cfg().staff];
  if (editId) {
    const i = staff.findIndex(s => s.id === editId);
    if (i >= 0) staff[i] = { ...staff[i], name, legalName, commission, services: selectedSvcs, pin, checkType, checkValue, cashDeductPct, cashDeductThreshold, app };
  } else {
    staff.push({ id: `staff-${Date.now()}`, name, legalName, commission, services: selectedSvcs, pin, checkType, checkValue, cashDeductPct, cashDeductThreshold, app });
  }
  setStaff(staff);
  closeStaffModal();
  renderStaffList();
  showToast(editId ? 'Technician updated' : `${name} added`);
}

export function deleteStaff(id) {
  const st = cfg().staff.find(s => s.id === id);
  if (!st) return;
  // Hard-deleting a tech who has past sales makes those records show as "Unknown" with $0
  // commission in payroll — steer the operator to deactivate (Active toggle) instead.
  const hasHistory = (getState().records || []).some(r => (r.assignments || []).some(a => a.techId === id));
  const msg = hasHistory
    ? `Remove ${st.name}? They have past sales, which will then show as "Unknown" with no commission in reports. To keep their history, tap Cancel and use the Active toggle to hide them instead.\n\nDelete anyway?`
    : `Remove ${st.name} from staff?`;
  if (!confirm(msg)) return;
  setStaff(cfg().staff.filter(s => s.id !== id));
  // Scrub orphaned references so a deleted tech's id doesn't linger (and keep syncing) in config.
  if ((cfg().inactive_staff || []).includes(id)) dispatch('config.set', { key: 'inactive_staff', value: cfg().inactive_staff.filter(x => x !== id) });
  if ((cfg().turns_order || []).includes(id)) dispatch('config.set', { key: 'turns_order', value: cfg().turns_order.filter(x => x !== id) });
  if (cfg().svc_time_reset && cfg().svc_time_reset[id] != null) { const m = { ...cfg().svc_time_reset }; delete m[id]; dispatch('config.set', { key: 'svc_time_reset', value: m }); }
  const sched = cfg().schedule;
  const inSched = sched && (sched._repeats?.[id] != null || Object.keys(sched).some(k => k !== '_repeats' && sched[k] && sched[k][id] != null));
  if (inSched) {
    const next = JSON.parse(JSON.stringify(sched));
    Object.keys(next).forEach(k => { if (k === '_repeats') return; if (next[k] && next[k][id] != null) { delete next[k][id]; if (!Object.keys(next[k]).length) delete next[k]; } });
    if (next._repeats && next._repeats[id] != null) delete next._repeats[id];
    dispatch('config.set', { key: 'schedule', value: next });
  }
  renderStaffList();
  showToast(`${st.name} removed`);
}

// ── Weekly schedule ───────────────────────────────
let scheduleWeekStart = getWeekStart(new Date());
let schedulePickerTarget = null;

export function getWeekStart(d) {
  const date = new Date(d); date.setHours(0,0,0,0);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

export function scheduleWeekOffset(delta, goToToday = false) {
  if (goToToday) scheduleWeekStart = getWeekStart(new Date());
  else { scheduleWeekStart = new Date(scheduleWeekStart); scheduleWeekStart.setDate(scheduleWeekStart.getDate() + delta * 7); }
  renderSchedule();
}

// One-off "blank" sentinel: an explicit per-date entry that overrides a weekly _repeats
// rule to mark that single day as off-schedule (i.e. Clear on a day driven by a repeat).
// getScheduleStatus maps it back to null so the day reads as unset everywhere.
export const SCHED_NONE = '__none__';

export function getScheduleStatus(date, staffId) {
  const sched = cfg().schedule || {};
  const explicit = sched[date]?.[staffId];
  if (explicit === SCHED_NONE) return null;       // one-off blank overrides the weekly repeat
  if (explicit) return explicit;
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();
  return sched._repeats?.[staffId]?.[dayOfWeek] || null;
}

export function renderSchedule() {
  const grid = document.getElementById('schedule-grid');
  const label = document.getElementById('schedule-week-label');
  if (!grid || !label) return;
  const sched = cfg().schedule || {};
  const weekEnd = new Date(scheduleWeekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const fmtShort = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  label.textContent = `${fmtShort(scheduleWeekStart)} – ${fmtShort(weekEnd)}`;

  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dates = days.map((_, i) => { const d = new Date(scheduleWeekStart); d.setDate(d.getDate() + i); return d; });
  const today = new Date(); today.setHours(0,0,0,0);
  const isToday = d => d.toDateString() === today.toDateString();

  // Sticky header row (top) + sticky name column (left) need opaque backgrounds so
  // rows/columns don't bleed through when scrolling. --surface-container-lowest fallback.
  const stickyBg = 'background:var(--surface-container-lowest, #f5f7f8)';
  const headerCols = dates.map((d, i) => `
    <div class="text-center px-2 py-1.5 min-w-[88px]${isToday(d) ? ' bg-primary/5' : ''}">
      <div class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">${days[i]}</div>
      <div class="text-sm font-headline font-bold ${isToday(d) ? 'text-primary' : 'text-on-surface'}">${d.getDate()}</div>
    </div>`).join('');

  const staffRows = [...cfg().staff].sort(byName).map(st => {
    const photoHtml = st.photo
      ? `<img src="${st.photo}" class="w-8 h-8 rounded-full object-cover border border-surface-container-high flex-shrink-0">`
      : `<div class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0"><span class="text-xs font-headline font-bold text-on-surface">${escHtml(st.name.charAt(0).toUpperCase())}</span></div>`;
    const cells = dates.map(d => {
      const key = localDateStr(d);
      const status = getScheduleStatus(key, st.id);
      const isRepeat = !sched[key]?.[st.id] && sched._repeats?.[st.id]?.[d.getDay()];
      const sColor = status ? SCHEDULE_COLORS[status] : null;
      const cellStyle = sColor ? `background:${sColor.bg};color:${sColor.text};` : '';
      const isPast = d < today && !isToday(d);
      return `
        <div class="min-w-[88px] px-1 py-0.5">
          <button onclick="openSchedulePicker('${key}','${st.id}')"
            class="w-full h-9 rounded-lg text-xs font-body font-semibold transition-all hover:opacity-80 border relative ${sColor ? 'border-transparent' : 'border-dashed border-outline-variant/50 hover:bg-surface-container'} ${isPast ? 'opacity-50' : ''}"
            style="${cellStyle}">${sColor ? sColor.label : ''}
            ${isRepeat ? '<span style="position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#15514f;box-shadow:0 0 0 1px rgba(255,255,255,0.7)"></span>' : ''}
          </button>
        </div>`;
    }).join('');
    return `
      <div class="flex items-center border-b border-surface-container-high last:border-0">
        <div class="flex items-center gap-2 w-[160px] pr-2 py-1 flex-shrink-0 sticky left-0 z-10" style="${stickyBg}">
          <button onclick="openWeekFill('${st.id}')" title="Fill ${st.name.replace(/'/g,'')}'s week" class="flex-shrink-0 hover:opacity-70 transition-opacity">${photoHtml}</button>
          <span class="text-sm font-body font-semibold text-on-surface truncate min-w-0 flex-grow">${escHtml(st.name)}</span>
          <button onclick="openWeekFill('${st.id}')" title="Fill ${st.name.replace(/'/g,'')}'s week" class="flex-shrink-0 w-6 h-6 rounded-full hover:bg-surface-container flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined" style="font-size:16px">edit_calendar</span></button>
        </div>
        ${cells}
      </div>`;
  }).join('');

  grid.innerHTML = `
    <div class="flex items-center border-b-2 border-surface-container-high sticky top-0 z-20" style="${stickyBg}">
      <div class="w-[160px] flex-shrink-0 sticky left-0 z-30" style="${stickyBg}"></div>${headerCols}
    </div>
    ${staffRows || '<div class="text-sm font-body text-on-surface-variant py-8 text-center">No staff added yet. Add staff in the Staff tab.</div>'}`;
}

export function openSchedulePicker(date, staffId) {
  schedulePickerTarget = { date, staffId };
  const st = cfg().staff.find(s => s.id === staffId);
  const d  = new Date(date + 'T12:00:00');
  document.getElementById('schedule-picker-label').textContent = `${st?.name || ''} — ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  // Default the repeat toggle to reflect reality: if this day is currently driven by a weekly
  // repeat, start it ON so editing the day keeps the weekly pattern by default (turning it OFF
  // makes a one-off exception). Avoids silently de-repeating a recurring day.
  const hasRepeat = !!(cfg().schedule?._repeats?.[staffId]?.[d.getDay()]);
  const cb  = document.getElementById('repeat-toggle-cb');
  const box = document.getElementById('repeat-toggle-box');
  const chk = document.getElementById('repeat-toggle-check');
  if (cb)  cb.checked = hasRepeat;
  if (box) { box.style.background = hasRepeat ? '#1a5252' : 'transparent'; box.style.borderColor = hasRepeat ? '#1a5252' : ''; }
  if (chk) chk.classList.toggle('hidden', !hasRepeat);
  const note = document.getElementById('schedule-picker-note');
  if (note) {
    if (hasRepeat) { note.textContent = 'This day repeats weekly. Turn off “Repeat weekly”, then tap Clear to blank just this one day; Clear with Repeat on removes the weekly repeat.'; note.classList.remove('hidden'); }
    else { note.textContent = ''; note.classList.add('hidden'); }
  }
  const m = document.getElementById('schedule-picker'); m.classList.remove('hidden'); m.style.display = 'flex';
}

export function toggleRepeatSchedule() {
  const cb  = document.getElementById('repeat-toggle-cb');
  const box = document.getElementById('repeat-toggle-box');
  const chk = document.getElementById('repeat-toggle-check');
  cb.checked = !cb.checked;
  if (cb.checked) { box.style.background = '#1a5252'; box.style.borderColor = '#1a5252'; chk.classList.remove('hidden'); }
  else { box.style.background = 'transparent'; box.style.borderColor = ''; chk.classList.add('hidden'); }
}

export function closeSchedulePicker() {
  const m = document.getElementById('schedule-picker'); m.classList.add('hidden'); m.style.display = '';
  schedulePickerTarget = null;
}

export function setScheduleStatus(status) {
  if (!schedulePickerTarget) return;
  const { date, staffId } = schedulePickerTarget;
  const repeat = document.getElementById('repeat-toggle-cb')?.checked || false;
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();
  const sched = JSON.parse(JSON.stringify(cfg().schedule || {}));

  if (repeat && status !== null) {
    if (!sched._repeats) sched._repeats = {};
    if (!sched._repeats[staffId]) sched._repeats[staffId] = {};
    sched._repeats[staffId][dayOfWeek] = status;
  } else if (repeat && status === null) {
    if (sched._repeats?.[staffId]?.[dayOfWeek]) delete sched._repeats[staffId][dayOfWeek];
  }
  if (!sched[date]) sched[date] = {};
  if (status === null) {
    // Clearing a day. If a weekly repeat still covers this weekday (and we didn't just remove
    // it above), store an explicit blank sentinel so the repeat doesn't make the day reappear;
    // otherwise drop the entry entirely.
    if (sched._repeats?.[staffId]?.[dayOfWeek]) sched[date][staffId] = SCHED_NONE;
    else { delete sched[date][staffId]; if (Object.keys(sched[date]).length === 0) delete sched[date]; }
  } else sched[date][staffId] = status;

  dispatch('config.set', { key: 'schedule', value: sched });
  closeSchedulePicker();
  renderSchedule();
}

// ── Fill week (per-staff quick entry) ─────────────
// One modal to set a staff's whole week at once: tap days to cycle Working/Off/blank,
// "All working"/"All off" shortcuts, and an optional "Repeat every week" that also
// writes the recurring default. Cuts the per-day tap-through-a-popup for a full week.
let _weekFillTarget = null, _weekFillDays = [], _weekFillRepeat = false;
const _WF_LABEL = { working: 'Work', off: 'Off', sick: 'Sick', vacation: 'Vac' };
export function openWeekFill(staffId) {
  _weekFillTarget = staffId; _weekFillRepeat = false;
  const st = cfg().staff.find(s => s.id === staffId);
  _weekFillDays = [];
  for (let i = 0; i < 7; i++) { const d = new Date(scheduleWeekStart); d.setDate(d.getDate() + i); _weekFillDays.push(getScheduleStatus(localDateStr(d), staffId)); }
  const lbl = document.getElementById('week-fill-label'); if (lbl) lbl.textContent = `${st?.name || ''} — fill week`;
  const box = document.getElementById('week-fill-repeat-box'), chk = document.getElementById('week-fill-repeat-check');
  if (box) { box.style.background = 'transparent'; box.style.borderColor = ''; }
  if (chk) chk.classList.add('hidden');
  renderWeekFillDays();
  const m = document.getElementById('week-fill-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeWeekFill() {
  const m = document.getElementById('week-fill-modal'); m.classList.add('hidden'); m.style.display = '';
  _weekFillTarget = null;
}
function renderWeekFillDays() {
  const host = document.getElementById('week-fill-days'); if (!host) return;
  const dn = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  host.innerHTML = _weekFillDays.map((status, i) => {
    const sc = status ? SCHEDULE_COLORS[status] : null;
    const d = new Date(scheduleWeekStart); d.setDate(d.getDate() + i);
    return `<button onclick="weekFillCycle(${i})" class="rounded-lg py-1.5 text-center border ${sc ? 'border-transparent' : 'border-dashed border-outline-variant/50'}" style="${sc ? `background:${sc.bg};color:${sc.text}` : ''}">
      <div class="text-[9px] font-body font-semibold uppercase tracking-wider opacity-80">${dn[i]}</div>
      <div class="text-[10px] font-headline font-bold leading-tight">${d.getDate()}</div>
      <div class="text-[9px] leading-tight">${sc ? _WF_LABEL[status] : '—'}</div>
    </button>`;
  }).join('');
}
export function weekFillCycle(i) {
  const cur = _weekFillDays[i];
  _weekFillDays[i] = cur === 'working' ? 'off' : cur === 'off' ? null : 'working';
  renderWeekFillDays();
}
export function weekFillAll(status) { _weekFillDays = Array(7).fill(status); renderWeekFillDays(); }
export function weekFillToggleRepeat() {
  _weekFillRepeat = !_weekFillRepeat;
  const box = document.getElementById('week-fill-repeat-box'), chk = document.getElementById('week-fill-repeat-check');
  if (_weekFillRepeat) { box.style.background = '#1a5252'; box.style.borderColor = '#1a5252'; chk.classList.remove('hidden'); }
  else { box.style.background = 'transparent'; box.style.borderColor = ''; chk.classList.add('hidden'); }
}
export function saveWeekFill() {
  if (!_weekFillTarget) return;
  const staffId = _weekFillTarget, repeat = _weekFillRepeat;
  const sched = JSON.parse(JSON.stringify(cfg().schedule || {}));
  if (repeat) { if (!sched._repeats) sched._repeats = {}; if (!sched._repeats[staffId]) sched._repeats[staffId] = {}; }
  for (let i = 0; i < 7; i++) {
    const status = _weekFillDays[i];
    const d = new Date(scheduleWeekStart); d.setDate(d.getDate() + i);
    const key = localDateStr(d), dow = d.getDay();
    // Update the weekly repeat first (when the toggle is on) so the blank-day check below
    // sees the post-edit repeat state.
    if (repeat) { if (status) sched._repeats[staffId][dow] = status; else if (sched._repeats[staffId]?.[dow]) delete sched._repeats[staffId][dow]; }
    if (status) { if (!sched[key]) sched[key] = {}; sched[key][staffId] = status; }
    else if (sched._repeats?.[staffId]?.[dow]) { if (!sched[key]) sched[key] = {}; sched[key][staffId] = SCHED_NONE; }  // blank a repeat-driven day → one-off sentinel
    else if (sched[key]?.[staffId]) { delete sched[key][staffId]; if (!Object.keys(sched[key]).length) delete sched[key]; }
  }
  dispatch('config.set', { key: 'schedule', value: sched });
  closeWeekFill();
  renderSchedule();
  showToast(repeat ? 'Week saved + set to repeat weekly' : 'Week saved');
}

// ── Copy last week → this week ────────────────────
export function copyLastWeekSchedule() {
  const sched = JSON.parse(JSON.stringify(cfg().schedule || {}));
  const prevStart = new Date(scheduleWeekStart); prevStart.setDate(prevStart.getDate() - 7);
  const staffIds = (cfg().staff || []).map(s => s.id);
  let found = 0;
  const plan = [];
  for (let i = 0; i < 7; i++) {
    const src = new Date(prevStart); src.setDate(src.getDate() + i);
    const dst = new Date(scheduleWeekStart); dst.setDate(dst.getDate() + i);
    // Use each staff's EFFECTIVE status for last week's day (explicit entry OR weekly repeat),
    // so a week driven entirely by repeats still copies instead of reporting "nothing to copy".
    const srcKey = localDateStr(src);
    const eff = {};
    staffIds.forEach(id => { const stat = getScheduleStatus(srcKey, id); if (stat) eff[id] = stat; });
    const has = Object.keys(eff).length > 0;
    plan.push({ dstKey: localDateStr(dst), srcDay: has ? eff : null });
    if (has) found++;
  }
  if (!found) { showToast('Last week has no schedule to copy.'); return; }
  if (!confirm("Copy last week's schedule into this week? This overwrites this week's entries.")) return;
  plan.forEach(({ dstKey, srcDay }) => { if (srcDay) sched[dstKey] = srcDay; else delete sched[dstKey]; });
  dispatch('config.set', { key: 'schedule', value: sched });
  renderSchedule();
  showToast("Copied last week's schedule");
}
