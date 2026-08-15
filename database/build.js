#!/usr/bin/env node
/* Database build pipeline
   ============================================================================
   Reads the seed list, resolves every entry through the platform's official
   API, measures it, runs it past the safety rules, and writes four files:

     data/channels.json     the database — everything that passed
     data/review.json       matched something, not enough to remove it over
     data/rejected.json     removed, with the exact rule that removed it
     data/unresolved.json   the API could not find it (renamed, deleted, typo)
     data/build-report.json counts, quota spent, how long it took

   Nothing is scraped and no undocumented endpoint is called. Every request
   goes to a documented endpoint with a documented parameter, which is also
   why the database is seeded rather than crawled: neither platform will hand
   over a list of channels, and the honest answer to "every channel" is a
   curated list that grows rather than a crawl that gets the account banned.

   Usage
     node database/build.js                    build everything in the seed
     node database/build.js --only youtube     one platform
     node database/build.js --limit 10         first 10 entries, for a dry run
     node database/build.js --offline          fixtures only, no network, no keys
     node database/build.js --publish <url>    also POST the result to a Worker
   ---------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './safety/filter.js';
import { __test as M } from '../integrations-worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(HERE, 'data');

/* ----------------------------------------------------------------------------
   Environment

   There is no dotenv dependency because there are no dependencies. A .env is
   read if it exists, and real environment variables win over it, so CI does
   not need a file.
   ---------------------------------------------------------------------------- */
function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return Object.assign(env, Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v)
  ));
}

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const OFFLINE = flag('--offline');
const ONLY = val('--only', '');
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;
const PUBLISH = val('--publish', '');
const env = loadEnv();

let quota = 0;                                   // YouTube units, counted honestly
const log = (...a) => console.log(...a);

/* ----------------------------------------------------------------------------
   HTTP with retry — same policy as the Worker: retry what a retry can fix.
   ---------------------------------------------------------------------------- */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function get(url, opts, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
      clearTimeout(timer);
      let body = null;
      try { body = await r.json(); } catch { /* an error page, not JSON */ }
      if (r.ok) return { ok: true, status: r.status, body };
      if (!RETRYABLE.has(r.status) || i === tries - 1) {
        return { ok: false, status: r.status, body, error: message(r.status, body) };
      }
    } catch (e) {
      last = e;
      if (i === tries - 1) return { ok: false, status: 0, error: String(e.message || e) };
    }
    await sleep(400 * Math.pow(2, i) + Math.random() * 200);
  }
  return { ok: false, status: 0, error: String(last) };
}

function message(status, body) {
  const vendor = body && body.error && (body.error.message || body.error) || (body && body.message) || '';
  const base = status === 401 ? 'credentials rejected'
    : status === 403 ? 'access denied or quota exhausted'
    : status === 404 ? 'not found'
    : status === 429 ? 'rate limited'
    : 'HTTP ' + status;
  return vendor ? base + ' — ' + vendor : base;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseInt(v, 10); return isFinite(n) ? n : 0; };

/* ----------------------------------------------------------------------------
   YouTube
   ---------------------------------------------------------------------------- */
const YT = 'https://www.googleapis.com/youtube/v3/';

async function yt(pathname, params, cost) {
  quota += cost;
  const q = new URLSearchParams(Object.assign({ key: env.YOUTUBE_API_KEY }, params));
  return get(YT + pathname + '?' + q);
}

/* forHandle is the documented way to turn "@mkbhd" into a channel id, and it
   costs one unit. search.list would cost a hundred for a worse answer. */
async function ytChannel(handle) {
  const params = { part: 'snippet,statistics,contentDetails,topicDetails,brandingSettings' };
  if (handle.startsWith('@')) params.forHandle = handle;
  else if (/^UC[\w-]{22}$/.test(handle)) params.id = handle;
  else params.forUsername = handle;

  const r = await yt('channels', params, 1);
  if (!r.ok) return { error: r.error };
  const item = r.body && r.body.items && r.body.items[0];
  return item ? { item } : { error: 'no channel with that handle' };
}

async function ytVideos(channel, max = 25) {
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { items: [], note: 'uploads playlist not exposed' };

  const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: String(max) }, 1);
  if (!pl.ok) return { items: [], note: pl.error };

  const ids = (pl.body?.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return { items: [] };

  const vs = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') }, 1);
  if (!vs.ok) return { items: [], note: vs.error };

  return {
    items: (vs.body?.items || []).map(v => ({
      id: v.id,
      title: v.snippet?.title || '',
      description: (v.snippet?.description || '').slice(0, 2000),
      tags: v.snippet?.tags || [],
      published_at: v.snippet?.publishedAt || '',
      views: num(v.statistics?.viewCount),
      likes: num(v.statistics?.likeCount),
      comments: num(v.statistics?.commentCount),
      /* The platform's own age gate. Stronger evidence than any word list,
         because YouTube applied it after watching the video. */
      age_restricted: v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted'
    }))
  };
}

async function buildYouTube(seed) {
  const got = await ytChannel(seed.handle);
  if (got.error) return { unresolved: { ...seed, error: got.error } };

  const c = got.item;
  const vids = await ytVideos(c);
  const sn = c.snippet || {}, st = c.statistics || {};
  const keywords = parseKeywords(c.brandingSettings?.channel?.keywords || '');

  const metrics = M.unified({
    platform: 'youtube',
    id: c.id,
    username: sn.customUrl || seed.handle,
    display_name: sn.title || '',
    profile_url: 'https://www.youtube.com/channel/' + c.id,
    avatar_url: sn.thumbnails?.high?.url || '',
    followers: st.hiddenSubscriberCount ? 0 : num(st.subscriberCount),
    total_views: num(st.viewCount),
    total_content: num(st.videoCount),
    country: sn.country || '',
    language: sn.defaultLanguage || c.brandingSettings?.channel?.defaultLanguage || '',
    niche: seed.niche || '',
    videos: vids.items,
    unavailable: ['shares (YouTube does not expose share counts)']
      .concat(st.hiddenSubscriberCount ? ['followers (hidden by the channel)'] : [])
      .concat(vids.note ? ['recent uploads (' + vids.note + ')'] : [])
  });

  return {
    record: metrics,
    /* What the classifier reads. Kept separate from the metrics on purpose:
       the safety input is text, the metrics are numbers, and mixing them makes
       both harder to check. */
    safetyInput: {
      platform: 'youtube', id: c.id,
      title: sn.title || '', description: sn.description || '',
      keywords, topics: c.topicDetails?.topicCategories || [],
      videos: vids.items.map(v => ({
        title: v.title, description: v.description, tags: v.tags, age_restricted: v.age_restricted
      })),
      flags: {}
    }
  };
}

/* brandingSettings.keywords is one string with quoted multi-word phrases. */
function parseKeywords(s) {
  return (String(s).match(/"[^"]+"|\S+/g) || []).map(k => k.replace(/^"|"$/g, ''));
}

/* ----------------------------------------------------------------------------
   Twitch
   ---------------------------------------------------------------------------- */
let twitchTok = null;

async function twitchToken() {
  if (twitchTok) return twitchTok;
  const r = await get('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  twitchTok = r.ok && r.body?.access_token ? r.body.access_token : null;
  return twitchTok;
}

async function tw(pathname, params) {
  const token = await twitchToken();
  if (!token) return { ok: false, error: 'Twitch authorization failed — check the client id and secret.' };
  const q = params ? '?' + new URLSearchParams(params) : '';
  return get('https://api.twitch.tv/helix/' + pathname + q, {
    headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token }
  });
}

async function buildTwitch(seed) {
  const u = await tw('users', { login: seed.login });
  if (!u.ok) return { unresolved: { ...seed, error: u.error } };
  const user = u.body?.data?.[0];
  if (!user) return { unresolved: { ...seed, error: 'no Twitch user with that name' } };

  const [chan, follow, vods, stream] = await Promise.all([
    tw('channels', { broadcaster_id: user.id }),
    tw('channels/followers', { broadcaster_id: user.id, first: '1' }),
    tw('videos', { user_id: user.id, first: '20', type: 'archive' }),
    tw('streams', { user_id: user.id })
  ]);

  const ch = chan.ok ? chan.body?.data?.[0] || {} : {};
  const live = stream.ok ? stream.body?.data?.[0] : null;
  const videos = (vods.ok ? vods.body?.data || [] : []).map(v => ({
    id: v.id, title: v.title || '', description: v.description || '',
    published_at: v.published_at, views: num(v.view_count)
  }));

  const metrics = M.unified({
    platform: 'twitch',
    id: user.id,
    username: user.login,
    display_name: user.display_name,
    profile_url: 'https://twitch.tv/' + user.login,
    avatar_url: user.profile_image_url || '',
    followers: follow.ok ? num(follow.body?.total) : 0,
    total_views: videos.reduce((a, v) => a + v.views, 0),
    total_content: videos.length,
    language: ch.broadcaster_language || '',
    niche: seed.niche || '',
    verified: user.broadcaster_type === 'partner',
    videos,
    unavailable: [
      'likes and comments (Twitch VODs have neither)',
      'shares (not exposed by the API)',
      'follower list (needs a user token with moderator scope)'
    ]
  });
  metrics.live = !!live;
  metrics.broadcaster_type = user.broadcaster_type || 'none';

  return {
    record: metrics,
    safetyInput: {
      platform: 'twitch', id: user.id,
      title: user.display_name || '', description: user.description || '',
      keywords: ch.tags || [], topics: [],
      videos: videos.map(v => ({ title: v.title, description: v.description, tags: [], age_restricted: false })),
      flags: {
        twitch_mature: !!(live && live.is_mature),
        twitch_labels: (ch.content_classification_labels || [])
      }
    }
  };
}

/* ----------------------------------------------------------------------------
   Offline fixtures

   So the pipeline, the rules and the output shape can be exercised with no
   credentials at all. These are written by hand to cover the decisions that
   matter, and they are labelled demo in the output so nobody mistakes them
   for measurements.
   ---------------------------------------------------------------------------- */
function fixtures() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'seeds', 'fixtures.json'), 'utf8'));
}

/* ----------------------------------------------------------------------------
   Build
   ---------------------------------------------------------------------------- */
async function main() {
  const started = Date.now();
  fs.mkdirSync(DATA, { recursive: true });

  const rules = JSON.parse(fs.readFileSync(path.join(HERE, 'safety', 'rules.json'), 'utf8'));
  const external = loadExternalTerms(rules);
  const seed = JSON.parse(fs.readFileSync(path.join(HERE, 'seeds', 'channels.seed.json'), 'utf8'));

  /* Curated seeds first, then anything discover.js turned up. Order matters:
     the hand-picked list gets measured before the discovered tail, so a
     truncated run by --limit or exhausted quota still covers the channels
     someone actually chose. */
  let entries = seed.channels.slice();
  const discovered = path.join(HERE, 'seeds', 'discovered.json');
  if (fs.existsSync(discovered)) {
    const d = JSON.parse(fs.readFileSync(discovered, 'utf8'));
    const have = new Set(entries.map(e => e.platform + ':' + (e.handle || e.login || '').toLowerCase()));
    let added = 0;
    for (const c of d.channels || []) {
      const k = c.platform + ':' + (c.handle || c.login || '').toLowerCase();
      if (!have.has(k)) { entries.push(c); have.add(k); added++; }
    }
    if (added) log('  ' + added + ' discovered channels added to the ' + seed.channels.length + ' seeded');
  }
  if (ONLY) entries = entries.filter(e => e.platform === ONLY);
  if (LIMIT) entries = entries.slice(0, LIMIT);

  const out = { allow: [], review: [], block: [] };
  const unresolved = [];
  const skipped = [];

  if (OFFLINE) {
    log('offline — fixtures only, nothing will be requested');
    for (const f of fixtures()) {
      const safety = classify(f.safetyInput, rules, external);
      safety.rules_version = rules.version;
      safety.reviewed_at = new Date().toISOString();
      const record = Object.assign(M.unified(f.raw), { demo: true, data_source: 'demo' });
      out[safety.verdict].push(merge(record, safety, f.safetyInput));
    }
  } else {
    const haveYT = !!env.YOUTUBE_API_KEY;
    const haveTW = !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
    if (!haveYT) log('YOUTUBE_API_KEY not set — skipping every YouTube entry');
    if (!haveTW) log('TWITCH_CLIENT_ID/SECRET not set — skipping every Twitch entry');

    let n = 0;
    for (const e of entries) {
      n++;
      if (e.platform === 'youtube' && !haveYT) { skipped.push({ ...e, reason: 'YOUTUBE_API_KEY not set' }); continue; }
      if (e.platform === 'twitch' && !haveTW) { skipped.push({ ...e, reason: 'Twitch credentials not set' }); continue; }
      if (e.platform !== 'youtube' && e.platform !== 'twitch') {
        /* TikTok and Instagram cannot look up a creator who has not connected.
           Saying so beats an empty row that looks like a measurement. */
        skipped.push({ ...e, reason: e.platform + ' has no public creator lookup — connect the account instead' });
        continue;
      }

      const label = e.handle || e.login;
      process.stdout.write('  [' + n + '/' + entries.length + '] ' + e.platform + ' ' + label + ' ... ');

      let got;
      try {
        got = e.platform === 'youtube' ? await buildYouTube(e) : await buildTwitch(e);
      } catch (err) {
        got = { unresolved: { ...e, error: String(err.message || err) } };
      }

      if (got.unresolved) { unresolved.push(got.unresolved); log('unresolved (' + got.unresolved.error + ')'); continue; }

      const safety = classify(got.safetyInput, rules, external);
      safety.rules_version = rules.version;
      safety.reviewed_at = new Date().toISOString();
      out[safety.verdict].push(merge(got.record, safety, got.safetyInput));

      log(safety.verdict + (safety.verdict === 'allow' ? '' : ' (' + topReason(safety) + ')'));
      await sleep(120);                            // polite, and well under both rate limits
    }
  }

  /* Ranked by median views, for the reason in the README: a mean lets one
     video that caught the algorithm speak for a whole channel. */
  out.allow.sort((a, b) => (b.median_views || 0) - (a.median_views || 0));

  const report = {
    built_at: new Date().toISOString(),
    rules_version: rules.version,
    seed_version: seed.version,
    offline: OFFLINE,
    seeded: entries.length,
    in_database: out.allow.length,
    needs_review: out.review.length,
    rejected: out.block.length,
    unresolved: unresolved.length,
    skipped: skipped.length,
    youtube_quota_units: quota,
    rejected_by_category: tally(out.block),
    review_by_category: tally(out.review),
    took_ms: Date.now() - started
  };

  write('channels.json', { built_at: report.built_at, rules_version: rules.version, count: out.allow.length, channels: out.allow });
  write('review.json', { built_at: report.built_at, count: out.review.length, channels: out.review });
  write('rejected.json', { built_at: report.built_at, count: out.block.length, channels: out.block });
  write('unresolved.json', { built_at: report.built_at, count: unresolved.length, entries: unresolved, skipped });
  write('build-report.json', report);

  log('');
  log('  in database   ' + report.in_database);
  log('  needs review  ' + report.needs_review);
  log('  rejected      ' + report.rejected);
  log('  unresolved    ' + report.unresolved);
  log('  skipped       ' + report.skipped);
  log('  quota used    ' + quota + ' of 10000 daily units');
  log('  written to    database/data/');

  if (PUBLISH) await publish(PUBLISH, out, report);
}

/* The database row: the measurements, plus the verdict and why. The safety
   block travels with the channel so a row can always answer for itself. */
function merge(record, safety, input) {
  return Object.assign({}, record, {
    title: input.title,
    description: (input.description || '').slice(0, 400),
    topics: input.topics,
    safety: {
      verdict: safety.verdict,
      safety_score: safety.safety_score,
      quality_flags: (safety.quality_flags || []).map(q => q.id),
      risk_score: safety.risk_score,
      categories: Object.keys(safety.categories),
      flagged_upload_ratio: safety.flagged_upload_ratio,
      rules_version: safety.rules_version,
      reasons: safety.reasons
    }
  });
}

function topReason(safety) {
  const r = safety.reasons.filter(x => x.contribution).sort((a, b) => b.contribution - a.contribution)[0];
  return r ? r.rule : 'threshold';
}

function tally(list) {
  const t = {};
  for (const c of list) for (const k of c.safety.categories) t[k] = (t[k] || 0) + 1;
  for (const c of list) for (const r of c.safety.reasons) if (r.rule.startsWith('hard:')) t[r.rule] = (t[r.rule] || 0) + 1;
  return t;
}

function write(name, obj) {
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2) + '\n');
}

/* The optional local term list. See rules.json for why it is not committed. */
function loadExternalTerms(rules) {
  const ext = {};
  for (const cat of rules.categories || []) {
    if (!cat.external_terms_file) continue;
    const file = path.join(HERE, 'safety', cat.external_terms_file);
    if (!fs.existsSync(file)) continue;
    ext[cat.id] = fs.readFileSync(file, 'utf8').split('\n')
      .map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    log('loaded ' + ext[cat.id].length + ' local terms for ' + cat.id);
  }
  return ext;
}

async function publish(url, out, report) {
  if (!env.ADMIN_TOKEN) {
    log('\n--publish needs ADMIN_TOKEN — nothing was sent.');
    return;
  }
  const r = await get(url.replace(/\/+$/, '') + '/api/database/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.ADMIN_TOKEN },
    body: JSON.stringify({ report, channels: out.allow, review: out.review, rejected: out.block })
  });
  log(r.ok ? '\npublished to ' + url : '\npublish failed: ' + r.error);
}

main().catch(e => { console.error(e); process.exit(1); });
