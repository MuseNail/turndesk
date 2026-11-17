// Pure control-markup helpers for the Settings redesign (Phase 1). Each returns an HTML string
// built from plain data, so they can be tested without any DOM. Markup only — no behavior change
// to what the settings do. Import setup-globals FIRST (static imports evaluate in source order).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { segControl, switchRow, styledSelect } from '../js/app/settings-ui.js';

// ── segControl ──────────────────────────────────────────────────────────────
test('segControl renders a button for every item', () => {
  const html = segControl({ value: 'a', items: [
    { value: 'a', label: 'Apple', onclick: 'pick("a")' },
    { value: 'b', label: 'Banana', onclick: 'pick("b")' },
  ] });
  assert.match(html, /class="set-seg"/);
  assert.match(html, />Apple</);
  assert.match(html, />Banana</);
  assert.equal((html.match(/<button/g) || []).length, 2);
});

test('segControl marks exactly the active item set-seg-on', () => {
  const html = segControl({ value: 'b', items: [
    { value: 'a', label: 'Apple', onclick: 'x' },
    { value: 'b', label: 'Banana', onclick: 'y' },
  ] });
  assert.equal((html.match(/set-seg-on/g) || []).length, 1);
  // the on-class sits on the Banana button, not Apple
  assert.match(html, /set-seg-on[^>]*>Banana</);
});

test('segControl wires each item onclick', () => {
  const html = segControl({ value: 'a', items: [
    { value: 'a', label: 'Apple', onclick: 'pick("a")' },
    { value: 'b', label: 'Banana', onclick: 'pick("b")' },
  ] });
  assert.match(html, /onclick="pick\("a"\)"/);
  assert.match(html, /onclick="pick\("b"\)"/);
});

test('segControl escapes the label text', () => {
  const html = segControl({ value: 'a', items: [
    { value: 'a', label: '<b>A&B</b>', onclick: 'x' },
  ] });
  assert.doesNotMatch(html, /<b>A&B<\/b>/);
  assert.match(html, /&lt;b&gt;A&amp;B&lt;\/b&gt;/);
});

// ── switchRow ───────────────────────────────────────────────────────────────
test('switchRow marks on with set-switch-on and aria-checked=true', () => {
  const html = switchRow({ label: 'Offer rebooking', help: 'At checkout', on: true, onclick: 'tgl()' });
  assert.match(html, /set-switch-on/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /role="switch"/);
});

test('switchRow off has no on-class and aria-checked=false', () => {
  const html = switchRow({ label: 'Offer rebooking', help: 'At checkout', on: false, onclick: 'tgl()' });
  assert.doesNotMatch(html, /set-switch-on/);
  assert.match(html, /aria-checked="false"/);
});

test('switchRow wires onclick and shows label + help', () => {
  const html = switchRow({ label: 'Offer rebooking', help: 'At checkout', on: false, onclick: 'tgl()' });
  assert.match(html, /onclick="tgl\(\)"/);
  assert.match(html, />Offer rebooking</);
  assert.match(html, />At checkout</);
});

test('switchRow escapes label and help', () => {
  const html = switchRow({ label: '<x>', help: 'a & b', on: false, onclick: 'z' });
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /a &amp; b/);
});

// ── styledSelect ────────────────────────────────────────────────────────────
test('styledSelect wraps a native select in a set-field and selects the match', () => {
  const html = styledSelect({ value: '15', items: [
    { value: '10', label: '10 min' },
    { value: '15', label: '15 min' },
    { value: '20', label: '20 min' },
  ], onchange: 'save(this.value)' });
  assert.match(html, /class="set-field[^"]*"/);
  assert.match(html, /<select/);
  assert.match(html, /onchange="save\(this\.value\)"/);
  assert.equal((html.match(/selected/g) || []).length, 1);
  assert.match(html, /value="15" selected[^>]*>15 min</);
});

test('styledSelect escapes option labels', () => {
  const html = styledSelect({ value: 'a', items: [
    { value: 'a', label: '<opt>' },
  ], onchange: 'x' });
  assert.match(html, /&lt;opt&gt;/);
});
