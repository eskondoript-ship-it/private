/* NovaClip — Creator Intelligence integrations
   ============================================================================
   THERE ARE NOW THREE WORKERS. THIS IS THE INTEGRATIONS ONE.

     THIS FILE                 YouTube, Twitch, TikTok and Instagram.
                               Needs the platform credentials below and a KV
                               binding called DB.
                               Its address goes in nova.js -> NC_INTEGRATIONS.

     ai-worker.js              the model vendors. GEMINI_API_KEY and friends.
     leaderboard-worker.js     accounts, saves, leaderboard, community.

   They are not interchangeable. Every one of them answers /health with a
   "worker" field naming itself, so a swapped deploy is visible in a browser
   rather than at 2am.

   ============================================================================
   WHY A WORKER AND NOT A .env FILE

   This project has no Node server and no bundler — it is static pages plus
   Workers. A .env file has nothing to read it at runtime, so the credentials
   live where Cloudflare keeps secrets: Settings -> Variables and Secrets, or
   `wrangler secret put`. .env.example in the repo documents the names for
   `wrangler dev`, which does read one. No key is ever in source, and none of
   them is ever sent to a browser.

   ============================================================================
   WHAT EACH PLATFORM ACTUALLY ALLOWS

   Honesty matters more than a full-looking dashboard, so:

     YouTube    a server API key reads any public channel. No user consent, no
                approval. This is the one that just works.

     Twitch     app access token via client credentials. Public channel data
                only. Follower COUNT is available; the follower LIST needs a
                user token with moderator scope, so it is not offered here.

     TikTok     user OAuth only. There is no public "look up any creator"
                endpoint outside the Research API, which requires a separate
                academic application. So this reads the connected account and
                nothing else, and says so.

     Instagram  user OAuth, professional accounts only, through the Graph API.
                A personal account cannot return insights — that is Meta's
                rule, not a bug here, and the error says which it is.

   Nothing in this file scrapes, and nothing calls an undocumented endpoint.
   ---------------------------------------------------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400'
};

const json = (body, status = 200, extra) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra || {})
  });

/* ============================================================================
   1. CONFIGURATION
   ============================================================================
   One table describes every credential the Worker knows about. Everything else
   — the status endpoint, the dashboard, the "is this usable" checks — reads
   from it, so adding a platform is one entry rather than six edits.

   `present()` returns a boolean and never the value. There is no code path in
   this file that puts a secret into a response body or a log line.
   ---------------------------------------------------------------------------- */
const CONFIG = {
  youtube:   { vars: ['YOUTUBE_API_KEY'], oauth: false, label: 'YouTube' },
  twitch:    { vars: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'], oauth: 'app', label: 'Twitch' },
  tiktok:    { vars: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], oauth: 'user', label: 'TikTok' },
  instagram: { vars: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'], oauth: 'user', label: 'Instagram' },
  ai:        { vars: ['GEMINI_API_KEY', 'OPENAI_API_KEY'], any: true, oauth: false, label: 'AI' }
};

function configured(env, platform) {
  const c = CONFIG[platform];
  if (!c) return false;
  const have = c.vars.filter(v => typeof env[v] === 'string' && env[v].trim().length > 0);
  /* `any` platforms need one of their keys; the rest need all of them, because
     a client id without its secret cannot complete a token exchange. */
  return c.any ? have.length > 0 : have.length === c.vars.length;
}

function missingVars(env, platform) {
  const c = CONFIG[platform];
  if (!c) return [];
  return c.vars.filter(v => !(typeof env[v] === 'string' && env[v].trim()));
}

/* The shape every disabled feature returns, so callers have one thing to check
   rather than guessing from a 500. */
function notConfigured(platform, env) {
  return {
    available: false,
    reason: 'API credentials not configured',
    platform: platform,
    missing: missingVars(env, platform)
  };
}

/* ============================================================================
   2. HTTP: timeout, retry, backoff
   ============================================================================
   Every outbound call goes through this. Retries are only for failures that a
   retry can fix — a network error, a 429, or a 5xx. A 401 or a 403 is a
   configuration problem and retrying it just burns quota and time.
   ---------------------------------------------------------------------------- */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function fetchJSON(url, opts, tries) {
  opts = opts || {};
  tries = tries || 3;
  let lastErr = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) {
      /* Exponential with jitter: 300ms, 600ms, 1.2s, plus up to 200ms of
         randomness so a burst of callers does not retry in lockstep. */
      const wait = 300 * Math.pow(2, attempt - 1) + Math.random() * 200;
      await new Promise(r => setTimeout(r, wait));
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 10000);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
      clearTimeout(timer);

      const text = await res.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); }
        catch (e) {
          /* HTML from a captive portal or an error page. Not retryable and not
             a JSON problem the caller can do anything about. */
          return { ok: false, status: res.status, error: 'invalid JSON from ' + hostOf(url), body: null };
        }
      }

      if (res.ok) return { ok: true, status: res.status, body: body };
      if (!RETRYABLE.has(res.status) || attempt === tries - 1) {
        return { ok: false, status: res.status, body: body, error: describe(res.status, body) };
      }
      lastErr = describe(res.status, body);
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e && e.name === 'AbortError') ? 'the request timed out' : 'could not reach ' + hostOf(url);
      if (attempt === tries - 1) return { ok: false, status: 0, error: lastErr, body: null };
    }
  }
  return { ok: false, status: 0, error: lastErr || 'request failed', body: null };
}

function hostOf(u) { try { return new URL(u).host; } catch (e) { return 'the API'; } }

/* Turns a status code into something a person can act on. The platform's own
   message is included when it sent one, because "quotaExceeded" and "invalid
   API key" both arrive as 403 and need completely different fixes. */
function describe(status, body) {
  const vendor = (body && (
    (body.error && (body.error.message || body.error)) ||
    body.message || body.error_description || body.error_message
  )) || '';
  const msg = {
    400: 'the request was rejected as malformed',
    401: 'authorization failed or the token expired',
    403: 'access denied — a missing scope, a disabled API, or exhausted quota',
    404: 'not found',
    429: 'rate limited',
    500: 'the platform had a server error',
    502: 'the platform gateway failed',
    503: 'the platform is temporarily unavailable'
  }[status] || ('HTTP ' + status);
  return vendor ? msg + ' (' + String(vendor).slice(0, 200) + ')' : msg;
}

/* ============================================================================
   3. CACHE
   ============================================================================
   YouTube's free quota is 10,000 units a day and a channel lookup with its
   uploads costs a handful. Caching for a few minutes is the difference between
   a dashboard someone can refresh and one that dies by mid-afternoon.
   ---------------------------------------------------------------------------- */
async function cached(env, key, ttl, produce) {
  if (!env.DB) return produce();
  try {
    const hit = await env.DB.get('cache:' + key, 'json');
    if (hit) return Object.assign({}, hit, { cached: true });
  } catch (e) {}
  const fresh = await produce();
  /* Only successful reads are cached. Caching an error means a transient
     failure is served for the whole TTL. */
  if (fresh && fresh.available !== false && !fresh.error) {
    try { await env.DB.put('cache:' + key, JSON.stringify(fresh), { expirationTtl: ttl }); } catch (e) {}
  }
  return fresh;
}

/* ============================================================================
   4. TOKEN STORAGE, ENCRYPTED AT REST
   ============================================================================
   OAuth tokens are stored in KV encrypted with AES-GCM. The key is derived
   from TOKEN_ENCRYPTION_KEY with SHA-256, and a fresh 12-byte IV is generated
   per record and stored alongside the ciphertext — reusing an IV with GCM
   breaks the cipher, so it is never derived from the record id.

   Without TOKEN_ENCRYPTION_KEY set, connecting an account is refused rather
   than storing a bearer token in plain text.
   ---------------------------------------------------------------------------- */
async function aesKey(env) {
  const secret = env.TOKEN_ENCRYPTION_KEY;
  if (!secret) return null;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const b64 = {
  enc: buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf))),
  dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
};

async function putToken(env, userId, platform, record) {
  const key = await aesKey(env);
  if (!key || !env.DB) return false;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(record));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
  await env.DB.put('tok:' + platform + ':' + userId, JSON.stringify({
    v: 1, iv: b64.enc(iv), ct: b64.enc(ct),
    /* Metadata is stored in clear because it holds nothing sensitive and the
       status endpoint has to answer "connected?" without decrypting. */
    platform_user_id: record.platform_user_id || '',
    scopes: record.scopes || '',
    created_at: record.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: record.expires_at || ''
  }));
  return true;
}

async function getToken(env, userId, platform) {
  if (!env.DB) return null;
  const row = await env.DB.get('tok:' + platform + ':' + userId, 'json');
  if (!row || !row.ct) return null;
  const key = await aesKey(env);
  if (!key) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.dec(row.iv) }, key, b64.dec(row.ct));
    const rec = JSON.parse(new TextDecoder().decode(pt));
    rec.__meta = { expires_at: row.expires_at, scopes: row.scopes, updated_at: row.updated_at };
    return rec;
  } catch (e) {
    /* A rotated TOKEN_ENCRYPTION_KEY lands here. The connection is dead, not
       corrupt data, so it reads as disconnected and can be reconnected. */
    return null;
  }
}

async function tokenMeta(env, userId, platform) {
  if (!env.DB) return null;
  try { return await env.DB.get('tok:' + platform + ':' + userId, 'json'); } catch (e) { return null; }
}

async function dropToken(env, userId, platform) {
  if (!env.DB) return false;
  await env.DB.delete('tok:' + platform + ':' + userId);
  return true;
}

/* ============================================================================
   5. METRICS
   ============================================================================
   Median is the headline number, not mean. One video that caught an algorithm
   can be fifty times a creator's normal, and a mean lets that single post
   speak for the whole channel — which is exactly how a brand ends up paying
   for reach that will not happen again. Mean is still reported, because the
   gap between the two is itself the signal: mean far above median means one
   spike, and the two close together means a reliable channel.
   ---------------------------------------------------------------------------- */
function median(nums) {
  const a = nums.filter(n => typeof n === 'number' && isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}
function mean(nums) {
  const a = nums.filter(n => typeof n === 'number' && isFinite(n));
  return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
}

function tierOf(followers) {
  const f = Number(followers) || 0;
  if (f >= 500000) return 'Mega';
  if (f >= 50000) return 'Macro';
  if (f >= 10000) return 'Micro';
  if (f >= 1000) return 'Nano';
  return 'Below Nano';
}

/* Engagement is measured against the audience that actually saw the post
   (views) when views are known, and against followers when they are not.
   Dividing likes by followers on a platform where reach is algorithmic
   overstates small accounts and understates large ones. */
function engagementRate(m) {
  /* Both sides of this ratio must come from the same statistic. Mixing a mean
     numerator with a median denominator is how a channel with one 90k video
     among 2k videos reports 177% engagement: the spike inflates mean likes
     while median views correctly ignores it. Medians on both sides. */
  const per = (m.median_likes || 0) + (m.median_comments || 0) + (m.median_shares || 0);
  const base = m.median_views || m.followers || 0;
  if (!base) return 0;
  /* Clamped: a platform that reports likes but hides views can still produce a
     nonsense ratio, and 100% is the ceiling of anything meaningful. */
  return Math.min(100, Math.round(per / base * 10000) / 100);
}

function uploadsInLast30(dates) {
  const cut = Date.now() - 30 * 24 * 3600 * 1000;
  return dates.filter(d => {
    const t = Date.parse(d);
    return isFinite(t) && t >= cut;
  }).length;
}

/* ============================================================================
   6. UNIFIED CREATOR FORMAT
   ============================================================================
   Every platform is normalised into this one shape so the app never branches
   on which network a creator came from. Fields a platform genuinely cannot
   provide stay 0 or "" and are named in `unavailable`, so a zero is never
   mistaken for a measurement.
   ---------------------------------------------------------------------------- */
function unified(o) {
  const videos = o.videos || [];
  const views = videos.map(v => v.views).filter(n => typeof n === 'number');
  const likes = videos.map(v => v.likes).filter(n => typeof n === 'number');
  const comments = videos.map(v => v.comments).filter(n => typeof n === 'number');
  const shares = videos.map(v => v.shares).filter(n => typeof n === 'number');

  const m = {
    followers: o.followers || 0,
    avg_views: mean(views), median_views: median(views),
    avg_likes: mean(likes), avg_comments: mean(comments), avg_shares: mean(shares),
    median_likes: median(likes), median_comments: median(comments), median_shares: median(shares)
  };

  return {
    platform: o.platform || '',
    platform_creator_id: String(o.id || ''),
    username: o.username || '',
    display_name: o.display_name || '',
    profile_url: o.profile_url || '',
    avatar_url: o.avatar_url || '',

    followers: m.followers,
    following: o.following || 0,

    total_views: o.total_views || 0,
    total_content: o.total_content || videos.length,

    average_views: m.avg_views,
    median_views: m.median_views,

    average_likes: m.avg_likes,
    average_comments: m.avg_comments,
    average_shares: m.avg_shares,

    median_likes: m.median_likes,
    median_comments: m.median_comments,
    median_shares: m.median_shares,

    engagement_rate: engagementRate(m),
    views_per_follower: m.followers ? Math.round((m.median_views / m.followers) * 100) / 100 : 0,

    uploads_last_30_days: uploadsInLast30(videos.map(v => v.published_at)),

    country: o.country || '',
    language: o.language || '',
    niche: o.niche || '',

    verified: !!o.verified,
    tier: tierOf(m.followers),

    data_source: o.data_source || (o.platform ? o.platform + '_official_api' : ''),
    /* How much of the shape above is actually filled in, so a caller can rank
       a fully-measured creator above a thinly-measured one. */
    data_confidence: confidenceOf(o, views.length),
    unavailable: o.unavailable || [],

    sample_size: videos.length,
    last_updated: new Date().toISOString(),
    demo: !!o.demo
  };
}

function confidenceOf(o, sampled) {
  let score = 0;
  if (o.followers) score += 0.3;
  if (sampled >= 10) score += 0.3; else if (sampled >= 3) score += 0.18; else if (sampled) score += 0.08;
  if (o.total_views) score += 0.15;
  if (o.total_content) score += 0.1;
  if (o.country) score += 0.05;
  if (o.verified !== undefined) score += 0.05;
  if (!o.demo) score += 0.05;
  return Math.round(Math.min(1, score) * 100) / 100;
}

/* ============================================================================
   7. YOUTUBE
   ============================================================================ */
const YT = 'https://www.googleapis.com/youtube/v3/';

async function ytCall(env, path, params) {
  const q = new URLSearchParams(Object.assign({ key: env.YOUTUBE_API_KEY }, params));
  const r = await fetchJSON(YT + path + '?' + q.toString(), { timeout: 9000 });
  if (!r.ok) {
    /* Google returns 403 for both "quota gone" and "API disabled"; the reason
       string is the only way to tell, and they need different fixes. */
    const reason = r.body && r.body.error && r.body.error.errors && r.body.error.errors[0]
      ? r.body.error.errors[0].reason : '';
    if (reason === 'quotaExceeded') r.error = 'YouTube API quota exceeded for today.';
    else if (reason === 'keyInvalid') r.error = 'The YouTube API key is not valid.';
    else if (reason === 'accessNotConfigured') r.error = 'YouTube Data API v3 is not enabled for this key.';
  }
  return r;
}

async function ytGetChannels(env, ids) {
  const r = await ytCall(env, 'channels', {
    part: 'snippet,statistics,contentDetails,brandingSettings',
    id: ids.join(','), maxResults: '50'
  });
  if (!r.ok) return { error: r.error, status: r.status };
  return { items: (r.body && r.body.items) || [] };
}

async function ytRecentVideos(env, channel, max) {
  const uploads = channel.contentDetails &&
    channel.contentDetails.relatedPlaylists &&
    channel.contentDetails.relatedPlaylists.uploads;
  if (!uploads) return { items: [] };

  /* playlistItems costs 1 unit; search.list costs 100 for the same job. On a
     10,000 unit budget that is the difference between 100 lookups and 10,000. */
  const pl = await ytCall(env, 'playlistItems', {
    part: 'contentDetails', playlistId: uploads, maxResults: String(Math.min(max || 25, 50))
  });
  if (!pl.ok) return { error: pl.error, items: [] };

  const ids = ((pl.body && pl.body.items) || [])
    .map(i => i.contentDetails && i.contentDetails.videoId).filter(Boolean);
  if (!ids.length) return { items: [] };

  const vs = await ytCall(env, 'videos', { part: 'snippet,statistics', id: ids.join(',') });
  if (!vs.ok) return { error: vs.error, items: [] };

  return {
    items: ((vs.body && vs.body.items) || []).map(v => ({
      id: v.id,
      title: (v.snippet && v.snippet.title) || '',
      published_at: (v.snippet && v.snippet.publishedAt) || '',
      views: num(v.statistics && v.statistics.viewCount),
      likes: num(v.statistics && v.statistics.likeCount),
      comments: num(v.statistics && v.statistics.commentCount)
    }))
  };
}

function num(v) { const n = parseInt(v, 10); return isFinite(n) ? n : 0; }

async function ytCreator(env, channelId) {
  if (!configured(env, 'youtube')) return notConfigured('youtube', env);

  const ch = await ytGetChannels(env, [channelId]);
  if (ch.error) return { available: false, error: ch.error, platform: 'youtube' };
  if (!ch.items.length) return { available: false, error: 'No YouTube channel with that id.', platform: 'youtube' };

  const c = ch.items[0];
  const vids = await ytRecentVideos(env, c, 25);
  const st = c.statistics || {}, sn = c.snippet || {};
  const unavailable = [];
  if (st.hiddenSubscriberCount) unavailable.push('followers (hidden by the channel)');
  unavailable.push('shares (YouTube does not expose share counts)');
  if (vids.error) unavailable.push('recent videos (' + vids.error + ')');

  return unified({
    platform: 'youtube',
    id: c.id,
    username: sn.customUrl || c.id,
    display_name: sn.title || '',
    profile_url: 'https://www.youtube.com/channel/' + c.id,
    avatar_url: (sn.thumbnails && sn.thumbnails.high && sn.thumbnails.high.url) || '',
    followers: st.hiddenSubscriberCount ? 0 : num(st.subscriberCount),
    total_views: num(st.viewCount),
    total_content: num(st.videoCount),
    country: sn.country || '',
    language: sn.defaultLanguage || '',
    videos: vids.items,
    unavailable: unavailable
  });
}

/* ============================================================================
   8. TWITCH
   ============================================================================
   App access token, client credentials grant. Cached in KV until a minute
   before it expires — Twitch issues these for about 60 days, and minting one
   per request is both slow and rate limited.
   ---------------------------------------------------------------------------- */
async function twitchToken(env) {
  if (!configured(env, 'twitch')) return null;

  if (env.DB) {
    const hit = await env.DB.get('twitch:app_token', 'json');
    if (hit && hit.token && hit.exp > Date.now() + 60000) return hit.token;
  }

  const r = await fetchJSON('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }).toString(),
    timeout: 8000
  });
  if (!r.ok || !r.body || !r.body.access_token) return null;

  if (env.DB) {
    const ttl = Math.max(60, (r.body.expires_in || 3600));
    await env.DB.put('twitch:app_token', JSON.stringify({
      token: r.body.access_token, exp: Date.now() + ttl * 1000
    }), { expirationTtl: ttl });
  }
  return r.body.access_token;
}

async function twitchCall(env, path, params, retryOn401) {
  const token = await twitchToken(env);
  if (!token) return { ok: false, error: 'Twitch authorization failed — check the client id and secret.' };
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetchJSON('https://api.twitch.tv/helix/' + path + q, {
    headers: { 'Client-Id': env.TWITCH_CLIENT_ID, 'Authorization': 'Bearer ' + token },
    timeout: 9000
  });
  /* A cached token that Twitch has since invalidated returns 401. Drop it and
     mint a fresh one once, rather than failing until the TTL runs out. */
  if (!r.ok && r.status === 401 && retryOn401 !== false) {
    if (env.DB) await env.DB.delete('twitch:app_token');
    return twitchCall(env, path, params, false);
  }
  return r;
}

async function twitchCreator(env, login) {
  if (!configured(env, 'twitch')) return notConfigured('twitch', env);

  const u = await twitchCall(env, 'users', { login: login });
  if (!u.ok) return { available: false, error: u.error, platform: 'twitch' };
  const user = u.body && u.body.data && u.body.data[0];
  if (!user) return { available: false, error: 'No Twitch user with that name.', platform: 'twitch' };

  const [followRes, vodRes, streamRes] = await Promise.all([
    twitchCall(env, 'channels/followers', { broadcaster_id: user.id, first: '1' }),
    twitchCall(env, 'videos', { user_id: user.id, first: '20', type: 'archive' }),
    twitchCall(env, 'streams', { user_id: user.id })
  ]);

  const videos = ((vodRes.ok && vodRes.body && vodRes.body.data) || []).map(v => ({
    id: v.id, title: v.title, published_at: v.published_at,
    views: num(v.view_count)
  }));

  const live = !!(streamRes.ok && streamRes.body && streamRes.body.data && streamRes.body.data[0]);
  const out = unified({
    platform: 'twitch',
    id: user.id,
    username: user.login,
    display_name: user.display_name,
    profile_url: 'https://twitch.tv/' + user.login,
    avatar_url: user.profile_image_url || '',
    followers: (followRes.ok && followRes.body && num(followRes.body.total)) || 0,
    total_views: videos.reduce((a, v) => a + (v.views || 0), 0),
    total_content: videos.length,
    verified: user.broadcaster_type === 'partner',
    videos: videos,
    unavailable: [
      'likes and comments (Twitch has no equivalent on VODs)',
      'shares (not exposed by the API)',
      'follower list (needs a user token with moderator scope)'
    ]
  });
  out.live = live;
  out.broadcaster_type = user.broadcaster_type || 'none';
  out.description = user.description || '';
  if (live && streamRes.body.data[0]) out.current_viewers = num(streamRes.body.data[0].viewer_count);
  return out;
}

/* ============================================================================
   9. TIKTOK — user OAuth
   ============================================================================
   Display API only. There is no public lookup for an arbitrary creator without
   the Research API, which is a separate application, so this reads the account
   that authorised us and says clearly that it cannot do more.
   ---------------------------------------------------------------------------- */
const TIKTOK_SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';

function tiktokAuthUrl(env, state, redirect) {
  const q = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    scope: TIKTOK_SCOPES,
    response_type: 'code',
    redirect_uri: redirect,
    state: state
  });
  return 'https://www.tiktok.com/v2/auth/authorize/?' + q.toString();
}

async function tiktokExchange(env, code, redirect) {
  return fetchJSON('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirect
    }).toString(),
    timeout: 9000
  });
}

async function tiktokRefresh(env, refreshToken) {
  return fetchJSON('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }).toString(),
    timeout: 9000
  });
}

/* Returns a usable access token, refreshing first if it is close to expiry. */
async function tiktokAccess(env, userId) {
  const rec = await getToken(env, userId, 'tiktok');
  if (!rec) return null;
  if (rec.expires_at && Date.parse(rec.expires_at) - Date.now() > 120000) return rec.access_token;
  if (!rec.refresh_token) return rec.access_token || null;

  const r = await tiktokRefresh(env, rec.refresh_token);
  if (!r.ok || !r.body || !r.body.access_token) return null;
  await putToken(env, userId, 'tiktok', {
    access_token: r.body.access_token,
    refresh_token: r.body.refresh_token || rec.refresh_token,
    platform_user_id: rec.platform_user_id,
    scopes: r.body.scope || rec.scopes,
    created_at: rec.created_at,
    expires_at: new Date(Date.now() + (r.body.expires_in || 86400) * 1000).toISOString()
  });
  return r.body.access_token;
}

async function tiktokCreator(env, userId) {
  if (!configured(env, 'tiktok')) return notConfigured('tiktok', env);
  const token = await tiktokAccess(env, userId);
  if (!token) return { available: false, error: 'TikTok authorization required.', platform: 'tiktok', needs_auth: true };

  const fields = 'open_id,username,display_name,avatar_url,bio_description,is_verified,' +
                 'follower_count,following_count,likes_count,video_count';
  const u = await fetchJSON('https://open.tiktokapis.com/v2/user/info/?fields=' + fields, {
    headers: { Authorization: 'Bearer ' + token }, timeout: 9000
  });
  if (!u.ok) return { available: false, error: u.error, platform: 'tiktok' };
  const info = (u.body && u.body.data && u.body.data.user) || {};

  const v = await fetchJSON('https://open.tiktokapis.com/v2/video/list/?fields=' +
    'id,title,create_time,view_count,like_count,comment_count,share_count', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_count: 20 }),
    timeout: 9000
  });
  const videos = ((v.ok && v.body && v.body.data && v.body.data.videos) || []).map(x => ({
    id: x.id, title: x.title || '',
    published_at: x.create_time ? new Date(x.create_time * 1000).toISOString() : '',
    views: num(x.view_count), likes: num(x.like_count),
    comments: num(x.comment_count), shares: num(x.share_count)
  }));

  const unavailable = [];
  if (!v.ok) unavailable.push('recent videos (' + v.error + ')');
  unavailable.push('other creators (needs the Research API, a separate application)');

  return unified({
    platform: 'tiktok',
    id: info.open_id || '',
    username: info.username || '',
    display_name: info.display_name || '',
    profile_url: info.username ? 'https://tiktok.com/@' + info.username : '',
    avatar_url: info.avatar_url || '',
    followers: num(info.follower_count),
    following: num(info.following_count),
    total_content: num(info.video_count),
    verified: !!info.is_verified,
    videos: videos,
    unavailable: unavailable
  });
}

/* ============================================================================
   10. INSTAGRAM — user OAuth, professional accounts
   ============================================================================ */
const IG_SCOPES = 'instagram_basic,instagram_manage_insights,pages_show_list,business_management';

function instagramAuthUrl(env, state, redirect) {
  const q = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    redirect_uri: redirect,
    scope: IG_SCOPES,
    response_type: 'code',
    state: state
  });
  return 'https://www.facebook.com/v19.0/dialog/oauth?' + q.toString();
}

async function instagramExchange(env, code, redirect) {
  const q = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    redirect_uri: redirect,
    code: code
  });
  return fetchJSON('https://graph.facebook.com/v19.0/oauth/access_token?' + q.toString(), { timeout: 9000 });
}

async function instagramCreator(env, userId) {
  if (!configured(env, 'instagram')) return notConfigured('instagram', env);
  const rec = await getToken(env, userId, 'instagram');
  if (!rec || !rec.access_token) {
    return { available: false, error: 'Instagram authorization required.', platform: 'instagram', needs_auth: true };
  }
  const token = rec.access_token;

  let igId = rec.platform_user_id;
  if (!igId) {
    /* An Instagram professional account is reached through the Facebook Page
       it is linked to. A personal account has no Page and lands here, which is
       the single most common reason this integration "does not work". */
    const pages = await fetchJSON(
      'https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account&access_token=' +
      encodeURIComponent(token), { timeout: 9000 });
    if (!pages.ok) return { available: false, error: pages.error, platform: 'instagram' };
    const withIg = ((pages.body && pages.body.data) || []).find(p => p.instagram_business_account);
    if (!withIg) {
      return {
        available: false, platform: 'instagram',
        error: 'Instagram account is not a supported professional account. ' +
               'Insights need a Creator or Business account linked to a Facebook Page.'
      };
    }
    igId = withIg.instagram_business_account.id;
    rec.platform_user_id = igId;
    await putToken(env, userId, 'instagram', rec);
  }

  const prof = await fetchJSON('https://graph.facebook.com/v19.0/' + igId +
    '?fields=username,name,biography,followers_count,follows_count,media_count,profile_picture_url' +
    '&access_token=' + encodeURIComponent(token), { timeout: 9000 });
  if (!prof.ok) return { available: false, error: prof.error, platform: 'instagram' };
  const p = prof.body || {};

  const media = await fetchJSON('https://graph.facebook.com/v19.0/' + igId +
    '/media?fields=id,caption,timestamp,like_count,comments_count,media_type&limit=25' +
    '&access_token=' + encodeURIComponent(token), { timeout: 9000 });
  const videos = ((media.ok && media.body && media.body.data) || []).map(x => ({
    id: x.id, title: (x.caption || '').slice(0, 90),
    published_at: x.timestamp || '',
    likes: num(x.like_count), comments: num(x.comments_count)
  }));

  const unavailable = ['views per post (Graph reports reach and impressions, not views, for most media types)'];
  if (!media.ok) unavailable.push('recent media (' + media.error + ')');

  return unified({
    platform: 'instagram',
    id: igId,
    username: p.username || '',
    display_name: p.name || '',
    profile_url: p.username ? 'https://instagram.com/' + p.username : '',
    avatar_url: p.profile_picture_url || '',
    followers: num(p.followers_count),
    following: num(p.follows_count),
    total_content: num(p.media_count),
    videos: videos,
    unavailable: unavailable
  });
}

/* ============================================================================
   11. DEMO DATA
   ============================================================================
   Only ever served when it is asked for by name (?demo=1) or when nothing is
   configured at all. It is never substituted for a real call that failed —
   a failure returns the failure, because a dashboard that quietly shows
   invented numbers when the API is down is worse than one that says it is down.
   ---------------------------------------------------------------------------- */
function demoCreator(platform) {
  const seed = { youtube: 48200, tiktok: 12800, instagram: 7400, twitch: 3100 }[platform] || 5000;
  const videos = [];
  for (let i = 0; i < 12; i++) {
    /* One deliberate outlier, so the median-vs-mean gap this file exists to
       measure is actually visible in demo mode. */
    const spike = i === 3 ? 9 : 1;
    videos.push({
      id: 'demo' + i, title: 'Demo video ' + (i + 1),
      published_at: new Date(Date.now() - i * 3.2 * 86400000).toISOString(),
      views: Math.round(seed * (0.5 + (i % 5) * 0.12) * spike),
      likes: Math.round(seed * 0.06 * spike),
      comments: Math.round(seed * 0.008 * spike),
      shares: platform === 'tiktok' ? Math.round(seed * 0.01 * spike) : undefined
    });
  }
  const out = unified({
    platform: platform, id: 'demo', username: 'demo_creator',
    display_name: 'Demo Creator', profile_url: '', avatar_url: '',
    followers: seed, following: 310, total_views: seed * 22, total_content: 140,
    country: 'PT', language: 'en', niche: 'gaming', verified: false,
    videos: videos, data_source: 'demo', demo: true,
    unavailable: ['everything here is generated — not a real account']
  });
  out.demo = true;
  return out;
}

/* ============================================================================
   12. ROUTES
   ============================================================================ */
function html(body, status) {
  return new Response(body, { status: status || 200,
    headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, CORS) });
}

/* The OAuth `state` is signed with the encryption secret so the callback can
   prove the round trip started here. Without it, anyone can call the callback
   with their own code and attach their account to another user's record. */
async function signState(env, payload) {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY || 'x'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return b64.enc(new TextEncoder().encode(raw)) + '.' + b64.enc(sig);
}

async function readState(env, state) {
  try {
    const [rawB64, sigB64] = String(state).split('.');
    const raw = new TextDecoder().decode(b64.dec(rawB64));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY || 'x'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, b64.dec(sigB64), new TextEncoder().encode(raw));
    if (!ok) return null;
    const p = JSON.parse(raw);
    /* Ten minutes is long enough to finish a consent screen and short enough
       that a leaked link is useless later. */
    if (!p.t || Date.now() - p.t > 600000) return null;
    return p;
  } catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const redirectBase = env.PUBLIC_URL || (url.origin);

    /* ---------- health ---------- */
    if (path === '/health') {
      return json({
        ok: true,
        worker: 'integrations',
        db: env.DB ? 'bound' : 'MISSING — Settings -> Bindings -> Add -> KV namespace, variable name DB',
        encryption: env.TOKEN_ENCRYPTION_KEY ? 'configured' : 'MISSING — OAuth connections will be refused',
        platforms: Object.keys(CONFIG).reduce((a, k) => {
          a[k] = configured(env, k) ? 'configured' : 'missing';
          return a;
        }, {})
      });
    }

    /* ---------- 12. status ---------- */
    if (path === '/api/integrations/status') {
      const out = {};
      for (const k of Object.keys(CONFIG)) {
        out[k] = { configured: configured(env, k), label: CONFIG[k].label, oauth: CONFIG[k].oauth };
        if (!out[k].configured) out[k].missing = missingVars(env, k);
      }
      out.database = { configured: !!env.DB, label: 'Database' };
      out.encryption = { configured: !!env.TOKEN_ENCRYPTION_KEY, label: 'Token encryption' };
      out.admin = { configured: !!env.ADMIN_TOKEN, label: 'Admin token' };
      if (!out.admin.configured) out.admin.missing = ['ADMIN_TOKEN'];
      const published = await dbRead(env, 'channels');
      out.channel_database = {
        configured: !!published,
        label: 'Channel database',
        channels: published ? published.length : 0
      };
      /* No secret, no token, no key — only booleans and variable NAMES. */
      return json(out);
    }

    /* ---------- 15. live connection tests ---------- */
    if (path === '/api/integrations/test') {
      const p = url.searchParams.get('platform') || '';
      if (!CONFIG[p]) return json({ error: 'unknown platform' }, 400);
      if (!configured(env, p)) return json(notConfigured(p, env), 200);

      if (p === 'youtube') {
        /* A one-unit call that proves the key works without spending quota. */
        const r = await ytCall(env, 'channels', { part: 'id', id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' });
        return json({ available: r.ok, platform: p, error: r.ok ? null : r.error });
      }
      if (p === 'twitch') {
        const t = await twitchToken(env);
        return json({ available: !!t, platform: p,
          error: t ? null : 'Could not get an app token — check the client id and secret.' });
      }
      if (p === 'ai') {
        return json({ available: true, platform: p,
          note: 'Model keys live on ai-worker.js; this only reports whether they are set here.' });
      }
      /* TikTok and Instagram cannot be tested without a user having connected:
         there is nothing to call that does not need their token. */
      return json({ available: true, platform: p, requires_user_auth: true,
        note: 'Credentials are present. A real check needs a connected account.' });
    }

    /* ---------- OAuth: start ---------- */
    let m = path.match(/^\/auth\/(tiktok|instagram)$/);
    if (m) {
      const p = m[1];
      if (!configured(env, p)) return json(notConfigured(p, env), 400);
      if (!env.TOKEN_ENCRYPTION_KEY) {
        return json({ error: 'TOKEN_ENCRYPTION_KEY is not set. Refusing to start OAuth, because the ' +
          'token would have to be stored unencrypted.' }, 500);
      }
      const user = url.searchParams.get('user') || 'me';
      const state = await signState(env, { u: user, p: p, t: Date.now() });
      const redirect = redirectBase + '/auth/' + p + '/callback';
      const dest = p === 'tiktok' ? tiktokAuthUrl(env, state, redirect) : instagramAuthUrl(env, state, redirect);
      return Response.redirect(dest, 302);
    }

    /* ---------- OAuth: callback ---------- */
    m = path.match(/^\/auth\/(tiktok|instagram)\/callback$/);
    if (m) {
      const p = m[1];
      const err = url.searchParams.get('error') || url.searchParams.get('error_description');
      if (err) return html(page('Not connected', 'The platform said: ' + esc(err)), 400);

      const st = await readState(env, url.searchParams.get('state'));
      if (!st || st.p !== p) {
        return html(page('Not connected',
          'That authorization did not start here, or it took longer than ten minutes.'), 400);
      }
      const code = url.searchParams.get('code');
      if (!code) return html(page('Not connected', 'No authorization code came back.'), 400);

      const redirect = redirectBase + '/auth/' + p + '/callback';
      const r = p === 'tiktok'
        ? await tiktokExchange(env, code, redirect)
        : await instagramExchange(env, code, redirect);
      if (!r.ok || !r.body || !r.body.access_token) {
        return html(page('Not connected', 'The token exchange failed: ' + esc(r.error || 'unknown')), 502);
      }

      const stored = await putToken(env, st.u, p, {
        access_token: r.body.access_token,
        refresh_token: r.body.refresh_token || '',
        platform_user_id: r.body.open_id || '',
        scopes: r.body.scope || '',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + (r.body.expires_in || 3600) * 1000).toISOString()
      });
      if (!stored) return html(page('Not connected', 'Could not store the token — is the DB binding set?'), 500);

      return html(page(CONFIG[p].label + ' connected',
        'You can close this tab and go back to NovaClip.'));
    }

    /* ---------- 7. disconnect ---------- */
    m = path.match(/^\/api\/integrations\/(tiktok|instagram|youtube|twitch)\/disconnect$/);
    if (m && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const user = (body && body.user) || 'me';
      await dropToken(env, user, m[1]);
      /* The cached creator record has to go too. Without this, five minutes of
         someone's follower counts and video stats stay readable after they
         asked to be disconnected. */
      if (env.DB) {
        try { await env.DB.delete('cache:' + m[1] + ':' + user); } catch (e) {}
        try { await env.DB.delete('cache:' + m[1] + ':me'); } catch (e) {}
      }
      return json({ ok: true, platform: m[1], connected: false });
    }

    /* ---------- creator lookup ---------- */
    m = path.match(/^\/api\/creator\/(youtube|twitch|tiktok|instagram)$/);
    if (m) {
      const p = m[1];
      const id = url.searchParams.get('id') || url.searchParams.get('user') || '';
      const wantDemo = url.searchParams.get('demo') === '1';

      if (wantDemo) return json(demoCreator(p));
      if (!configured(env, p)) {
        /* Nothing configured: say so, and offer demo explicitly rather than
           quietly returning invented numbers. */
        const nc = notConfigured(p, env);
        nc.demo_available = true;
        nc.demo_url = url.pathname + '?demo=1';
        return json(nc, 200);
      }

      const key = p + ':' + id;
      const out = await cached(env, key, 300, async () => {
        if (p === 'youtube') return ytCreator(env, id);
        if (p === 'twitch') return twitchCreator(env, id);
        if (p === 'tiktok') return tiktokCreator(env, id || 'me');
        return instagramCreator(env, id || 'me');
      });
      return json(out, out && out.available === false ? 200 : 200);
    }

    /* ---------- batch, for ranking ---------- */
    if (path === '/api/creators' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const list = Array.isArray(body.creators) ? body.creators.slice(0, 25) : [];
      const out = [];
      for (const c of list) {
        const p = c.platform, id = c.id;
        if (!CONFIG[p]) { out.push({ platform: p, available: false, error: 'unknown platform' }); continue; }
        if (!configured(env, p)) { out.push(notConfigured(p, env)); continue; }
        out.push(await cached(env, p + ':' + id, 300, async () => {
          if (p === 'youtube') return ytCreator(env, id);
          if (p === 'twitch') return twitchCreator(env, id);
          if (p === 'tiktok') return tiktokCreator(env, id || 'me');
          return instagramCreator(env, id || 'me');
        }));
      }
      /* Ranked by median rather than mean, for the reason in section 5. */
      out.sort((a, b) => (b.median_views || 0) - (a.median_views || 0));
      return json({ creators: out });
    }

    /* ---------- 16. the channel database ----------
       Built by database/build.js and published here as KV records. The Worker
       classifies nothing at request time on purpose: a verdict that can change
       between two reads is not a verdict, and the build produces an audit
       trail that a request handler has nowhere to keep. */
    if (path === '/api/database') {
      const db = await dbRead(env, 'channels');
      if (!db) return json(dbEmpty(), 503);
      return json(queryDatabase(db, url.searchParams));
    }

    if (path === '/api/database/stats') {
      const db = await dbRead(env, 'channels');
      if (!db) return json(dbEmpty(), 503);
      return json(statsOf(db, await dbRead(env, 'report')));
    }

    /* The two lists that are never served without the admin token. `rejected`
       is a list of channels with reasons they were removed attached — serving
       that publicly would be publishing an accusation about real people. */
    m = path.match(/^\/api\/database\/(review|rejected)$/);
    if (m) {
      if (!admin(request, env)) return json({ error: 'admin token required' }, 401);
      const list = await dbRead(env, m[1]);
      return json({ list: m[1], count: (list && list.length) || 0, channels: list || [] });
    }

    m = path.match(/^\/api\/database\/(youtube|twitch|tiktok|instagram)\/([\w.@-]+)$/);
    if (m) {
      const db = await dbRead(env, 'channels');
      if (!db) return json(dbEmpty(), 503);
      const want = m[2].toLowerCase();
      const hit = db.find(c => c.platform === m[1] &&
        (String(c.platform_creator_id).toLowerCase() === want ||
         String(c.username || '').toLowerCase().replace(/^@/, '') === want.replace(/^@/, '')));
      return hit ? json(hit) : json({ error: 'not in the database' }, 404);
    }

    if (path === '/api/database/publish' && request.method === 'POST') {
      if (!admin(request, env)) return json({ error: 'admin token required' }, 401);
      if (!env.DB) return json({ error: 'KV binding DB is missing' }, 500);
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!Array.isArray(body.channels)) return json({ error: 'channels[] is required' }, 400);

      await env.DB.put('db:channels', JSON.stringify(body.channels));
      await env.DB.put('db:review', JSON.stringify(body.review || []));
      await env.DB.put('db:rejected', JSON.stringify(body.rejected || []));
      await env.DB.put('db:report', JSON.stringify(body.report || {}));
      return json({
        ok: true, published: body.channels.length,
        review: (body.review || []).length, rejected: (body.rejected || []).length
      });
    }

    return json({
      error: 'not found',
      endpoints: ['/health', '/api/integrations/status', '/api/integrations/test?platform=',
        '/api/creator/{youtube|twitch|tiktok|instagram}?id=', '/api/creators',
        '/auth/tiktok', '/auth/instagram', '/api/integrations/{platform}/disconnect',
        '/api/database', '/api/database/stats', '/api/database/{platform}/{id}',
        '/api/database/review', '/api/database/rejected', '/api/database/publish']
    }, 404);
  }
};

/* ============================================================================
   17. DATABASE HELPERS
   ============================================================================ */

async function dbRead(env, name) {
  if (!env.DB) return null;
  try { return await env.DB.get('db:' + name, 'json'); } catch (e) { return null; }
}

function dbEmpty() {
  return {
    error: 'the database has not been published yet',
    fix: 'run `node database/build.js --publish <this worker url>` with ADMIN_TOKEN set',
    channels: [], count: 0, total: 0
  };
}

/* Length-independent comparison. A token check that returns early on the first
   wrong byte leaks the token one byte at a time to anyone patient enough. */
function admin(request, env) {
  const want = env.ADMIN_TOKEN;
  if (!want) return false;
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const SORTS = {
  followers: c => c.followers || 0,
  median_views: c => c.median_views || 0,
  average_views: c => c.average_views || 0,
  engagement: c => c.engagement_rate || 0,
  uploads: c => c.uploads_last_30_days || 0,
  safety: c => (c.safety && c.safety.safety_score) || 0,
  views_per_follower: c => c.views_per_follower || 0,
  total_views: c => c.total_views || 0
};

function queryDatabase(db, q) {
  const text = (q.get('q') || '').trim().toLowerCase();
  const platform = q.get('platform') || '';
  const niche = q.get('niche') || '';
  const tier = q.get('tier') || '';
  const country = q.get('country') || '';
  const min = parseInt(q.get('min_followers') || '0', 10) || 0;
  const max = parseInt(q.get('max_followers') || '0', 10) || 0;
  const sort = SORTS[q.get('sort')] ? q.get('sort') : 'median_views';
  const order = q.get('order') === 'asc' ? 1 : -1;
  const limit = Math.min(200, Math.max(1, parseInt(q.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);

  let rows = db.filter(c => {
    if (platform && c.platform !== platform) return false;
    if (niche && c.niche !== niche) return false;
    if (tier && c.tier !== tier) return false;
    if (country && c.country !== country) return false;
    if (min && (c.followers || 0) < min) return false;
    if (max && (c.followers || 0) > max) return false;
    if (text) {
      const hay = [c.display_name, c.username, c.title, c.description, c.niche].join(' ').toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });

  const pick = SORTS[sort];
  rows.sort((a, b) => (pick(a) - pick(b)) * order);

  return {
    count: rows.length,
    total: db.length,
    limit, offset, sort, order: order === 1 ? 'asc' : 'desc',
    facets: facetsOf(db),
    channels: rows.slice(offset, offset + limit)
  };
}

function facetsOf(db) {
  const count = (key) => db.reduce((a, c) => {
    const v = c[key];
    if (v) a[v] = (a[v] || 0) + 1;
    return a;
  }, {});
  return { platform: count('platform'), niche: count('niche'), tier: count('tier'), country: count('country') };
}

function statsOf(db, report) {
  const sum = (f) => db.reduce((a, c) => a + (f(c) || 0), 0);
  const eng = db.map(c => c.engagement_rate || 0).filter(n => n > 0);
  return {
    channels: db.length,
    total_followers: sum(c => c.followers),
    total_views: sum(c => c.total_views),
    median_engagement_rate: median(eng),
    by_platform: facetsOf(db).platform,
    by_tier: facetsOf(db).tier,
    by_niche: facetsOf(db).niche,
    /* The counts that say what the filter actually did, rather than only what
       survived it. A database that never rejects anything is not filtered. */
    last_build: report || null
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* The only HTML this Worker serves: the two OAuth landing pages. */
function page(title, msg) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + ' — NovaClip</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070E;color:#EAF2FF;' +
    'font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}' +
    '.c{max-width:44ch;text-align:center;border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:30px;' +
    'background:rgba(255,255,255,.04)}h1{font-size:1.3rem;margin:0 0 10px}p{color:#8A97B4;margin:0}</style>' +
    '<div class="c"><h1>' + esc(title) + '</h1><p>' + esc(msg) + '</p></div>';
}

/* Exported for the unit tests in tests/metrics.test.mjs. Workers ignore this. */
export const __test = { median, mean, tierOf, engagementRate, uploadsInLast30, unified, confidenceOf, describe };
