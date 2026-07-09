// Manual (no-terminal) checkout records the chosen tender so reports split cash vs card.
// tendersFor is the money-mapping behind both the one-tap Mark paid and the adjust form.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tendersFor } from '../js/app/features/square-pos.js';

test('tendersFor: records the chosen tender (cash / zelle / card)', () => {
  assert.deepEqual(tendersFor('cash', 50), { cash: 50 });
  assert.deepEqual(tendersFor('zelle', 40), { zelle: 40 });
  // manual "card" = the salon's own outside terminal → lands in the Card report bucket
  assert.deepEqual(tendersFor('card', 75), { card: 75 });
});

test('tendersFor: other / zero / missing → no tender line', () => {
  assert.deepEqual(tendersFor('other', 50), {});
  assert.deepEqual(tendersFor('cash', 0), {});
  assert.deepEqual(tendersFor('', 50), {});
});
