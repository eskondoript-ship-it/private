#!/usr/bin/env node
/* Approximation — how many channels probably exist that would pass
   ============================================================================
   count.js answers "how many do I have". This answers "how many are out
   there", which is a different question and a much softer one.

   It is a Fermi estimate: population anchors from public reporting, times the
   fraction expected to survive the safety rules. Every input is in
   estimate.json with a low/high band, and the output carries the band because
   the midpoint on its own is false precision.

   Nothing here is measured. The measured numbers are in build-report.json and
   are several orders of magnitude smaller — that gap is the point, and the
   last section of the output is about it.

   Usage
     node database/estimate.js
     node database/estimate.js --tier 10k+
     node database/estimate.js --tier 100k+ --platform youtube
   ---------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const E = JSON.parse(fs.readFileSync(path.join(HERE, 'estimate.json'), 'utf8'));
const TIER = val('--tier', '10k+');
const ONLY = val('--platform', '');

let report = null;
try { report = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'build-report.json'), 'utf8')); } catch (e) { }

const n = v => Math.round(v).toLocaleString('en-US');
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const rule = () => console.log('  ' + '─'.repeat(72));

/* Round to two significant figures. Printing "23,847,193 channels" from inputs
   that are themselves guesses invents a precision the estimate does not have. */
function sig(v) {
  if (v <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
}

function human(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

const platforms = Object.entries(E.platforms).filter(([k]) => !ONLY || k === ONLY);
if (!platforms.length) {
  console.error('Unknown platform. One of: ' + Object.keys(E.platforms).join(', '));
  process.exit(1);
}

const tiers = Object.keys(E.platforms.youtube.tiers);
if (!tiers.includes(TIER)) {
  console.error('Unknown tier. One of: ' + tiers.join(', '));
  process.exit(1);
}

console.log('');
console.log('  APPROXIMATELY HOW MANY CHANNELS WOULD PASS — ' + TIER + ' followers');
rule();
console.log('');
console.log('  ' + pad('platform', 12) + lpad('exist', 12) + lpad('pass rate', 12) + lpad('would pass', 14) + '   confidence');
console.log('  ' + '·'.repeat(72));

let totLow = 0, totMid = 0, totHigh = 0;
for (const [key, p] of platforms) {
  const t = p.tiers[TIER];
  const r = E.pass_rates[key];
  const low = t.low * r.low, mid = t.mid * r.mid, high = t.high * r.high;
  totLow += low; totMid += mid; totHigh += high;

  console.log('  ' + pad(p.label, 12) +
    lpad(human(t.mid), 12) +
    lpad(Math.round(r.mid * 100) + '%', 12) +
    lpad(human(sig(mid)), 14) +
    '   ' + p.confidence);
}
console.log('  ' + '·'.repeat(72));
console.log('  ' + pad('all four', 12) + lpad('', 12) + lpad('', 12) + lpad(human(sig(totMid)), 14));
console.log('');
console.log('    Somewhere between ' + human(sig(totLow)) + ' and ' + human(sig(totHigh)) +
            '. Call it ' + human(sig(totMid)) + '.');
console.log('');

/* --------------------------------------------------------------------------
   The part that actually decides what you can build
   -------------------------------------------------------------------------- */
rule();
console.log('  HOW MANY OF THEM YOU CAN ACTUALLY MEASURE');
console.log('');
console.log('  ' + pad('platform', 12) + lpad('per day', 12) + '   why');
console.log('  ' + '·'.repeat(72));
let perDay = 0;
for (const [key, p] of platforms) {
  const r = E.reachable[key];
  perDay += r.per_day;
  console.log('  ' + pad(p.label, 12) + lpad(r.per_day ? human(r.per_day) : 'none', 12) + '   ' + r.why);
}
console.log('  ' + '·'.repeat(72));
console.log('');

const measured = report ? (report.in_database || 0) + (report.needs_review || 0) + (report.rejected || 0) : 0;
const coverage = totMid > 0 ? (measured / totMid) * 100 : 0;

console.log('    measured so far      ' + n(measured) + (report && report.offline ? '   (fixtures, not real)' : ''));
console.log('    reachable per day    ' + n(perDay));
console.log('    estimated population ' + human(sig(totMid)));
console.log('    coverage             ' + (coverage < 0.001 ? '<0.001' : coverage.toFixed(3)) + '%');
console.log('');

/* Time-to-cover has to be computed per platform. Dividing the whole population
   by the combined daily rate quietly assumes the TikTok and Instagram millions
   are reachable at the Twitch rate, which produces a confident number for
   something that will never happen. */
let unreachable = 0;
console.log('    time to cover, per platform');
for (const [key, p] of platforms) {
  const pop = p.tiers[TIER].mid * E.pass_rates[key].mid;
  const rate = E.reachable[key].per_day;
  if (!rate) {
    unreachable += pop;
    console.log('      ' + pad(p.label, 12) + 'never — there is no endpoint to call');
    continue;
  }
  const days = pop / rate;
  console.log('      ' + pad(p.label, 12) +
    (days < 1 ? 'under a day' : days > 730 ? Math.round(days / 365) + ' years' : Math.ceil(days) + ' days'));
}
console.log('');
if (unreachable > 0) {
  const share = Math.round((unreachable / totMid) * 100);
  console.log('    ' + human(sig(unreachable)) + ' of the ' + human(sig(totMid)) + ' — about ' + share +
    '% — sit on platforms');
  console.log('    with no discovery endpoint at all. No amount of time or quota');
  console.log('    reaches them; they can only arrive by their owners connecting.');
  console.log('');
  /* Which platform dominates the reachable share depends on the tier, so it is
     computed rather than asserted — at 10k+ it is YouTube by a wide margin,
     and a hard-coded "Twitch is most of it" was simply false. */
  const reach = platforms
    .filter(([k]) => E.reachable[k].per_day > 0)
    .map(([k, p]) => ({ label: p.label, pop: p.tiers[TIER].mid * E.pass_rates[k].mid }))
    .sort((a, b) => b.pop - a.pop);
  if (reach.length) {
    const top = reach[0];
    console.log('    Of the ' + human(sig(totMid - unreachable)) + ' that is reachable, ' + top.label +
      ' is ' + Math.round((top.pop / (totMid - unreachable)) * 100) + '% —');
    console.log('    but it is the slow one. Twitch is smaller and finishes in days.');
  }
}
console.log('');

rule();
console.log('  HOW MUCH TO TRUST THIS');
console.log('');
console.log('    Every number above is an assumption in database/estimate.json,');
console.log('    not a measurement. The bands are wide on purpose and TikTok and');
console.log('    Instagram are marked low confidence because no public creator');
console.log('    census exists for either.');
console.log('');
console.log('    The softest assumption is the pass rate. The way to firm it up is');
console.log('    to measure a few thousand real channels and read the true rate out');
console.log('    of build-report.json, then edit pass_rates in estimate.json. After');
console.log('    one real Twitch run that number stops being a guess.');
console.log('');
