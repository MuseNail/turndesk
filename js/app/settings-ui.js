// ── Settings control kit ────────────────────────────────────────────────────
// Pure markup helpers for the redesigned Settings controls ("Option A"). Each takes
// plain data and returns an HTML string; none touch the DOM, so they're node-safe and
// unit-tested in test/settings-ui.test.js. Styling lives in css/styles.css (.set-*).
// Behavior is unchanged — these only change how a control looks and is wired; callers
// pass the handler string and (per the auto-save model) the value flows to the setter.
import { escHtml } from './utils.js';

// Segmented control — 2–4 mutually-exclusive choices. items:[{value,label,onclick}];
// the item whose value===value is the active chip.
export function segControl({ value, items = [] } = {}) {
  const buttons = items.map(it => {
    const on = it.value === value ? ' set-seg-on' : '';
    return `<button type="button" class="set-seg-btn${on}" onclick="${it.onclick}">${escHtml(it.label)}</button>`;
  }).join('');
  return `<div class="set-seg" role="group">${buttons}</div>`;
}

// On/off switch with a label and optional help text. Replaces a native checkbox.
export function switchRow({ label, help = '', on = false, onclick } = {}) {
  const onCls = on ? ' set-switch-on' : '';
  const helpHtml = help ? `<div class="set-help">${escHtml(help)}</div>` : '';
  return `<div class="set-switch-row">`
    + `<div class="set-switch-text"><div class="set-label">${escHtml(label)}</div>${helpHtml}</div>`
    + `<button type="button" class="set-switch${onCls}" role="switch" aria-checked="${on ? 'true' : 'false'}" onclick="${onclick}"><span class="set-switch-knob"></span></button>`
    + `</div>`;
}

// Styled native <select> for long/many option sets. items:[{value,label}]; the matching
// option is pre-selected. The native control is kept (OS owns the dropdown) — only the
// wrapper is styled.
export function styledSelect({ value, items = [], onchange } = {}) {
  const opts = items.map(it => {
    const sel = it.value === value ? ' selected' : '';
    return `<option value="${escHtml(it.value)}"${sel}>${escHtml(it.label)}</option>`;
  }).join('');
  return `<span class="set-field set-field-select"><select onchange="${onchange}">${opts}</select></span>`;
}
