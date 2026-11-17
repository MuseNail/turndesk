// ── Settings control kit ────────────────────────────────────────────────────
// Pure markup helpers for the redesigned Settings controls ("Option A"). Each takes
// plain data and returns an HTML string; none touch the DOM, so they're node-safe and
// unit-tested in test/settings-ui.test.js. Styling lives in css/styles.css (.set-*).
// Behavior is unchanged — these only change how a control looks and is wired; callers
// pass the handler string and (per the auto-save model) the value flows to the setter.
import { escHtml } from './utils.js';

// Segmented control — 2–4 mutually-exclusive choices. items:[{value,label,onclick}];
// the item whose value===value is the active chip. `label` names the group for assistive tech.
export function segControl({ value, items = [], label } = {}) {
  const buttons = items.map(it => {
    const active = it.value === value;
    return `<button type="button" class="set-seg-btn${active ? ' set-seg-on' : ''}" aria-pressed="${active ? 'true' : 'false'}" onclick="${it.onclick}">${escHtml(it.label)}</button>`;
  }).join('');
  const named = label ? ` aria-label="${escHtml(label)}"` : '';
  return `<div class="set-seg" role="group"${named}>${buttons}</div>`;
}

// On/off switch with a label and optional help text. Replaces a native checkbox. The WHOLE row is
// the control (a button with role=switch), so tapping the label toggles it — important on the
// front-desk iPad. The pill/knob is presentational (aria-hidden).
export function switchRow({ label, help = '', on = false, onclick } = {}) {
  const onCls = on ? ' set-switch-on' : '';
  const helpHtml = help ? `<span class="set-help">${escHtml(help)}</span>` : '';
  return `<button type="button" class="set-switch-row" role="switch" aria-checked="${on ? 'true' : 'false'}" onclick="${onclick}">`
    + `<span class="set-switch-text"><span class="set-label">${escHtml(label)}</span>${helpHtml}</span>`
    + `<span class="set-switch${onCls}" aria-hidden="true"><span class="set-switch-knob"></span></span>`
    + `</button>`;
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
