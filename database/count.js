#!/usr/bin/env node
/* How many channels match a set of parameters
   ============================================================================
   Read this first, because the number means something narrower than it looks.

   This counts channels in YOUR database — the seed list, measured and
   filtered. It is not, and cannot be, "how many channels exist on YouTube
   with these parameters". No platform offers that: there is no endpoint that
   counts channels by criteria, no endpoint that lists them, and the search
   endpoint returns a `totalResults` that Google itself documents as an
   approximation of matching *videos*, capped and unreliable, not a census of
   channels.

   So the ceiling on any number this prints is the size of the seed list. Grow
   the seed list and the ceiling grows. That is the only lever there is.

   Usage
     node database/count.js
     node database/count.js --min-followers 10000 --niche gaming
     node database/count.js --tier Micro --min-engagement 3
     node database/count.js --include-review        count review alongside allow
   ---------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');

const args = process.argv.slice(2);
const has = n => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const numArg = (n, d) => { const v = val(n, null); return v == null ? d : Number(v); };

const P = {
  platform: val('--platform', ''),
  niche: val('--niche', ''),
  tier: val('--tier', ''),
  country: val('--country', ''),
  minFollowers: numArg('--min-followers', 0),
  maxFollowers: numArg('--max-followers', 0),
  minViews: numArg('--min-median-views', 0),
  minEngagement: numArg('--min-engagement', 0),
  minUploads: numArg('--min-uploads', 0),
  minSafety: numArg('--min-safety', 0),
  includeReview: has('--include-review')
};

function read(name) {
  const f = path.join(DATA, name);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const db = read('channels.json');
const review = read('review.json');
const rejected = read('rejected.json');
const unresolved = read('unresolved.json');
const report = read('build-report.json');
const seed = JSON.parse(fs.readFileSync(path.join(HERE, 'seeds', 'channels.seed.json'), 'utf8'));
const discFile = path.join(HERE, 'seeds', 'discovered.json');
const discovered = fs.existsSync(discFile) ? JSON.parse(fs.readFileSync(discFile, 'utf8')) : { channels: [] };
const ceiling = seed.channels.length + discovered.channels.length;

if (!db) {
  console.error('No database yet. Run:  node database/build.js --offline');
  process.exit(1);
}

/* Every parameter is one line, and each reports how many it removed on its own
   — so a filter that returns nothing says which condition emptied it, instead
   of leaving you to bisect the flags by hand. */
const CONDITIONS = [
  ['platform', P.platform, c => c.platform === P.platform],
  ['niche', P.niche, c => c.niche === P.niche],
  ['tier', P.tier, c => c.tier === P.tier],
  ['country', P.country, c => c.country === P.country],
  ['min-followers', P.minFollowers, c => (c.followers || 0) >= P.minFollowers],
  ['max-followers', P.maxFollowers, c => (c.followers || 0) <= P.maxFollowers],
  ['min-median-views', P.minViews, c => (c.median_views || 0) >= P.minViews],
  ['min-engagement', P.minEngagement, c => (c.engagement_rate || 0) >= P.minEngagement],
  ['min-uploads', P.minUploads, c => (c.uploads_last_30_days || 0) >= P.minUploads],
  ['min-safety', P.minSafety, c => ((c.safety && c.safety.safety_score) || 0) >= P.minSafety]
].filter(([, v]) => v);

let pool = db.channels.slice();
if (P.includeReview && review) pool = pool.concat(review.channels);

const rows = pool.filter(c => CONDITIONS.every(([, , fn]) => fn(c)));

/* ---------------------------------------------------------------------------- */

const n = v => v.toLocaleString('en-US');
const pad = (s, w) => String(s).padEnd(w);
const line = () => console.log('  ' + '─'.repeat(58));

console.log('');
console.log('  CHANNELS MATCHING YOUR PARAMETERS');
line();
console.log('');
console.log('    ' + n(rows.length) + (rows.length === 1 ? ' channel' : ' channels'));
console.log('');

if (CONDITIONS.length) {
  console.log('  Each parameter on its own, against the ' + n(pool.length) + ' in the pool:');
  for (const [name, v, fn] of CONDITIONS) {
    const kept = pool.filter(fn).length;
    console.log('    ' + pad(name + ' ' + v, 34) + pad(n(kept) + ' kept', 13) + (pool.length - kept) + ' removed');
  }
  console.log('');
} else {
  console.log('  No parameters given, so this is the whole database.');
  console.log('');
}

line();
console.log('  WHERE THAT NUMBER COMES FROM');
console.log('');
const measured = db.channels.length + (review ? review.channels.length : 0) + (rejected ? rejected.channels.length : 0);
console.log('    ' + pad('seeded by hand', 30) + n(seed.channels.length));
console.log('    ' + pad('found by discover.js', 30) + n(discovered.channels.length));
console.log('    ' + pad('the ceiling', 30) + n(ceiling));
console.log('    ' + pad('measured', 30) + n(measured));
console.log('    ' + pad('passed the safety rules', 30) + n(db.channels.length));
console.log('    ' + pad('waiting on a human', 30) + n(review ? review.channels.length : 0));
console.log('    ' + pad('removed by the filter', 30) + n(rejected ? rejected.channels.length : 0));
if (unresolved) {
  console.log('    ' + pad('handle not found', 30) + n(unresolved.entries.length));
  console.log('    ' + pad('skipped, no credential', 30) + n(unresolved.skipped.length));
}
console.log('');

if (report && report.offline) {
  console.log('  ⚠  These are FIXTURES, not measurements. build-report.json says');
  console.log('     offline: true. Set YOUTUBE_API_KEY and run:');
  console.log('       node database/build.js');
  console.log('');
}

if (rows.length) {
  line();
  console.log('  BREAKDOWN');
  console.log('');
  for (const key of ['platform', 'tier', 'niche']) {
    const t = {};
    for (const c of rows) if (c[key]) t[c[key]] = (t[c[key]] || 0) + 1;
    const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    console.log('    ' + key);
    for (const [k, v] of entries) console.log('      ' + pad(k, 26) + n(v));
    console.log('');
  }

  const followers = rows.reduce((a, c) => a + (c.followers || 0), 0);
  const views = rows.reduce((a, c) => a + (c.total_views || 0), 0);
  console.log('    reach');
  console.log('      ' + pad('followers, combined', 26) + n(followers));
  console.log('      ' + pad('views, combined', 26) + n(views));
  console.log('');
}

line();
console.log('  This counts YOUR channels, not the platform. No API counts or');
console.log('  lists channels by criteria — raise the ceiling by adding to');
console.log('  the seed list, or run database/discover.js to find more.');
console.log('  Ceiling right now: ' + ceiling + '.');
console.log('');
