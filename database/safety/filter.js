/* Content safety classifier
   ============================================================================
   This module holds no policy. Every term, weight and threshold comes from
   rules.json, and every verdict carries the exact rule that produced it, so
   "why was this channel removed" is answerable without reading any code.

   Three verdicts, not two:

     allow    nothing fired, or only signals too weak to mean anything
     review   something fired, but not enough to remove a channel over —
              a human decides
     block    kept out of the database, with reasons recorded

   `review` exists because term matching cannot tell a documentary about drug
   cartels from a channel selling drugs, and pretending otherwise produces a
   filter that removes journalism and keeps the actual problem. Everything
   ambiguous lands in review rather than being guessed at.

   Pure functions only — no fs, no fetch, no clock. The pipeline does the I/O.
   ---------------------------------------------------------------------------- */

/* ----------------------------------------------------------------------------
   Text normalisation
   ---------------------------------------------------------------------------- */

/* Lowercase, strip diacritics, flatten whitespace. Diacritics matter: "pörn"
   and "porn" are the same word to a reader and to anyone evading a filter. */
export function normalise(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/* Character substitutions used to slip past exact matching. Applied to the
   text AND to the term, so a term that already contains digits ("1488") still
   matches itself after both sides are folded. */
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'l' };

export function deleet(s) {
  return normalise(s).replace(/[0134578@$!|]/g, c => LEET[c] || c);
}

/* ----------------------------------------------------------------------------
   Matching

   Word boundaries, never substrings. Substring matching is how a filter blocks
   Scunthorpe, Penistone and every channel with "analysis" in the title — the
   classic own goal, and one that quietly deletes real creators.

   \b is ASCII-only, so the boundaries are unicode letter/number lookarounds
   instead; otherwise a term would "match" inside a Cyrillic or Greek word.
   Spaces in a term match any run of space, hyphen, underscore or dot, which
   covers free-robux-generator and free_robux_generator.
   ---------------------------------------------------------------------------- */
const RX_CACHE = new Map();

export function termRegex(term) {
  let rx = RX_CACHE.get(term);
  if (rx) return rx;
  const body = String(term)
    .split(/\s+/)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\-_.]+');
  rx = new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'u');
  RX_CACHE.set(term, rx);
  return rx;
}

export function hasTerm(text, term) {
  return termRegex(term).test(text);
}

/* Returns every term from `terms` present in `text`. `folded` enables the
   leetspeak pass, which is only worth its false positives on the severe
   categories, so rules.json turns it on per category. */
export function findTerms(text, terms, folded) {
  const plain = normalise(text);
  const alt = folded ? deleet(text) : null;
  const hits = [];
  for (const t of terms) {
    if (hasTerm(plain, normalise(t))) { hits.push(t); continue; }
    if (alt && hasTerm(alt, deleet(t))) hits.push(t);
  }
  return hits;
}

/* ----------------------------------------------------------------------------
   The fields a channel exposes, and what each is worth

   A term in the channel's own name or description is the channel describing
   itself. The same term in one video title out of twenty-five is much weaker
   evidence, so it is weighted down rather than treated as equal.
   ---------------------------------------------------------------------------- */
function fieldsOf(channel) {
  const out = [
    { field: 'channel_title', text: channel.title || '', video: null },
    { field: 'channel_description', text: channel.description || '', video: null },
    { field: 'channel_keywords', text: (channel.keywords || []).join(' '), video: null }
  ];
  const vids = channel.videos || [];
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i] || {};
    out.push({ field: 'video_title', text: v.title || '', video: i });
    out.push({ field: 'video_description', text: v.description || '', video: i });
    out.push({ field: 'video_tags', text: (v.tags || []).join(' '), video: i });
  }
  return out.filter(f => f.text);
}

/* Is this channel plainly a news, education or medical channel? Those say the
   words the filter watches for as part of doing their job. */
export function contextOf(channel, rules) {
  const ex = rules.context_exemptions || {};
  const text = [channel.title, channel.description, (channel.keywords || []).join(' ')].join(' ');
  const byTerm = findTerms(text, ex.terms || [], false);
  const topics = channel.topics || [];
  const byTopic = (ex.topics || []).filter(t => topics.includes(t));
  return { exempt: byTerm.length > 0 || byTopic.length > 0, terms: byTerm, topics: byTopic };
}

/* ----------------------------------------------------------------------------
   Classification
   ----------------------------------------------------------------------------
   `external` is the optional locally-loaded term list keyed by category id —
   see rules.json for why slurs are not committed to this repository.
   ---------------------------------------------------------------------------- */
export function classify(channel, rules, external) {
  external = external || {};
  const W = rules.field_weights || {};
  const T = rules.thresholds || {};
  const key = channel.platform + ':' + channel.id;

  const reasons = [];
  const categories = {};
  const quality = [];
  const flaggedVideos = new Set();
  const totalVideos = (channel.videos || []).length;
  let score = 0;

  /* --- 1. human overrides, which beat every score below --- */
  const ov = rules.overrides || {};
  if ((ov.block || []).includes(key)) {
    return verdict('block', 100, [{ rule: 'override:block', detail: 'listed in rules.json overrides.block' }], {}, [], channel, 0);
  }
  const allowlisted = (ov.allow || []).includes(key);

  /* --- 2. term categories --- */
  const ctx = contextOf(channel, rules);
  const fields = fieldsOf(channel);

  for (const cat of rules.categories || []) {
    const terms = (cat.terms || []).concat(external[cat.id] || []);
    const externalSet = new Set(external[cat.id] || []);
    if (!terms.length) continue;
    /* A quality category is recorded on the row and never reaches the verdict.
       Bait is annoying; it is not a reason to remove someone. */
    const isQuality = cat.kind === 'quality';

    /* Context relief applies to categories whose words are also the vocabulary
       of reporting on them. Never below 1 — a discount, not an exemption. */
    let severity = cat.severity;
    let relieved = false;
    if (cat.context_sensitive && ctx.exempt) {
      severity = Math.max(1, severity - (T.context_relief || 2));
      relieved = true;
    }

    let best = 0;
    const catReasons = [];

    for (const f of fields) {
      const hits = findTerms(f.text, terms, !!cat.deleet);
      if (!hits.length) continue;

      /* An exemption phrase in the SAME field drops that field's hits. A video
         called "how scams like free robux work" is a warning, not a scam. */
      const exempted = findTerms(f.text, cat.exemptions || [], false);
      if (exempted.length) {
        catReasons.push({
          rule: 'category:' + cat.id, field: f.field, video: f.video,
          matched: hits.map(h => (externalSet.has(h) && cat.redact_external ? '[redacted]' : h)),
          exempted_by: exempted, severity: 0, contribution: 0,
          detail: 'matched but exempted in the same field'
        });
        continue;
      }

      const weight = W[f.field] == null ? 0.5 : W[f.field];
      const contribution = severity * weight;
      /* Only safety categories count towards the pattern bonus below. */
      if (f.video != null && !isQuality) flaggedVideos.add(f.video);
      if (contribution > best) best = contribution;

      catReasons.push({
        rule: (isQuality ? 'quality:' : 'category:') + cat.id, field: f.field, video: f.video,
        matched: hits.map(h => (externalSet.has(h) && cat.redact_external ? '[redacted]' : h)),
        severity: severity, base_severity: cat.severity,
        context_relief: relieved, weight: weight,
        contribution: Math.round(contribution * 100) / 100
      });
    }

    if (best > 0) {
      if (isQuality) {
        quality.push({ id: cat.id, label: cat.label });
      } else {
        /* One contribution per category, the strongest. Otherwise a channel
           that says the same word in ten titles scores ten times for one
           behaviour. */
        score += best;
        categories[cat.id] = { label: cat.label, severity: severity, contribution: Math.round(best * 100) / 100 };
      }
    }
    reasons.push(...catReasons);
  }

  /* --- 3. platform signals: what the platform itself declares --- */
  let forcedBlock = null;
  for (const sig of rules.hard_signals || []) {
    const hit = hardSignal(sig, channel, totalVideos);
    if (!hit) continue;
    score += sig.score || 0;
    reasons.push({
      rule: 'hard:' + sig.id, detail: hit.detail, severity: sig.score,
      contribution: sig.score, source: sig.source
    });
    if (hit.force) forcedBlock = 'hard:' + sig.id;
  }

  /* --- 4. how much of the output this is, not just whether it happened --- */
  const ratio = totalVideos ? flaggedVideos.size / totalVideos : 0;
  if (ratio >= (T.flagged_ratio_block || 0.35)) {
    score += T.ratio_bonus_block || 3;
    reasons.push({
      rule: 'pattern:flagged_ratio', detail: pct(ratio) + ' of recent uploads matched a category',
      contribution: T.ratio_bonus_block || 3
    });
  } else if (ratio >= (T.flagged_ratio_review || 0.15)) {
    score += T.ratio_bonus_review || 1.5;
    reasons.push({
      rule: 'pattern:flagged_ratio', detail: pct(ratio) + ' of recent uploads matched a category',
      contribution: T.ratio_bonus_review || 1.5
    });
  }

  /* --- 5. verdict ---
     Compared at two decimals, because 3 * 0.6 is 1.7999999999999998 and a
     threshold written as 1.8 in rules.json has to mean 1.8. Without this the
     weakest safety category lands one float short of review and a channel
     that the policy says a human should see is quietly let through. */
  score = round(score);
  let v;
  if (forcedBlock) v = 'block';
  else if (score >= (T.block_at || 5)) v = 'block';
  else if (score >= (T.review_at || 1.8)) v = 'review';
  else v = 'allow';

  if (allowlisted && v !== 'allow') {
    reasons.push({ rule: 'override:allow', detail: 'listed in rules.json overrides.allow; score was ' + round(score) + ' (' + v + ')' });
    v = 'allow';
  }

  return verdict(v, score, reasons, categories, quality, channel, ratio);
}

function verdict(v, score, reasons, categories, quality, channel, ratio) {
  return {
    verdict: v,
    risk_score: round(score),
    quality_flags: quality,
    /* 0-100, higher is safer. For sorting and for a badge; the verdict is what
       decides membership. */
    safety_score: Math.max(0, Math.min(100, Math.round(100 - score * 12))),
    categories: categories,
    flagged_upload_ratio: Math.round(ratio * 1000) / 1000,
    reasons: reasons.filter(r => r.contribution !== 0 || r.exempted_by || r.rule.startsWith('override')),
    reviewed_at: null,
    rules_version: null,
    channel: channel.platform + ':' + channel.id
  };
}

function hardSignal(sig, channel, totalVideos) {
  const flags = channel.flags || {};

  if (sig.id === 'youtube_age_restricted') {
    const n = (channel.videos || []).filter(v => v && v.age_restricted).length;
    if (!n) return null;
    const ratio = totalVideos ? n / totalVideos : 0;
    return {
      detail: n + ' of ' + totalVideos + ' recent uploads are age-restricted by YouTube',
      force: sig.block_if_ratio_over != null && ratio > sig.block_if_ratio_over
    };
  }

  if (sig.id === 'twitch_mature') {
    if (!flags.twitch_mature) return null;
    return { detail: 'the channel declares itself mature on Twitch', force: true };
  }

  if (sig.id === 'twitch_ccl_restricted') {
    const labels = flags.twitch_labels || [];
    const bad = labels.filter(l => (sig.values || []).includes(l));
    if (!bad.length) return null;
    return { detail: 'Twitch content classification labels: ' + bad.join(', '), force: true };
  }

  if (sig.id === 'youtube_topic_restricted') {
    const topics = channel.topics || [];
    const bad = (sig.values || []).filter(v => topics.some(t => t.endsWith('/' + v)));
    if (!bad.length) return null;
    return { detail: 'YouTube assigned topic category: ' + bad.join(', '), force: false };
  }

  return null;
}

/* ----------------------------------------------------------------------------
   Bulk
   ---------------------------------------------------------------------------- */
export function partition(channels, rules, external) {
  const out = { allow: [], review: [], block: [] };
  for (const c of channels) {
    const r = classify(c, rules, external);
    r.rules_version = rules.version || null;
    out[r.verdict].push({ channel: c, safety: r });
  }
  return out;
}

function round(n) { return Math.round(n * 100) / 100; }
function pct(n) { return Math.round(n * 100) + '%'; }

export const __test = { normalise, deleet, termRegex, findTerms, contextOf, classify, partition };
