// Phase 1 of the editable/tiered price menu: the menu is data (config.price_menu, seeded from
// DEFAULT_PRICE_MENU), rendered by a pure priceMenuToHtml, with a hardened normalizePriceMenu that
// can never let a malformed synced config blank the customer-facing menu. Tiers = pick-one variants
// + stackable add-ons, rendered indented. Owner text is stored DECODED and escaped once on render.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { escHtml } from '../js/app/utils.js';
import { priceMenuToHtml, normalizePriceMenu, DEFAULT_PRICE_MENU } from '../js/app/features/guide.js';

const render = menu => priceMenuToHtml(menu, '<img class="logo">', escHtml);
const one = (cols, foot) => ({ v: 1, pages: [{ title: 'T', cols, foot: foot || [] }] });

// ── sections + rows ──
test('a section renders .sec and its desc adjacent (so the .sec + .desc margin rule applies)', () => {
  const h = render(one([[{ t: 'sec', label: 'Manicures', desc: 'incl. color' }], []]));
  assert.match(h, /<div class="sec">Manicures<\/div><div class="desc">incl\. color<\/div>/);
});
test('a row renders name/dots/price, and a row desc follows the row', () => {
  const h = render(one([[{ t: 'row', nm: 'Gel Manicure', pr: '$38', desc: 'gel color included' }], []]));
  assert.match(h, /<span class="nm">Gel Manicure<\/span><span class="dots"><\/span><span class="pr">\$38<\/span>/);
  assert.match(h, /<div class="desc">gel color included<\/div>/);
});

// ── tiers ──
test('variants render as indented .subrow lines (no "choose one" cue)', () => {
  const h = render(one([[{ t: 'row', nm: 'Acrylic', pr: '', variants: [{ nm: 'Full set', pr: '$56' }, { nm: 'Fill', pr: '$46' }] }], []]));
  assert.ok(!/class="choose"/.test(h), 'the "choose one" cue was removed (owner request)');
  assert.match(h, /<div class="subrow"><span class="nm">Full set<\/span>.*<span class="pr">\$56<\/span><\/div>/);
  assert.match(h, /Fill<\/span>.*\$46/);
});
test('add-ons render as + lines in .addon', () => {
  const h = render(one([[{ t: 'row', nm: 'Gel Manicure', pr: '$38', addons: [{ nm: 'French tip', pr: '$7' }] }], []]));
  assert.match(h, /<div class="addon"><span class="nm">\+ French tip<\/span>.*<span class="pr">\$7<\/span><\/div>/);
});
test('a row can carry BOTH variants and add-ons', () => {
  const h = render(one([[{ t: 'row', nm: 'X', pr: '$1', variants: [{ nm: 'A', pr: '$2' }], addons: [{ nm: 'B', pr: '$3' }] }], []]));
  assert.ok(h.includes('class="subrow"') && h.includes('class="addon"'));
});

// ── escaping (escHtml: & < > " ; NOT ' ) ──
test('every owner field is escaped, including the page title', () => {
  const h = render({ v: 1, pages: [{ title: 'A & B', cols: [[{ t: 'row', nm: '<b>x</b>', pr: '"$5"', desc: 'a & b' }], []], foot: [] }] });
  assert.match(h, /<div class="pagetitle">A &amp; B<\/div>/);
  assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(h, /&quot;\$5&quot;/);
  assert.ok(!h.includes('<b>x</b>'));
});

// ── footers: cls whitelist + no empty class attr ──
test('foot cls is whitelisted and a plain paragraph has no class attribute', () => {
  const h = render(one([[], []], [{ text: 'plain' }, { text: 'c', cls: 'cash' }, { text: 'bad', cls: 'onmouseover=alert(1)' }]));
  assert.match(h, /<p>plain<\/p>/);
  assert.match(h, /<p class="cash">c<\/p>/);
  assert.match(h, /<p>bad<\/p>/);          // non-whitelisted class dropped
  assert.ok(!h.includes('class=""'));
  assert.ok(!h.includes('onmouseover'));
});

// ── normalizePriceMenu: hardening + id backfill ──
test('normalizePriceMenu falls back to the default for a malformed/partial config', () => {
  for (const bad of [null, undefined, {}, { v: 1 }, { pages: 'nope' }, { pages: [] }, 42, 'x']) {
    const m = normalizePriceMenu(bad);
    assert.ok(Array.isArray(m.pages) && m.pages.length === 2, `fallback for ${JSON.stringify(bad)}`);
  }
});
test('normalizePriceMenu coerces junk nodes instead of throwing, and render never throws', () => {
  const junk = { v: 1, pages: [{ title: 123, cols: [[null, { t: 'row' }, { t: 'mystery' }], 'notarray'], foot: 'nope' }] };
  const m = normalizePriceMenu(junk);
  assert.doesNotThrow(() => render(m));
  const col0 = m.pages[0].cols[0];
  assert.equal(col0.length, 1);                 // null + unknown dropped, the bare row kept
  assert.equal(col0[0].nm, '');                 // missing nm coerced to ''
  assert.equal(m.pages[0].cols.length, 2 >= 1 ? m.pages[0].cols.length : 0);  // tolerated, not assumed ==2
});
test('normalizePriceMenu backfills a missing id on every node', () => {
  const m = normalizePriceMenu({ v: 1, pages: [{ title: 'T', cols: [[{ t: 'row', nm: 'A', pr: '$1', variants: [{ nm: 'v', pr: '$2' }] }], []], foot: [] }] });
  const row = m.pages[0].cols[0][0];
  assert.ok(row.id);
  assert.ok(row.variants[0].id);
});

// ── the default renders the generic starter menu (structural + content, escaped) ──
test('DEFAULT_PRICE_MENU renders the expected structure and content', () => {
  const h = render(normalizePriceMenu(null));   // null → default
  assert.equal((h.match(/class="page"/g) || []).length, 2);
  assert.ok(h.includes('class="sec"') && h.includes('class="row"') && h.includes('class="foot"'));
  assert.ok(h.includes('class="fix"'));         // the "sample menu — edit it" fine-print line
  assert.ok(h.includes('Classic Manicure') && h.includes('$25'));
  assert.match(h, /Color &amp; Add-Ons/);       // stored decoded "&", escaped once (not &amp;amp;)
  assert.ok(!h.includes('&amp;amp;'));          // no double-escape anywhere
});
test('DEFAULT_PRICE_MENU is well-formed decoded data (no HTML entities stored)', () => {
  const s = JSON.stringify(DEFAULT_PRICE_MENU);
  assert.ok(!s.includes('&amp;') && !s.includes('&nbsp;'), 'default stores decoded text, not entities');
  assert.equal(DEFAULT_PRICE_MENU.pages.length, 2);
});

// ── Fidelity lock: pins the generic STARTER menu's content/order/prices so a later edit can't
// silently drop a row, fat-finger a price, or reorder a column and still pass green. (This is a
// brand-neutral sample — NOT any real salon's prices; every salon edits it in Settings → Price Menu.) ──
test('DEFAULT_PRICE_MENU content lock — exact section labels, row count, and ordered prices', () => {
  const secs = DEFAULT_PRICE_MENU.pages.flatMap(p => p.cols.flatMap(c => c.filter(i => i.t === 'sec').map(i => i.label)));
  const prices = DEFAULT_PRICE_MENU.pages.flatMap(p => p.cols.flatMap(c => c.filter(i => i.t === 'row').map(i => i.pr)));
  assert.deepEqual(secs, ['Manicures', 'Full Sets & Fills', 'Color & Add-Ons', 'Pedicures', 'Pedicure Add-Ons', 'Waxing']);
  assert.equal(prices.length, 20);
  assert.deepEqual(prices, ['$25', '$35', '$45', '$55 / 45', '$50', '$65 / 55', '$15', '$25', 'from $5', 'from $7', '$10', '$33', '$45', '$60', '$13', '$7', '$15', '$10', '$20', '$40 / 60']);
});
test('a structurally-valid but content-empty config falls back to the default (never blank)', () => {
  const m = normalizePriceMenu({ v: 1, pages: [{ title: 'x', cols: [[], []], foot: [] }] });
  assert.ok(m.pages.some(p => p.cols.some(c => c.length)), 'content-empty config rendered the default instead of a blank menu');
});

// ── priceMenuSearch(menu, query) — the desk "how much is X?" lookup (Phase 3) ──
import { priceMenuSearch } from '../js/app/features/guide.js';
const tieredMenu = () => ({ v: 1, pages: [{ title: 'Hands', cols: [[
  { t: 'sec', label: 'Full Sets' },
  { t: 'row', nm: 'Acrylic', pr: '', variants: [{ nm: 'Full set', pr: '$56' }, { nm: 'Fill', pr: '$46' }] },
  { t: 'row', nm: 'Gel Manicure', pr: '$38', addons: [{ nm: 'French tip', pr: '$7' }, { nm: 'Chrome', pr: '$10' }] },
], []], foot: [] }] });

test('priceMenuSearch: a matching service returns it plus its variants and add-ons', () => {
  const r = priceMenuSearch(tieredMenu(), 'acrylic');
  assert.ok(r.find(x => x.label === 'Acrylic'));
  assert.ok(r.find(x => /Full set/.test(x.label) && x.price === '$56'));
  assert.ok(r.find(x => /Fill/.test(x.label) && x.price === '$46'));
});
test('priceMenuSearch: an add-on is findable by its own name even if the parent does not match', () => {
  const r = priceMenuSearch(tieredMenu(), 'french');
  const hit = r.find(x => /French tip/.test(x.label));
  assert.ok(hit && hit.price === '$7');
});
test('priceMenuSearch: carries the section for context, and empty query returns nothing', () => {
  assert.deepEqual(priceMenuSearch(tieredMenu(), ''), []);
  const r = priceMenuSearch(tieredMenu(), 'gel');
  assert.equal(r[0].section, 'Full Sets');       // Gel Manicure sits under the last-seen section
  assert.equal(r.find(x => x.label === 'Gel Manicure').price, '$38');
});
test('priceMenuSearch: tolerant of a malformed menu (no throw)', () => {
  assert.doesNotThrow(() => priceMenuSearch(null, 'x'));
  assert.deepEqual(priceMenuSearch({}, 'x'), []);
});

// ── Subheaders (v5.74): a 3rd node type `t:'sub'` — a secondary heading under a section ──
test('a subheader normalizes to {t:sub,label} and renders as .subhead (print)', () => {
  const m = normalizePriceMenu({ v: 1, pages: [{ title: 'T', cols: [[
    { t: 'sec', label: 'Manicures' },
    { t: 'sub', label: 'Gel options' },
    { t: 'row', nm: 'Gel Manicure', pr: '$38' },
  ], []], foot: [] }] });
  const sub = m.pages[0].cols[0][1];
  assert.equal(sub.t, 'sub');
  assert.equal(sub.label, 'Gel options');
  assert.ok(sub.id, 'subheader gets an id');
  const h = render(m);
  assert.match(h, /<div class="subhead">Gel options<\/div>/);
  assert.ok(h.indexOf('class="sec"') < h.indexOf('class="subhead"') && h.indexOf('class="subhead"') < h.indexOf('Gel Manicure'), 'section → subhead → row order');
});
test('a subheader label is escaped once (print)', () => {
  const h = render(normalizePriceMenu({ v: 1, pages: [{ title: 'T', cols: [[{ t: 'sub', label: 'Pink & White' }, { t: 'row', nm: 'x', pr: '$1' }], []], foot: [] }] }));
  assert.match(h, /<div class="subhead">Pink &amp; White<\/div>/);
  assert.ok(!h.includes('&amp;amp;'));
});
