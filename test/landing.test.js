import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANDING_FEATURES, getLandingFeature } from '../js/app/features/landing.js';

// The landing page's feature tiles are the marketing content the owner iterated on;
// these tests lock the shape so a future edit can't silently drop a required field or
// mis-flag a "launching soon" claim (which would put a false/overclaimed statement on
// a live public page).

const REQUIRED = ['key', 'icon', 'problem', 'solution', 'title', 'body'];

test('every feature has all required non-empty string fields', () => {
  assert.ok(Array.isArray(LANDING_FEATURES) && LANDING_FEATURES.length === 8,
    'expected 8 feature tiles');
  for (const f of LANDING_FEATURES) {
    for (const k of REQUIRED) {
      assert.equal(typeof f[k], 'string', `${f.key || '?'}.${k} should be a string`);
      assert.ok(f[k].trim().length > 0, `${f.key || '?'}.${k} should be non-empty`);
    }
  }
});

test('feature keys are unique', () => {
  const keys = LANDING_FEATURES.map(f => f.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate feature key');
});

test('exactly the intended 5 tiles carry a "soon" note; the other 3 do not', () => {
  // Grounded in the real code state verified 2026-07-14 (adversarial review):
  //  - soon:    turns (configurable fairness rule), reports (calendar half),
  //             texting (automatic triggers), booking (whole feature), ai (UI wiring)
  //  - no soon: checkin, floorplan, payments (all real today; Stripe removed entirely)
  const withSoon = new Set(LANDING_FEATURES.filter(f => f.soon && f.soon.trim()).map(f => f.key));
  assert.deepEqual([...withSoon].sort(), ['ai', 'booking', 'reports', 'texting', 'turns'].sort());
  const noSoon = LANDING_FEATURES.filter(f => !(f.soon && f.soon.trim())).map(f => f.key).sort();
  assert.deepEqual(noSoon, ['checkin', 'floorplan', 'payments'].sort());
});

test('no feature names Stripe (owner removed it — Square/Helcim only)', () => {
  for (const f of LANDING_FEATURES) {
    const blob = JSON.stringify(f).toLowerCase();
    assert.ok(!blob.includes('stripe'), `${f.key} must not mention Stripe`);
  }
});

test('getLandingFeature returns the matching feature by key', () => {
  const t = getLandingFeature('turns');
  assert.equal(t.key, 'turns');
  assert.equal(t.title, LANDING_FEATURES.find(f => f.key === 'turns').title);
});

test('getLandingFeature returns undefined for an unknown key', () => {
  assert.equal(getLandingFeature('nope'), undefined);
  assert.equal(getLandingFeature(''), undefined);
  assert.equal(getLandingFeature(), undefined);
});
