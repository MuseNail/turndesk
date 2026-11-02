// Phase 2a-core: the pure editor mutators that transform a draft price-menu by node id, plus the
// normalize id-stamping of pages + foot lines (so EVERYTHING is addressable by id) and the dirty check.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePriceMenu, DEFAULT_PRICE_MENU, priceMenuToHtml } from '../js/app/features/guide.js';
import {
  pmFind, pmSetField, pmAddItem, pmRemoveItem, pmMoveItem, pmRelocateItem, pmMoveTo,
  pmAddSub, pmRemoveSub, pmSetSubField, pmAddFoot, pmRemoveFoot, pmSetFoot, pmIsDirty,
  pmFlatten, pmDropTarget, pmGroupSpan, pmSectionRowCount, pmRemoveSection,
} from '../js/app/features/pricemenu-editor.js';

const draft = () => normalizePriceMenu(null);   // the default, id-stamped
const col = (d, pi, ci) => d.pages[pi].cols[ci];

// ── normalize now stamps page + foot ids ──
test('normalize stamps a stable id on every page and foot line', () => {
  const d = draft();
  assert.ok(d.pages[0].id, 'page has id');
  assert.ok(d.pages[0].foot.every(f => f.id), 'every foot line has id');
});

// ── pmFind ──
test('pmFind locates items, variants/addons, foots, and pages; null on miss', () => {
  const d = draft();
  const row = col(d, 0, 0).find(i => i.t === 'row');
  const f = pmFind(d, row.id);
  assert.equal(f.node, row);
  assert.ok(Array.isArray(f.arr) && f.arr[f.idx] === row);
  assert.equal(pmFind(d, 'nope'), null);
});

// ── pmSetField (optional key deleted when emptied → no false dirty) ──
test('pmSetField sets a field and deletes an emptied optional desc', () => {
  const d = draft();
  const row = col(d, 0, 0).find(i => i.t === 'row');
  pmSetField(d, row.id, 'pr', '$99');
  assert.equal(row.pr, '$99');
  pmSetField(d, row.id, 'desc', 'x'); assert.equal(row.desc, 'x');
  pmSetField(d, row.id, 'desc', ''); assert.ok(!('desc' in row), 'emptied optional key removed');
});

// ── add / remove ──
test('pmAddItem inserts after an id (or appends) with a fresh id', () => {
  const d = draft();
  const c = col(d, 0, 0); const before = c.length; const anchor = c[0];
  const n = pmAddItem(d, _colId(d, 0, 0), 'row', anchor.id);
  assert.ok(n && n.id && n.t === 'row');
  assert.equal(col(d, 0, 0).length, before + 1);
  assert.equal(col(d, 0, 0)[1], n, 'inserted right after the anchor');
});
test('pmRemoveItem removes an item by id', () => {
  const d = draft();
  const c = col(d, 0, 0); const victim = c[1]; const n = c.length;
  assert.equal(pmRemoveItem(d, victim.id), true);
  assert.equal(col(d, 0, 0).length, n - 1);
  assert.ok(!col(d, 0, 0).includes(victim));
});

// ── reorder clamps at the ends ──
test('pmMoveItem swaps neighbors and is a no-op at the ends (no -1 corruption)', () => {
  const d = draft(); const c = col(d, 0, 0);
  const first = c[0], second = c[1];
  assert.equal(pmMoveItem(d, first.id, 'up'), false, 'up at top = no-op');
  assert.equal(pmMoveItem(d, c[c.length - 1].id, 'down'), false, 'down at bottom = no-op');
  assert.equal(pmMoveItem(d, first.id, 'down'), true);
  assert.equal(col(d, 0, 0)[0], second);
  assert.equal(col(d, 0, 0)[1], first);
  assert.ok(!('-1' in col(d, 0, 0)));
});

// ── relocate: a section takes its contiguous rows; a row moves alone ──
test('pmRelocateItem moves a SECTION with its contiguous rows to another column', () => {
  const d = draft();
  const src = col(d, 0, 0);
  const sec = src.find(i => i.t === 'sec');               // first section
  const secIdx = src.indexOf(sec);
  let n = 1; while (src[secIdx + n] && src[secIdx + n].t === 'row') n++;   // the section + its rows
  const groupIds = src.slice(secIdx, secIdx + n).map(i => i.id);
  const srcLen = src.length, dstLen = col(d, 0, 1).length;
  assert.equal(pmRelocateItem(d, sec.id, _colId(d, 0, 1)), true);
  assert.equal(col(d, 0, 0).length, srcLen - n, 'group left the source');
  const dst = col(d, 0, 1);
  assert.deepEqual(dst.slice(dst.length - n).map(i => i.id), groupIds, 'group appended in order to the target');
});
test('pmRelocateItem moves a ROW alone', () => {
  const d = draft();
  const row = col(d, 0, 0).find(i => i.t === 'row');
  assert.equal(pmRelocateItem(d, row.id, _colId(d, 1, 0)), true);
  assert.ok(!col(d, 0, 0).includes(row));
  assert.ok(col(d, 1, 0).includes(row));
});

// ── variants / add-ons ──
test('pmAddSub/pmRemoveSub/pmSetSubField manage a row’s variants + add-ons by id', () => {
  const d = draft();
  const row = col(d, 0, 0).find(i => i.t === 'row');
  const v = pmAddSub(d, row.id, 'variants'); assert.ok(v.id && row.variants.includes(v));
  pmSetSubField(d, v.id, 'nm', 'Full set'); assert.equal(v.nm, 'Full set');
  const a = pmAddSub(d, row.id, 'addons'); assert.ok(a.id && row.addons.includes(a));
  assert.equal(pmRemoveSub(d, v.id), true);
  assert.ok(!(row.variants || []).includes(v));
});

// ── footers ──
test('pmAddFoot/pmRemoveFoot/pmSetFoot edit a page’s footer lines by id', () => {
  const d = draft();
  const pageId = d.pages[0].id, n = d.pages[0].foot.length;
  const f = pmAddFoot(d, pageId); assert.equal(d.pages[0].foot.length, n + 1);
  pmSetFoot(d, f.id, 'text', 'New line'); assert.equal(f.text, 'New line');
  pmSetFoot(d, f.id, 'cls', 'cash'); assert.equal(f.cls, 'cash');
  assert.equal(pmRemoveFoot(d, f.id), true); assert.equal(d.pages[0].foot.length, n);
});

// ── dirty + generic N columns ──
test('pmIsDirty compares against a baseline', () => {
  const d = draft(); const base = JSON.stringify(d);
  assert.equal(pmIsDirty(d, base), false);
  pmSetField(d, col(d, 0, 0).find(i => i.t === 'row').id, 'pr', '$1');
  assert.equal(pmIsDirty(d, base), true);
});
test('a 3-column page survives a mutate (no data dropped — generic over N cols)', () => {
  const d = normalizePriceMenu({ v: 1, pages: [{ title: 'T', cols: [[{ t: 'row', nm: 'A', pr: '$1' }], [{ t: 'row', nm: 'B', pr: '$2' }], [{ t: 'row', nm: 'C', pr: '$3' }]], foot: [] }] });
  assert.equal(d.pages[0].cols.length, 3);
  pmSetField(d, pmFind(d, d.pages[0].cols[2][0].id).node.id, 'pr', '$9');
  assert.equal(d.pages[0].cols.length, 3, 'third column preserved');
  assert.doesNotThrow(() => priceMenuToHtml(d, '<img>', s => s));
});

// helper: resolve a column's id (cols don't carry ids; the editor addresses a column by page id + index)
function _colId(d, pi, ci) { return d.pages[pi].id + ':' + ci; }

test('pmRemoveSection deletes a section WITH its contiguous services', async () => {
  const { pmRemoveSection } = await import('../js/app/features/pricemenu-editor.js');
  const d = draft();
  const src = col(d, 0, 0);
  const sec = src.find(i => i.t === 'sec');
  const secIdx = src.indexOf(sec);
  let n = 1; while (src[secIdx + n] && src[secIdx + n].t === 'row') n++;
  const before = src.length;
  assert.equal(pmRemoveSection(d, sec.id), n, 'returns count removed');
  assert.equal(col(d, 0, 0).length, before - n);
  assert.ok(!col(d, 0, 0).includes(sec));
  assert.equal(pmRemoveSection(d, col(d, 0, 0).find(i => i.t === 'row').id), 0, 'returns 0 on a non-section');
});

test('pmMoveTo places a node before a target (same or other column), section carries its rows, self-drop is a no-op', async () => {
  const { pmMoveTo } = await import('../js/app/features/pricemenu-editor.js');
  // reorder within a column: move the 2nd item before the 1st
  let d = draft();
  let c = col(d, 0, 0); const a = c[0], b = c[1];
  assert.equal(pmMoveTo(d, b.id, _colId(d, 0, 0), a.id), true);
  assert.equal(col(d, 0, 0)[0], b, 'b inserted before a');
  assert.equal(col(d, 0, 0)[1], a);
  // move a row to another column, before a specific card
  d = draft();
  const row = col(d, 0, 0).find(i => i.t === 'row');
  const target = col(d, 0, 1)[1];
  assert.equal(pmMoveTo(d, row.id, _colId(d, 0, 1), target.id), true);
  const dst = col(d, 0, 1);
  assert.equal(dst[dst.indexOf(row) + 1], target, 'row sits right before the target');
  assert.ok(!col(d, 0, 0).includes(row));
  // move a SECTION before a target in another column → carries its contiguous rows as a group, in order
  d = draft();
  const src = col(d, 0, 0); const sec = src.find(i => i.t === 'sec'); const si = src.indexOf(sec);
  let n = 1; while (src[si + n] && src[si + n].t === 'row') n++;
  const groupIds = src.slice(si, si + n).map(i => i.id);
  const tgt = col(d, 0, 1)[0];
  assert.equal(pmMoveTo(d, sec.id, _colId(d, 0, 1), tgt.id), true);
  const d2 = col(d, 0, 1);
  const at = d2.indexOf(d2.find(i => i.id === groupIds[0]));
  assert.deepEqual(d2.slice(at, at + n).map(i => i.id), groupIds, 'whole section group moved in order, before the target');
  // dropping a section onto one of its own rows is a no-op
  d = draft();
  const s2 = col(d, 0, 0).find(i => i.t === 'sec');
  const ownRow = col(d, 0, 0)[col(d, 0, 0).indexOf(s2) + 1];
  const lenBefore = col(d, 0, 0).length;
  assert.equal(pmMoveTo(d, s2.id, _colId(d, 0, 0), ownRow.id), false);
  assert.equal(col(d, 0, 0).length, lenBefore, 'self-drop changed nothing');
  // append when beforeId is null
  d = draft();
  const r2 = col(d, 0, 0).find(i => i.t === 'row');
  assert.equal(pmMoveTo(d, r2.id, _colId(d, 1, 1), null), true);
  assert.equal(col(d, 1, 1)[col(d, 1, 1).length - 1], r2, 'appended to the end');
});

// ── pmFlatten + pmDropTarget (Option-B redesign: section-grouped list + model-based drag) ──
const fx = () => ({ v: 1, pages: [
  { id: 'p1', title: 'Hands', cols: [
    [ { id: 's1', t: 'sec', label: 'Manicures' }, { id: 'r1', t: 'row', nm: 'Classic', pr: '$25' }, { id: 'r2', t: 'row', nm: 'Gel', pr: '$38' } ],
    [ { id: 's2', t: 'sec', label: 'Color' }, { id: 'r3', t: 'row', nm: 'Gel Color', pr: '$25' } ],
  ], foot: [] },
  { id: 'p2', title: 'Feet', cols: [
    [ { id: 's3', t: 'sec', label: 'Pedicures' }, { id: 'r4', t: 'row', nm: 'Classic Pedi', pr: '$33' } ],
    [ { id: 'r5', t: 'row', nm: 'Loose', pr: '$5' } ],
  ], foot: [] },
]});

test('pmFlatten walks pages → columns → items in document order with colId + kind', () => {
  const f = pmFlatten(fx());
  assert.deepEqual(f.map(x => x.id), ['s1', 'r1', 'r2', 's2', 'r3', 's3', 'r4', 'r5']);
  assert.deepEqual(f.map(x => x.colId), ['p1:0', 'p1:0', 'p1:0', 'p1:1', 'p1:1', 'p2:0', 'p2:0', 'p2:1']);
  assert.equal(f.find(x => x.id === 's1').kind, 'sec');
  assert.equal(f.find(x => x.id === 'r1').kind, 'row');
  assert.equal(f.find(x => x.id === 'r4').pageId, 'p2');
});

test('pmDropTarget: reorder within a column (before a row)', () => {
  assert.deepEqual(pmDropTarget(fx(), 'r2', 'r1', true), { colId: 'p1:0', beforeId: 'r1', crossPage: false });
});
test('pmDropTarget: dropping after the last row in a column appends (beforeId null)', () => {
  assert.deepEqual(pmDropTarget(fx(), 'r1', 'r2', false), { colId: 'p1:0', beforeId: null, crossPage: false });
});
test('pmDropTarget: move across the hidden column boundary, same page (not cross-page)', () => {
  assert.deepEqual(pmDropTarget(fx(), 'r1', 'r3', true), { colId: 'p1:1', beforeId: 'r3', crossPage: false });
});
test('pmDropTarget: a cross-PAGE target is flagged', () => {
  assert.deepEqual(pmDropTarget(fx(), 'r1', 'r4', true), { colId: 'p2:0', beforeId: 'r4', crossPage: true });
});
test('pmDropTarget: before a section header lands before the section; after it lands inside (before first row)', () => {
  assert.deepEqual(pmDropTarget(fx(), 'r3', 's1', true), { colId: 'p1:0', beforeId: 's1', crossPage: false });
  assert.deepEqual(pmDropTarget(fx(), 'r3', 's1', false), { colId: 'p1:0', beforeId: 'r1', crossPage: false });
});
test('pmDropTarget: drop at the end of the last page appends to that column', () => {
  assert.deepEqual(pmDropTarget(fx(), 'r1', 'r5', false), { colId: 'p2:1', beforeId: null, crossPage: true });
});
test('pmDropTarget: self-drop, a zero-row/sentinel over, and an unknown id are defined no-ops (null)', () => {
  assert.equal(pmDropTarget(fx(), 'r1', 'r1', true), null);       // self
  assert.equal(pmDropTarget(fx(), 'r1', 'nope', true), null);     // sentinel / unknown over-id
  assert.equal(pmDropTarget(fx(), null, 'r1', true), null);
});
test('pmDropTarget + pmMoveTo compose: a within-column reorder actually moves the node', () => {
  const d = fx();
  const t = pmDropTarget(d, 'r2', 'r1', true);   // move r2 before r1
  pmMoveTo(d, 'r2', t.colId, t.beforeId);
  assert.deepEqual(d.pages[0].cols[0].map(x => x.id), ['s1', 'r2', 'r1']);
});

// ── Subheaders (v5.74): pmAddItem makes a 'sub' node; pmFlatten tags it kind:'sub' ──
test('pmAddItem creates a subheader node, and pmFlatten reports it as kind sub', () => {
  const d = fx();
  const node = pmAddItem(d, 'p1:0', 'sub', 's1');   // add a subheader right after section s1
  assert.equal(node.t, 'sub');
  assert.equal(node.label, '');
  assert.ok(node.id);
  assert.equal(d.pages[0].cols[0][1].id, node.id, 'inserted right after s1');
  assert.equal(pmFlatten(d).find(x => x.id === node.id).kind, 'sub');
});

// ── v5.84: move/delete group span must carry a section's SUBHEADERS + their rows, not just contiguous rows ──
// Fixture: section s1 = [s1, r1, sub u1, r2]  (u1 is a subheader INSIDE the section), then section s2 = [s2, r3].
const subFx = () => ({ v: 1, pages: [
  { id: 'p1', title: 'Hands', cols: [
    [ { id: 's1', t: 'sec', label: 'Manicures' },
      { id: 'r1', t: 'row', nm: 'Classic', pr: '$25' },
      { id: 'u1', t: 'sub', label: 'Premium' },
      { id: 'r2', t: 'row', nm: 'Gel', pr: '$38' },
      { id: 's2', t: 'sec', label: 'Color' },
      { id: 'r3', t: 'row', nm: 'Gel Color', pr: '$25' } ],
    [ { id: 'r9', t: 'row', nm: 'Other', pr: '$5' } ],
  ], foot: [] },
]});
const _p1c0 = d => d.pages[0].cols[0];
const _p1c1 = d => d.pages[0].cols[1];

test('pmGroupSpan: a section spans to the next section (covers interleaved subheaders + their rows)', () => {
  const arr = subFx().pages[0].cols[0];
  assert.equal(pmGroupSpan(arr, 0), 4, 's1 + r1 + u1 + r2 (stops at s2)');
  assert.equal(pmGroupSpan(arr, 4), 2, 's2 + r3 (to end)');
});
test('pmGroupSpan: a subheader spans its following rows (stops at the next sub/sec)', () => {
  const arr = subFx().pages[0].cols[0];
  assert.equal(pmGroupSpan(arr, 2), 2, 'u1 + r2 (stops at s2)');
});
test('pmGroupSpan: a lone row is a group of 1', () => {
  assert.equal(pmGroupSpan(subFx().pages[0].cols[1], 0), 1);
});

test('pmRelocateItem moves a SECTION with its interleaved subheader + rows (not just contiguous rows)', () => {
  const d = subFx();
  assert.equal(pmRelocateItem(d, 's1', 'p1:1'), true);
  assert.deepEqual(_p1c0(d).map(i => i.id), ['s2', 'r3'], 'only the second section is left behind');
  assert.deepEqual(_p1c1(d).map(i => i.id), ['r9', 's1', 'r1', 'u1', 'r2'], 'whole section block carried in order');
});
test('pmMoveTo moves a SECTION with its interleaved subheader + rows, before a target', () => {
  const d = subFx();
  assert.equal(pmMoveTo(d, 's1', 'p1:1', 'r9'), true);
  assert.deepEqual(_p1c1(d).map(i => i.id), ['s1', 'r1', 'u1', 'r2', 'r9'], 'block landed before r9, in order');
  assert.deepEqual(_p1c0(d).map(i => i.id), ['s2', 'r3']);
});
test('pmRelocateItem moves a SUBHEADER with its following rows (carries its group)', () => {
  const d = subFx();
  assert.equal(pmRelocateItem(d, 'u1', 'p1:1'), true);
  assert.deepEqual(_p1c0(d).map(i => i.id), ['s1', 'r1', 's2', 'r3'], 'u1 + r2 left the source');
  assert.deepEqual(_p1c1(d).map(i => i.id), ['r9', 'u1', 'r2'], 'subheader carried its row');
});
test('pmRemoveSection deletes a section WITH its interleaved subheader + rows', () => {
  const d = subFx();
  assert.equal(pmRemoveSection(d, 's1'), 4, 'removed s1 + r1 + u1 + r2');
  assert.deepEqual(_p1c0(d).map(i => i.id), ['s2', 'r3']);
});
test('pmSectionRowCount counts only the service rows in a section group (excludes the subheader)', () => {
  const d = subFx();
  assert.equal(pmSectionRowCount(d, 's1'), 2, 'r1 + r2, not the u1 subheader heading');
  assert.equal(pmSectionRowCount(d, 's2'), 1, 'r3');
  assert.equal(pmSectionRowCount(d, 'r1'), 0, 'non-section → 0');
});
test('pmGroupSpan edge cases: multiple subheaders, a trailing sub, and a sub with no rows', () => {
  // sec s1 owns two subheaders (u1 with rows, u2 trailing at the end, no rows); sub u2 is last.
  const arr = [
    { id: 's1', t: 'sec', label: 'A' },
    { id: 'r1', t: 'row', nm: 'x', pr: '$1' },
    { id: 'u1', t: 'sub', label: 'U1' },
    { id: 'r2', t: 'row', nm: 'y', pr: '$2' },
    { id: 'u2', t: 'sub', label: 'U2' },
  ];
  assert.equal(pmGroupSpan(arr, 0), 5, 'section carries BOTH subheaders + all rows to the end');
  assert.equal(pmGroupSpan(arr, 2), 2, 'u1 + r2 (stops at u2)');
  assert.equal(pmGroupSpan(arr, 4), 1, 'u2 is last → carries itself alone');
  // sub immediately followed by a sec → carries zero rows
  const arr2 = [{ id: 'u', t: 'sub', label: 'U' }, { id: 's', t: 'sec', label: 'S' }];
  assert.equal(pmGroupSpan(arr2, 0), 1, 'sub directly before a section carries only itself');
});
