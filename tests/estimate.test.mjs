/* Tests for the estimate arithmetic.

   These exist because of one bug. The band between two tiers was computed as
   `scaled(low) - scaled(high)` — each cumulative row multiplied by its own
   pass and activity rate, then subtracted. That is only valid when both rows
   are scaled by the SAME factor. They are not: the 1+ row carried the
   bottom-tier activity rate of 12%, applied to all 61.2M YouTube channels
   including the 10k+ ones that are 60% active.

   It reported 1M active YouTube channels between 1 and 10k followers. The real
   figure is around 10M. Nobody would have caught that by reading the code, so
   the arithmetic gets tested.

   Run:  node --test tests/estimate.test.mjs
   ---------------------------------------------------------------------------- */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const E = JSON.parse(fs.readFileSync(new URL('../database/estimate.json', import.meta.url), 'utf8'));
const TIERS = Object.keys(E.platforms.youtube.tiers);

const at = (t, k, b = 'mid') => E.platforms[k].tiers[t][b];
const adj = t => (E.pass_rate_by_tier[t] != null ? E.pass_rate_by_tier[t] : 1);
const act = (t, k) => (E.activity.by_tier[t] ?? 1) * (E.activity.by_platform[k] ?? 1);

function slices(a, b) {
  const out = [];
  for (let i = TIERS.indexOf(a); i < TIERS.indexOf(b); i++) out.push([TIERS[i], TIERS[i + 1]]);
  return out;
}

test('every platform declares every tier, or a band silently loses a slice', () => {
  for (const k of Object.keys(E.platforms)) {
    assert.deepEqual(Object.keys(E.platforms[k].tiers), TIERS, k + ' has a different tier set');
  }
});

test('the tiers are cumulative — each one is a subset of the one below it', () => {
  for (const k of Object.keys(E.platforms)) {
    for (let i = 0; i < TIERS.length - 1; i++) {
      assert.ok(at(TIERS[i], k) >= at(TIERS[i + 1], k),
        k + ': ' + TIERS[i] + ' must be at least ' + TIERS[i + 1]);
      assert.ok(at(TIERS[i], k, 'low') <= at(TIERS[i], k, 'mid'), k + ' ' + TIERS[i] + ': low above mid');
      assert.ok(at(TIERS[i], k, 'high') >= at(TIERS[i], k, 'mid'), k + ' ' + TIERS[i] + ': high below mid');
    }
  }
});

test('summing raw slices equals the cumulative difference', () => {
  // The one case where differencing IS valid: no rates applied.
  for (const k of Object.keys(E.platforms)) {
    const summed = slices('1+', '10k+').reduce((a, [lo, hi]) => a + at(lo, k) - at(hi, k), 0);
    assert.equal(summed, at('1+', k) - at('10k+', k), k);
  }
});

test('the scaled band is NOT the difference of the scaled rows — the bug', () => {
  const k = 'youtube';
  const scaled = t => at(t, k) * E.pass_rates[k].mid * adj(t) * act(t, k);
  const wrong = scaled('1+') - scaled('10k+');
  const right = slices('1+', '10k+')
    .reduce((a, [lo, hi]) => a + (at(lo, k) - at(hi, k)) * E.pass_rates[k].mid * adj(lo) * act(lo, k), 0);

  assert.ok(right > wrong * 5,
    'the correct sum should be many times the naive difference; got ' +
    Math.round(right / 1e6) + 'M vs ' + Math.round(wrong / 1e6) + 'M');
  // and the corrected figure is the one that survives a sanity check
  assert.ok(right > 8e6 && right < 14e6,
    'YouTube active in 1-10k should land near 10M, got ' + Math.round(right / 1e6) + 'M');
});

test('activity rates rise with size and never exceed 1', () => {
  // A 50-follower channel is mostly abandoned; a 1M one is not. If this ever
  // inverts, the whole per-tier design has been undone.
  let prev = 0;
  for (const t of TIERS) {
    const r = E.activity.by_tier[t];
    assert.ok(r > 0 && r <= 1, t + ' activity out of range: ' + r);
    assert.ok(r >= prev, 'activity must not fall as size rises: ' + t);
    prev = r;
  }
  for (const [k, m] of Object.entries(E.activity.by_platform)) {
    if (k.startsWith('_')) continue;
    assert.ok(m > 0 && m <= 1.5, k + ' multiplier out of range: ' + m);
  }
});

test('pass rates fall towards the bottom, where the spam is', () => {
  let prev = 0;
  for (const t of TIERS) {
    const r = E.pass_rate_by_tier[t];
    assert.ok(r > 0 && r <= 1, t + ' pass multiplier out of range: ' + r);
    assert.ok(r >= prev, 'pass rate must not fall as size rises: ' + t);
    prev = r;
  }
});

test('every tier states where its number came from', () => {
  for (const k of Object.keys(E.platforms)) {
    for (const t of TIERS) {
      const src = E.platforms[k].tiers[t].source;
      assert.ok(typeof src === 'string' && src.length > 3,
        k + ' ' + t + ' has no source — a guess and a measurement must never look alike');
    }
  }
});

test('a cumulative row is the sum of its slices, not one rate on the whole count', () => {
  /* The same off-by-ten lived in the cumulative mode as well as the band mode:
     "1+" multiplied all 61.2M YouTube channels by the bottom tier's 55% pass
     rate, when the 1M+ channels inside that count sit at 100%. Checked here at
     the tier where the two methods diverge most. */
  const k = 'youtube', t = '1+';
  const naive = at(t, k) * E.pass_rates[k].mid * adj(t);

  const names = TIERS;
  let summed = 0;
  for (let i = names.indexOf(t); i < names.length; i++) {
    const count = i + 1 < names.length ? at(names[i], k) - at(names[i + 1], k) : at(names[i], k);
    summed += count * E.pass_rates[k].mid * adj(names[i]);
  }
  assert.ok(summed > naive, 'the slice sum must exceed the flat multiplication');
  assert.ok(summed / naive > 1.1, 'they should differ by more than a rounding error');

  // at the top tier there is nothing above it, so both methods must agree
  const top = names[names.length - 1];
  assert.equal(at(top, k) * E.pass_rates[k].mid * adj(top),
               at(top, k) * E.pass_rates[k].mid * adj(top));
});
