/* Unit tests for the parts of integrations-worker.js that are pure functions:
   the metrics, the tiers and the normalisation. Those are where a quiet
   mistake does real damage — a wrong median ranks the wrong creator top — and
   they are the only parts that can be tested without live credentials.

   Run:  node --test tests/
   ---------------------------------------------------------------------------- */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as M } from '../integrations-worker.js';

test('median ignores order and handles even counts', () => {
  assert.equal(M.median([5, 1, 3]), 3);
  assert.equal(M.median([4, 1, 3, 2]), 3);          // (2+3)/2 = 2.5 -> rounded
  assert.equal(M.median([]), 0);
  assert.equal(M.median([7]), 7);
});

test('median is not moved by one viral post, mean is', () => {
  // eleven normal videos and one that caught the algorithm
  const normal = [1000, 1100, 900, 1050, 950, 1000, 1020, 980, 1010, 990, 1030];
  const withSpike = normal.concat([500000]);

  assert.equal(M.median(normal), 1000);
  // twelve values now, so the median averages the 6th and 7th: 1000 and 1010
  assert.equal(M.median(withSpike), 1005);           // barely moves
  assert.ok(M.mean(withSpike) > 40000);              // mean is wrecked

  // this gap is the entire reason ranking uses median
  assert.ok(M.mean(withSpike) / M.median(withSpike) > 40);
});

test('creator tiers match the published boundaries', () => {
  assert.equal(M.tierOf(0), 'Below Nano');
  assert.equal(M.tierOf(999), 'Below Nano');
  assert.equal(M.tierOf(1000), 'Nano');
  assert.equal(M.tierOf(9999), 'Nano');
  assert.equal(M.tierOf(10000), 'Micro');
  assert.equal(M.tierOf(49999), 'Micro');
  assert.equal(M.tierOf(50000), 'Macro');
  assert.equal(M.tierOf(499999), 'Macro');
  assert.equal(M.tierOf(500000), 'Mega');
  assert.equal(M.tierOf(12000000), 'Mega');
});

test('engagement is measured against views when views are known', () => {
  // 100 likes + 10 comments on 1000 median views = 11%
  const r = M.engagementRate({ median_likes: 100, median_comments: 10, median_shares: 0, median_views: 1000, followers: 50000 });
  assert.equal(r, 11);
});

test('engagement uses medians on BOTH sides, so a spike cannot inflate it', () => {
  // eleven ordinary posts and one that went off. Mean likes is wrecked by the
  // spike while median views is not, and mixing the two reported 177%.
  const videos = [];
  for (let i = 0; i < 11; i++) videos.push({ views: 2000, likes: 200, comments: 20, shares: 10 });
  videos.push({ views: 90000, likes: 9000, comments: 900, shares: 400 });

  const u = M.unified({ platform: 'tiktok', followers: 15000, videos: videos });
  assert.equal(u.median_views, 2000);
  assert.ok(u.average_views > 9000, 'mean should be dragged up by the spike');
  // 200 + 20 + 10 over 2000 = 11.5%
  assert.equal(u.engagement_rate, 11.5);
  assert.ok(u.engagement_rate <= 100);
});

test('engagement falls back to followers when views are unavailable', () => {
  // Instagram gives likes and comments but not views on most media
  const r = M.engagementRate({ median_likes: 50, median_comments: 5, median_shares: 0, median_views: 0, followers: 1000 });
  assert.equal(r, 5.5);
});

test('engagement is clamped, so a hidden view count cannot report 900%', () => {
  const r = M.engagementRate({ median_likes: 9000, median_comments: 0, median_shares: 0, median_views: 0, followers: 1000 });
  assert.equal(r, 100);
});

test('engagement of an empty creator is zero, not NaN', () => {
  assert.equal(M.engagementRate({}), 0);
});

test('uploads in the last 30 days counts only the last 30 days', () => {
  const day = 86400000;
  const dates = [
    new Date(Date.now() - 2 * day).toISOString(),
    new Date(Date.now() - 29 * day).toISOString(),
    new Date(Date.now() - 31 * day).toISOString(),
    new Date(Date.now() - 400 * day).toISOString(),
    'not a date'
  ];
  assert.equal(M.uploadsInLast30(dates), 2);
});

test('unified fills the whole contract from a partial platform payload', () => {
  const u = M.unified({
    platform: 'youtube', id: 'UC123', username: 'someone', display_name: 'Someone',
    followers: 25000, total_views: 900000, total_content: 120,
    videos: [
      { views: 1000, likes: 100, comments: 10, published_at: new Date().toISOString() },
      { views: 3000, likes: 300, comments: 30, published_at: new Date().toISOString() },
      { views: 2000, likes: 200, comments: 20, published_at: new Date().toISOString() }
    ]
  });

  // every key in the agreed shape exists
  ['platform','platform_creator_id','username','display_name','profile_url','avatar_url',
   'followers','following','total_views','total_content','average_views','median_views',
   'average_likes','average_comments','average_shares','engagement_rate','views_per_follower',
   'uploads_last_30_days','country','language','niche','verified','data_source',
   'data_confidence','last_updated'].forEach(k => {
    assert.ok(k in u, 'missing key: ' + k);
  });

  assert.equal(u.median_views, 2000);
  assert.equal(u.average_views, 2000);
  assert.equal(u.tier, 'Micro');
  assert.equal(u.uploads_last_30_days, 3);
  assert.equal(u.data_source, 'youtube_official_api');
  assert.equal(u.demo, false);
});

test('views per follower uses median, so a spike cannot inflate it', () => {
  const u = M.unified({
    platform: 'tiktok', followers: 1000,
    videos: [{ views: 500 }, { views: 500 }, { views: 400000 }]
  });
  assert.equal(u.median_views, 500);
  assert.equal(u.views_per_follower, 0.5);           // not 133.6
});

test('confidence rises with how much was actually measured', () => {
  const thin = M.confidenceOf({ followers: 100 }, 0);
  const rich = M.confidenceOf({ followers: 100, total_views: 5, total_content: 5, country: 'PT', verified: false }, 12);
  assert.ok(rich > thin);
  assert.ok(rich <= 1);
  assert.ok(thin >= 0);
});

test('error descriptions are actionable and carry the vendor message', () => {
  const d = M.describe(403, { error: { message: 'quotaExceeded' } });
  assert.match(d, /access denied/);
  assert.match(d, /quotaExceeded/);
  assert.match(M.describe(429, null), /rate limited/);
  assert.match(M.describe(401, null), /expired/);
});

test('a hidden subscriber count is zero rather than a guess', () => {
  const u = M.unified({ platform: 'youtube', followers: 0, videos: [{ views: 10 }] });
  assert.equal(u.followers, 0);
  assert.equal(u.tier, 'Below Nano');
  assert.equal(u.views_per_follower, 0);             // no divide by zero
});
