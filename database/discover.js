#!/usr/bin/env node
/* Channel discovery — finding channels you do not already know about
   ============================================================================
   build.js measures channels you name. This finds them in the first place,
   using the only two documented endpoints on any of the four platforms that
   return channels you did not already have an id for.

   WHAT IS ACTUALLY POSSIBLE, PLATFORM BY PLATFORM

     Twitch     GET /helix/streams pages through EVERY channel that is live
                right now, 100 at a time, ordered by viewer count. This is
                real enumeration — the closest thing to a census any of these
                platforms offers. Run it repeatedly over days and the union
                approaches "every active streamer". No quota, only a rate
                limit. This is the strongest tool in the file.

     YouTube    search.list?type=channel returns up to 50 channels per query
                and paginates to a hard ceiling of about 500 per query. There
                is no way to walk all channels — you can only ask questions
                and collect answers. Each call costs 100 quota units out of
                10,000 a day, so a free key funds ~100 searches/day, or up to
                ~5,000 discovered channels a day if every result is new.

     TikTok     Nothing. The Display API returns the connected account and
                nothing else. Looking up any other creator requires the
                Research API, which is an academic application with an
                institutional affiliation requirement. There is no endpoint
                to call here, so this file does not pretend to have one.

     Instagram  Nothing enumerable. business_discovery can look up another
                public professional account, but only by a username you
                already have — it is a lookup, not a search. So Instagram
                grows from names you supply, never from discovery.

   WHY "EVERY CHANNEL" IS NOT A THING THIS CAN PRODUCE

     YouTube has upwards of a hundred million channels. At 3 quota units to
     measure one and 10,000 units a day, a free key measures about 3,300 a
     day: roughly ninety years, assuming you could even enumerate them, which
     you cannot. Quota increases exist but are granted per use case after an
     audit, and "index every channel" is not one of them.

     Twitch is the one where a real census is close to achievable, because
     live enumeration genuinely works.

     TikTok and Instagram are closed. Not difficult — closed.

   Everything here is a documented endpoint with documented parameters. There
   is no scraping in this file and no undocumented call.

   Usage
     node database/discover.js --twitch-live --pages 20
     node database/discover.js --youtube-search "video editing tutorial"
     node database/discover.js --youtube-niches --budget 3000
     node database/discover.js --twitch-live --pages 100 --merge
   ---------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SEEDS = path.join(HERE, 'seeds');

function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return Object.assign(env, Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)));
}

const args = process.argv.slice(2);
const has = n => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const env = loadEnv();

const PAGES = parseInt(val('--pages', '20'), 10);
const BUDGET = parseInt(val('--budget', '2000'), 10);   // YouTube quota units
const MERGE = has('--merge');

let quota = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, opts, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
      clearTimeout(t);
      let body = null;
      try { body = await r.json(); } catch { }
      if (r.ok) return { ok: true, body };
      const retryable = [429, 500, 502, 503, 504].includes(r.status);
      if (!retryable || i === tries - 1) {
        const vendor = body?.error?.message || body?.message || '';
        return { ok: false, status: r.status, error: 'HTTP ' + r.status + (vendor ? ' — ' + vendor : '') };
      }
    } catch (e) {
      if (i === tries - 1) return { ok: false, error: String(e.message || e) };
    }
    await sleep(500 * Math.pow(2, i));
  }
}

/* ----------------------------------------------------------------------------
   Twitch — real enumeration of everything live
   ---------------------------------------------------------------------------- */
let twTok = null;
async function twitchToken() {
  if (twTok) return twTok;
  const r = await get('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  twTok = r.ok ? r.body?.access_token : null;
  return twTok;
}

async function twitchLive(maxPages) {
  const token = await twitchToken();
  if (!token) return { error: 'Twitch authorization failed — check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET' };

  const found = new Map();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ first: '100' });
    if (cursor) q.set('after', cursor);
    const r = await get('https://api.twitch.tv/helix/streams?' + q, {
      headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return { error: r.error, found };

    const data = r.body?.data || [];
    for (const s of data) {
      if (!found.has(s.user_login)) {
        found.set(s.user_login, {
          platform: 'twitch', login: s.user_login,
          niche: (s.game_name || 'gaming').toLowerCase().includes('just chatting') ? 'talk' : 'gaming',
          discovered: { via: 'helix/streams', game: s.game_name || '', viewers: s.viewer_count || 0,
            /* Twitch's own mature flag, captured at discovery. The filter uses
               it later; recording it here means a channel can be skipped
               before spending a single request measuring it. */
            is_mature: !!s.is_mature }
        });
      }
    }
    process.stdout.write('\r  twitch: page ' + (page + 1) + '/' + maxPages + ', ' + found.size + ' channels');
    cursor = r.body?.pagination?.cursor;
    if (!cursor || !data.length) break;
    await sleep(120);                                  // well inside 800 points/min
  }
  console.log('');
  return { found };
}

/* ----------------------------------------------------------------------------
   YouTube — search, which is asking questions, not enumerating
   ---------------------------------------------------------------------------- */
const NICHE_QUERIES = [
  'video editing tutorial', 'after effects tutorial', 'davinci resolve tutorial',
  'filmmaking', 'cinematography', 'photography tutorial', 'graphic design',
  'motion graphics', 'blender tutorial', '3d animation',
  'youtube growth tips', 'content creation tips', 'creator economy',
  'coding tutorial', 'web development', 'game development',
  'science explained', 'maths explained', 'history documentary',
  'music production', 'guitar lesson', 'music theory',
  'cooking recipe', 'home workout', 'study with me'
];

async function youtubeSearch(query, budget) {
  if (!env.YOUTUBE_API_KEY) return { error: 'YOUTUBE_API_KEY is not set' };
  const found = new Map();
  let token = null;

  while (quota + 100 <= budget) {
    const q = new URLSearchParams({
      key: env.YOUTUBE_API_KEY, part: 'snippet', type: 'channel',
      q: query, maxResults: '50', order: 'relevance'
    });
    if (token) q.set('pageToken', token);

    quota += 100;                                      // search.list is 100 units. Always.
    const r = await get('https://www.googleapis.com/youtube/v3/search?' + q);
    if (!r.ok) return { error: r.error, found };

    for (const item of r.body?.items || []) {
      const id = item.id?.channelId;
      if (id && !found.has(id)) {
        found.set(id, {
          platform: 'youtube', handle: id, niche: '',
          discovered: { via: 'search.list', query, title: item.snippet?.title || '' }
        });
      }
    }
    token = r.body?.nextPageToken;
    if (!token) break;
    await sleep(120);
  }
  return { found };
}

/* ----------------------------------------------------------------------------
   Run
   ---------------------------------------------------------------------------- */
async function main() {
  const out = new Map();
  const seed = JSON.parse(fs.readFileSync(path.join(SEEDS, 'channels.seed.json'), 'utf8'));
  const known = new Set(seed.channels.map(c => c.platform + ':' + (c.handle || c.login).toLowerCase()));

  const existingFile = path.join(SEEDS, 'discovered.json');
  if (fs.existsSync(existingFile)) {
    /* Discovery is cumulative. Twitch live is a snapshot of one moment, so the
       value is in the union across runs, not in any single run. */
    const prev = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
    for (const c of prev.channels || []) out.set(c.platform + ':' + (c.handle || c.login).toLowerCase(), c);
    console.log('  carried forward ' + out.size + ' from a previous run');
  }
  const before = out.size;

  if (has('--twitch-live')) {
    const r = await twitchLive(PAGES);
    if (r.error) console.log('  twitch: ' + r.error);
    for (const [login, c] of r.found || []) {
      const k = 'twitch:' + login.toLowerCase();
      if (!known.has(k)) out.set(k, c);
    }
  }

  if (has('--youtube-search')) {
    const query = val('--youtube-search', '');
    const r = await youtubeSearch(query, BUDGET);
    if (r.error) console.log('  youtube: ' + r.error);
    for (const [id, c] of r.found || []) if (!known.has('youtube:' + id.toLowerCase())) out.set('youtube:' + id.toLowerCase(), c);
    console.log('  youtube: "' + query + '" -> ' + (r.found ? r.found.size : 0) + ' channels, ' + quota + ' units');
  }

  if (has('--youtube-niches')) {
    for (const query of NICHE_QUERIES) {
      if (quota + 100 > BUDGET) { console.log('  budget reached at ' + quota + ' units'); break; }
      const r = await youtubeSearch(query, Math.min(BUDGET, quota + 200));
      if (r.error) { console.log('  youtube: ' + r.error); break; }
      for (const [id, c] of r.found) {
        const k = 'youtube:' + id.toLowerCase();
        if (!known.has(k)) { c.niche = nicheFor(query); out.set(k, c); }
      }
      console.log('  youtube: ' + query.padEnd(30) + (r.found.size + ' found').padEnd(14) + quota + ' units');
    }
  }

  if (!has('--twitch-live') && !has('--youtube-search') && !has('--youtube-niches')) {
    console.log('\n  Nothing to do. Pick at least one:');
    console.log('    --twitch-live [--pages N]     every channel live right now');
    console.log('    --youtube-search "<query>"    up to ~500 channels for one query');
    console.log('    --youtube-niches              a spread of queries, quota-bounded');
    console.log('');
    return;
  }

  const channels = [...out.values()];
  fs.writeFileSync(existingFile, JSON.stringify({
    updated: new Date().toISOString(),
    note: 'Discovered channels, cumulative across runs. build.js reads this alongside channels.seed.json. Nothing here has been measured or filtered yet.',
    count: channels.length,
    channels
  }, null, 2) + '\n');

  const byPlatform = channels.reduce((a, c) => { a[c.platform] = (a[c.platform] || 0) + 1; return a; }, {});

  console.log('');
  console.log('  DISCOVERED');
  console.log('    new this run       ' + (out.size - before));
  console.log('    total known        ' + channels.length + '  ' + JSON.stringify(byPlatform));
  console.log('    already in seed    ' + known.size);
  console.log('    youtube quota      ' + quota + ' of 10000 daily units');
  console.log('    written to         database/seeds/discovered.json');
  console.log('');
  console.log('  None of these are measured yet. Next:');
  console.log('    node database/build.js            measure and filter everything');
  console.log('');
  console.log('  Measuring costs ~3 YouTube units each, so ' + (byPlatform.youtube || 0) +
              ' YouTube channels is ~' + ((byPlatform.youtube || 0) * 3) + ' units.');
  if ((byPlatform.youtube || 0) * 3 > 10000) {
    console.log('  That is over a day of free quota — build.js will need several runs.');
  }
  console.log('');
}

function nicheFor(q) {
  if (/editing|after effects|resolve|filmmaking|cinemat/.test(q)) return 'video-editing';
  if (/design|motion|blender|3d|photograph/.test(q)) return 'design';
  if (/coding|web dev|game dev/.test(q)) return 'software';
  if (/science|maths|history/.test(q)) return 'education';
  if (/music|guitar/.test(q)) return 'music';
  if (/cooking/.test(q)) return 'cooking';
  if (/workout/.test(q)) return 'fitness';
  if (/youtube growth|content creation|creator economy|study with me/.test(q)) return 'creator-education';
  return '';
}

main().catch(e => { console.error(e); process.exit(1); });
