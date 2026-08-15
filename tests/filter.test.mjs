/* Tests for the safety classifier.

   A content filter fails in two directions and only one of them is visible.
   Letting something through gets noticed; removing a legitimate channel is
   silent, because the person it happened to never finds out. So most of what
   follows tests the second direction: the history channel, the mental health
   channel, the scam-warning channel — the ones a careless word list deletes.

   Run:  node --test tests/*.test.mjs
   ---------------------------------------------------------------------------- */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, normalise, deleet, hasTerm, findTerms, contextOf, partition } from '../database/safety/filter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'database', 'safety', 'rules.json'), 'utf8'));
const FIXTURES = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'database', 'seeds', 'fixtures.json'), 'utf8'));

const fixture = id => FIXTURES.find(f => f.safetyInput.id === id).safetyInput;
const verdictOf = input => classify(input, RULES).verdict;

/* A channel with nothing in it, so a test can add exactly one thing. */
function channel(over) {
  return Object.assign({
    platform: 'youtube', id: 'T1', title: '', description: '',
    keywords: [], topics: [], videos: [], flags: {}
  }, over);
}
const videos = (n, title) => Array.from({ length: n }, (_, i) => ({
  title: i === 0 ? title : 'ordinary upload ' + i, description: '', tags: [], age_restricted: false
}));

/* ----------------------------------------------------------------------------
   Text handling
   ---------------------------------------------------------------------------- */

test('normalise folds case, accents and whitespace', () => {
  assert.equal(normalise('  PÖRN   Site '), 'porn site');
  assert.equal(normalise(null), '');
});

test('matching is by word, never by substring', () => {
  // the Scunthorpe problem: substring matching deletes innocent channels and
  // nobody ever tells them why
  assert.equal(hasTerm('nudge nudge', 'nude'), false);
  assert.equal(hasTerm('a nude study', 'nude'), true);
  assert.equal(hasTerm('classical analysis', 'anal'), false);
  assert.equal(hasTerm('scunthorpe united', 'cunt'), false);
  assert.equal(hasTerm('grape harvest', 'rape'), false);
  assert.equal(hasTerm('assassin creed review', 'ass'), false);
});

test('word boundaries hold across scripts', () => {
  // \b is ASCII-only, so a naive regex "matches" inside Cyrillic text
  assert.equal(hasTerm('порносайт', 'porn'), false);
  assert.equal(hasTerm('привет porn привет', 'porn'), true);
});

test('a term with spaces also matches hyphens, underscores and dots', () => {
  assert.equal(hasTerm('free-robux-generator', 'free robux'), true);
  assert.equal(hasTerm('free_robux generator', 'free robux'), true);
  assert.equal(hasTerm('free.robux', 'free robux'), true);
  assert.equal(hasTerm('freerobux', 'free robux'), false);   // no boundary to find
});

test('leetspeak is folded on the severe categories only', () => {
  assert.equal(deleet('fr33 r0bux'), 'free robux');
  const cat = RULES.categories.find(c => c.id === 'scams');
  assert.ok(cat.deleet, 'scams is expected to opt in to folding');
  assert.deepEqual(findTerms('FR33 R0BUX now', ['free robux'], true), ['free robux']);
  assert.deepEqual(findTerms('FR33 R0BUX now', ['free robux'], false), []);
});

test('a term that already contains digits still matches itself once folded', () => {
  // 1488 -> iabb on both sides, which is the point of folding the term too
  assert.deepEqual(findTerms('check the 1488 tag', ['1488'], true), ['1488']);
});

/* ----------------------------------------------------------------------------
   The direction that fails silently
   ---------------------------------------------------------------------------- */

test('a scam-warning channel is not removed for naming the scam it warns about', () => {
  const r = classify(fixture('FIX_scam_awareness'), RULES);
  assert.equal(r.verdict, 'allow');
  assert.equal(r.risk_score, 0);
  // it did match — it was exempted, and the audit trail says so
  const ex = r.reasons.filter(x => x.exempted_by);
  assert.ok(ex.length > 0, 'the match should be recorded as exempted, not hidden');
  assert.ok(ex[0].matched.includes('free robux'));
});

test('a history channel keeps its place while saying what it teaches about', () => {
  const r = classify(fixture('FIX_history'), RULES);
  assert.equal(r.verdict, 'allow');
});

test('a mental health channel is not filed under self-harm', () => {
  assert.equal(verdictOf(fixture('FIX_mental_health')), 'allow');
});

test('context relief is a discount, not an exemption', () => {
  // graphic_violence is severity 4 and context sensitive; relief takes 2 off,
  // and the floor is 1 so a news channel is never scored at zero
  const news = channel({
    title: 'Fixture News', description: 'daily news and investigative journalism',
    videos: [{ title: 'cartel video circulating online', description: '', tags: [] }]
  });
  const plain = channel({
    title: 'Fixture Uploads', description: 'uploads',
    videos: [{ title: 'cartel video circulating online', description: '', tags: [] }]
  });
  const a = classify(news, RULES), b = classify(plain, RULES);
  assert.ok(contextOf(news, RULES).exempt);
  assert.ok(a.risk_score > 0, 'relief must not zero the score');
  assert.ok(a.risk_score < b.risk_score, 'the news channel should score lower than the same words with no context');
});

/* ----------------------------------------------------------------------------
   Thresholds
   ---------------------------------------------------------------------------- */

test('one match in one video title can never remove a channel', () => {
  // the worst case the weights allow: severity 5 at video_title weight
  const c = channel({ title: 'Fixture', description: 'uploads', videos: videos(10, 'thinspo diet') });
  const r = classify(c, RULES);
  assert.equal(r.verdict, 'review');
  assert.ok(r.risk_score < RULES.thresholds.block_at);
});

test('the same words in the channel description do remove it', () => {
  const c = channel({ title: 'Fixture', description: 'thinspo and meanspo daily', videos: videos(10, 'ordinary') });
  assert.equal(classify(c, RULES).verdict, 'block');
});

test('a pattern across uploads blocks what a single upload only flags', () => {
  const vids = Array.from({ length: 10 }, (_, i) => ({
    title: i < 5 ? 'ghost gun build part ' + i : 'ordinary upload', description: '', tags: []
  }));
  const c = classify(channel({ title: 'Fixture', description: 'builds', videos: vids }), RULES);
  assert.equal(c.verdict, 'block');
  assert.ok(c.reasons.some(r => r.rule === 'pattern:flagged_ratio'));
  assert.equal(c.flagged_upload_ratio, 0.5);
});

test('two unrelated categories add up where one alone would not', () => {
  const one = classify(channel({ description: 'daily csgo gambling' }), RULES);
  const two = classify(channel({ description: 'daily csgo gambling and how to get high' }), RULES);
  assert.equal(one.verdict, 'review');
  assert.equal(two.verdict, 'block');
});

test('repeating one word is one behaviour, not ten', () => {
  const once = classify(channel({ description: 'csgo gambling', videos: [] }), RULES).risk_score;
  const lots = classify(channel({
    description: 'csgo gambling', videos: videos(3, 'csgo gambling stream')
  }), RULES);
  // the category contributes once, at its strongest field; the ratio bonus is
  // what reflects repetition, and it is named separately
  assert.equal(lots.categories.gambling.contribution, once);
  assert.ok(lots.reasons.some(r => r.rule === 'pattern:flagged_ratio'));
});

/* ----------------------------------------------------------------------------
   Platform signals
   ---------------------------------------------------------------------------- */

test('a Twitch channel that calls itself mature is taken at its word', () => {
  const r = classify(fixture('FIX_twitch_mature'), RULES);
  assert.equal(r.verdict, 'block');
  assert.ok(r.reasons.some(x => x.rule === 'hard:twitch_mature'));
});

test('age-restricted uploads: one is a question, a pattern is an answer', () => {
  const many = classify(fixture('FIX_age_restricted'), RULES);
  assert.equal(many.verdict, 'block');

  const one = channel({
    title: 'Fixture', description: 'short films',
    videos: Array.from({ length: 20 }, (_, i) => ({
      title: 'film ' + i, description: '', tags: [], age_restricted: i === 0
    }))
  });
  assert.equal(classify(one, RULES).verdict, 'review');   // 1 in 20 is under the ratio
});

/* ----------------------------------------------------------------------------
   Policy properties
   ---------------------------------------------------------------------------- */

test('a quality flag is recorded and never changes the verdict', () => {
  const r = classify(fixture('FIX_bait'), RULES);
  assert.equal(r.verdict, 'allow');
  assert.equal(r.risk_score, 0);
  assert.deepEqual(r.quality_flags.map(q => q.id), ['engagement_bait']);
});

test('a human override beats the score in both directions', () => {
  const bad = channel({ id: 'OV1', description: 'thinspo and meanspo daily' });
  const rules = JSON.parse(JSON.stringify(RULES));
  assert.equal(classify(bad, rules).verdict, 'block');

  rules.overrides.allow = ['youtube:OV1'];
  const allowed = classify(bad, rules);
  assert.equal(allowed.verdict, 'allow');
  assert.ok(allowed.reasons.some(r => r.rule === 'override:allow'), 'the override has to be visible in the reasons');

  rules.overrides.block = ['youtube:OV1'];
  assert.equal(classify(bad, rules).verdict, 'block');    // block wins over allow
});

test('every verdict carries the rule that produced it', () => {
  const r = classify(fixture('FIX_generator'), RULES);
  assert.equal(r.verdict, 'block');
  for (const reason of r.reasons) {
    assert.match(reason.rule, /^(category|quality|hard|pattern|override):/);
  }
  assert.ok(r.reasons.some(x => x.rule === 'category:scams' && x.field === 'channel_title'));
});

test('terms from the uncommitted local list are matched but not echoed back', () => {
  const rules = JSON.parse(JSON.stringify(RULES));
  const c = channel({ description: 'a channel about examplehateterm and nothing else' });
  const r = classify(c, rules, { hate: ['examplehateterm'] });
  const hit = r.reasons.find(x => x.rule === 'category:hate');
  assert.ok(hit, 'the local term should match');
  assert.deepEqual(hit.matched, ['[redacted]']);
  assert.ok(!JSON.stringify(r).includes('examplehateterm'));
});

test('an empty channel is allowed rather than crashing', () => {
  const r = classify(channel({}), RULES);
  assert.equal(r.verdict, 'allow');
  assert.equal(r.risk_score, 0);
  assert.equal(r.flagged_upload_ratio, 0);
});

test('partition sorts a batch into the three buckets and tags the rules version', () => {
  const out = partition(FIXTURES.map(f => f.safetyInput), RULES);
  assert.equal(out.allow.length + out.review.length + out.block.length, FIXTURES.length);
  assert.ok(out.block.length > 0 && out.allow.length > 0);
  assert.equal(out.allow[0].safety.rules_version, RULES.version);
});

test('every fixture lands where its _case says it should', () => {
  // the fixtures are documentation; this keeps them honest
  const expected = {
    FIX_clean_education: 'allow', FIX_scam_awareness: 'allow', FIX_history: 'allow',
    FIX_mental_health: 'allow', FIX_bait: 'allow', FIX_one_slip: 'review',
    FIX_generator: 'block', FIX_gambling: 'block', FIX_twitch_mature: 'block',
    FIX_age_restricted: 'block'
  };
  for (const f of FIXTURES) {
    assert.equal(verdictOf(f.safetyInput), expected[f.safetyInput.id], f.safetyInput.id + ' — ' + f._case);
  }
});
