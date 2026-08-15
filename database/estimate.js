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

/* Fraction of a tier still posting, per platform. Size-dependent: a
   1M-subscriber channel is almost certainly active, a 50-follower one almost
   certainly is not. See `activity` in estimate.json for the sources. */
function act(tier, platform) {
  if (!E.activity) return 1;
  var t = E.activity.by_tier[tier];
  var p = E.activity.by_platform[platform];
  return (t == null ? 1 : t) * (p == null ? 1 : p);
}
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

/* ----------------------------------------------------------------------------
   Band mode: a range rather than a cumulative tier.

   "1 to 10k" is not a row in the ladder — the ladder is cumulative. The band
   is built by summing the slices between adjacent tiers, applying each slice's
   own pass and activity rates, because neither rate is constant across the
   range: the bottom is where almost all the spam is, and also where almost
   everything is abandoned.
   ---------------------------------------------------------------------------- */
const FROM = val('--from', '');
const TO = val('--to', '');
if (FROM || TO) {
  const a = FROM || tiers[0];
  const b = TO || tiers[tiers.length - 1];
  if (!tiers.includes(a) || !tiers.includes(b)) {
    console.error('Tiers are: ' + tiers.join(', '));
    process.exit(1);
  }
  const adj = t => (E.pass_rate_by_tier && E.pass_rate_by_tier[t] != null) ? E.pass_rate_by_tier[t] : 1;
  const at = (t, k, bound) => E.platforms[k].tiers[t][bound];

  /* ------------------------------------------------------------------------
     Sum the sub-bands. Do NOT difference two cumulative rows.

     The first version computed the band as active(1+) minus active(10k+),
     which is wrong the moment each row is scaled by a different rate: the 1+
     row applied the bottom-tier activity rate of 12% to all 61.2M YouTube
     channels, including the 10k+ ones that are 60% active. Subtracting two
     numbers scaled by different factors produces a figure that means nothing.
     It reported 1M active YouTube channels in the 1-to-10k band when the real
     answer is around ten times that.

     Differencing is only valid for the raw populations, which are genuine
     cumulative counts. Every rate has to be applied to the slice it belongs
     to, then the slices summed.
     ------------------------------------------------------------------------ */
  const ai = tiers.indexOf(a), bi = tiers.indexOf(b);
  const slices = [];
  for (let x = ai; x < bi; x++) slices.push([tiers[x], tiers[x + 1]]);

  function sumOver(k, bound, withPass, withActive) {
    let total = 0;
    for (const [lo, hi] of slices) {
      /* Channels in [lo, hi) — a real cumulative difference, which is fine. */
      const count = at(lo, k, bound) - at(hi, k, bound);
      let v = count;
      if (withPass) v *= E.pass_rates[k][bound] * adj(lo);
      if (withActive) v *= act(lo, k);
      total += v;
    }
    return total;
  }

  let exist = 0, pass = 0, pLow = 0, pHigh = 0, live = 0, lLow = 0, lHigh = 0;
  const rows = [];
  for (const [k, p] of platforms) {
    const e = sumOver(k, 'mid', false, false);
    const f = sumOver(k, 'mid', true, false);
    const g = sumOver(k, 'mid', true, true);
    exist += e; pass += f; live += g;
    pLow += sumOver(k, 'low', true, false);
    pHigh += sumOver(k, 'high', true, false);
    lLow += sumOver(k, 'low', true, true);
    lHigh += sumOver(k, 'high', true, true);
    rows.push([p.label, e, f, g]);
  }

  console.log('');
  console.log('  CHANNELS BETWEEN ' + a.replace('+', '') + ' AND ' + b.replace('+', '') + ' FOLLOWERS');
  rule();
  console.log('');
  console.log('    ' + lpad(human(sig(exist)), 8) + '   exist');
  console.log('    ' + lpad(human(sig(pass)), 8) + '   would pass the filter   (' +
    Math.round((pass / exist) * 100) + '%)');
  console.log('    ' + lpad(human(sig(live)), 8) + '   ...and still post       (' +
    Math.round((live / exist) * 100) + '% of all, ' + Math.round((live / pass) * 100) + '% of those that pass)');
  console.log('');
  console.log('    band on the filtered figure: ' + human(sig(pLow)) + ' to ' + human(sig(pHigh)));
  console.log('    band on the active figure:   ' + human(sig(lLow)) + ' to ' + human(sig(lHigh)));
  console.log('');
  rule();
  console.log('  BY PLATFORM');
  console.log('');
  console.log('  ' + pad('platform', 14) + lpad('exist', 12) + lpad('pass', 12) + lpad('active', 12) + lpad('active %', 10));
  console.log('  ' + '·'.repeat(60));
  for (const [label, e, f, g] of rows) {
    console.log('  ' + pad(label, 14) + lpad(human(sig(e)), 12) + lpad(human(sig(f)), 12) +
      lpad(human(sig(g)), 12) + lpad(Math.round((g / e) * 100) + '%', 10));
  }
  console.log('  ' + '·'.repeat(60));
  console.log('');
  console.log('    "Active" means at least one public upload in the last 90 days. Most');
  console.log('    channels in this range have none — they were made, used a few times');
  console.log('    and abandoned. A 2019 YouTube cohort study found 74.8% dormant,');
  console.log('    fading or gone seven years on, and that is the shape used here.');
  console.log('');
  console.log('    The pass rate is far lower here than at 10k+ because this range is');
  console.log('    where the scam channels, generators and engagement farms live. See');
  console.log('    pass_rate_by_tier in estimate.json.');
  console.log('');
  console.log('    TikTok and Instagram are most of both columns and neither can be');
  console.log('    discovered through any API, so most of this is not reachable.');
  console.log('');
  process.exit(0);
}

console.log('');
console.log('  APPROXIMATELY HOW MANY CHANNELS WOULD PASS — ' + TIER + ' followers');
rule();
console.log('');
console.log('  ' + pad('platform', 12) + lpad('exist', 12) + lpad('pass rate', 12) + lpad('would pass', 14) + '   confidence');
console.log('  ' + '·'.repeat(72));

/* The tier multiplier is the whole reason the bottom of the distribution is
   not simply "more of the same". See pass_rate_by_tier in estimate.json. */
const tierAdj = t => (E.pass_rate_by_tier && E.pass_rate_by_tier[t] != null) ? E.pass_rate_by_tier[t] : 1;

let totLow = 0, totMid = 0, totHigh = 0;
for (const [key, p] of platforms) {
  const t = p.tiers[TIER];
  const r = E.pass_rates[key];
  const adj = tierAdj(TIER);
  const low = t.low * r.low * adj, mid = t.mid * r.mid * adj, high = t.high * r.high * adj;
  totLow += low; totMid += mid; totHigh += high;

  console.log('  ' + pad(p.label, 12) +
    lpad(human(t.mid), 12) +
    lpad(Math.round(r.mid * adj * 100) + '%', 12) +
    lpad(human(sig(mid)), 14) +
    '   ' + p.confidence);
}
console.log('  ' + '·'.repeat(72));
console.log('  ' + pad('all four', 12) + lpad('', 12) + lpad('', 12) + lpad(human(sig(totMid)), 14));
console.log('');
console.log('    Somewhere between ' + human(sig(totLow)) + ' and ' + human(sig(totHigh)) +
            '. Call it ' + human(sig(totMid)) + '.');
if (tierAdj(TIER) < 1) {
  console.log('    Pass rates are cut to ' + Math.round(tierAdj(TIER) * 100) + '% of the headline figure at this tier —');
  console.log('    see "the bottom of the distribution" below.');
}
console.log('');

/* Where each number came from. A measured percentile and a number somebody
   made up should never look alike in the same table. */
console.log('  Provenance at ' + TIER + ':');
for (const [, p] of platforms) {
  console.log('    ' + pad(p.label, 12) + (p.tiers[TIER].source || 'unstated'));
}
console.log('');

/* --------------------------------------------------------------------------
   The whole ladder, because the shape is the point
   -------------------------------------------------------------------------- */
rule();
console.log('  THE WHOLE LADDER — how many would pass at every tier');
console.log('');
console.log('  ' + pad('tier', 8) + platforms.map(([, p]) => lpad(p.label, 12)).join('') + lpad('total', 12));
console.log('  ' + '·'.repeat(72));
for (const t of tiers) {
  const adj = tierAdj(t);
  let sum = 0;
  const cells = platforms.map(([k, p]) => {
    const v = p.tiers[t].mid * E.pass_rates[k].mid * adj;
    sum += v;
    return lpad(human(sig(v)), 12);
  });
  console.log('  ' + pad(t, 8) + cells.join('') + lpad(human(sig(sum)), 12) + (t === TIER ? '   <-' : ''));
}
console.log('  ' + '·'.repeat(72));
console.log('');
console.log('    Each row is cumulative: "1k+" contains everything in "10k+".');
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
rule();
console.log('  THE BOTTOM OF THE DISTRIBUTION');
console.log('');
console.log('    Going below 1k followers does not just add volume — it changes what');
console.log('    the filter is for. Scam channels, generators, engagement farms and');
console.log('    abandoned spam are cheap to create and they all live at 1-500');
console.log('    followers. So pass rates are scaled down there:');
console.log('');
for (const t of tiers) {
  const a = tierAdj(t);
  console.log('      ' + pad(t, 8) + lpad(Math.round(a * 100) + '%', 6) + ' of the headline pass rate' +
    (a === 1 ? '' : '   <- adjusted'));
}
console.log('');
console.log('    Those multipliers are judgement, not measurement. Unlike the');
console.log('    population figures they can be settled cheaply: measure ten thousand');
console.log('    real channels and the true rate is in build-report.json.');
console.log('');
console.log('    Worth saying plainly: at 1+ follower the YouTube figure is 61.2M');
console.log('    channels, against ~113.9M on the platform. The 50M gap is channels');
console.log('    with no subscriber at all, which no useful database contains.');
console.log('');
