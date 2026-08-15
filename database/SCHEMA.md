# The channel record

One shape for every platform. A field that a platform cannot provide is `0` or
`""` **and** named in `unavailable`, so a zero is never mistaken for a
measurement of zero.

```jsonc
{
  "platform": "youtube",                  // youtube | twitch | tiktok | instagram
  "platform_creator_id": "UC…",           // the platform's own id, not ours
  "username": "@mkbhd",
  "display_name": "Marques Brownlee",
  "title": "Marques Brownlee",            // channel title as the platform has it
  "description": "…",                     // first 400 characters
  "profile_url": "https://…",
  "avatar_url": "https://…",

  // --- size -----------------------------------------------------------------
  "followers": 20100000,                  // subscribers / followers
  "following": 0,
  "total_views": 4210000000,
  "total_content": 1720,
  "tier": "Mega",                         // see the boundaries below

  // --- performance, from the most recent uploads ----------------------------
  "average_views": 2110000,
  "median_views": 1650000,                // ranking uses this one
  "average_likes": 68000,
  "median_likes": 61000,
  "average_comments": 3400,
  "median_comments": 3100,
  "average_shares": 0,
  "median_shares": 0,
  "engagement_rate": 3.88,                // percent, medians on both sides
  "views_per_follower": 0.08,
  "uploads_last_30_days": 4,

  // --- context --------------------------------------------------------------
  "country": "US",
  "language": "en",
  "niche": "tech",                        // from the seed file, not guessed
  "topics": ["https://en.wikipedia.org/wiki/Technology"],
  "verified": true,

  // --- provenance -----------------------------------------------------------
  "data_source": "youtube_official_api",  // or "demo"
  "demo": false,
  "data_confidence": 0.92,                // 0-1, how much was actually measured
  "unavailable": ["shares (YouTube does not expose share counts)"],
  "last_updated": "2026-08-15T11:08:00Z",

  // --- the filter's verdict, travelling with the row ------------------------
  "safety": {
    "verdict": "allow",                   // allow | review | block
    "safety_score": 100,                  // 0-100, higher is safer
    "risk_score": 0,                      // the raw total the thresholds compare
    "categories": [],                     // safety categories that fired
    "quality_flags": [],                  // never affects the verdict
    "flagged_upload_ratio": 0,
    "rules_version": "1.0.0",
    "reasons": []                         // one entry per rule that fired
  }
}
```

## Tiers

| Tier | Followers |
|---|---|
| Below Nano | under 1,000 |
| Nano | 1,000 – 9,999 |
| Micro | 10,000 – 49,999 |
| Macro | 50,000 – 499,999 |
| Mega | 500,000 and up |

## A reason

Every verdict decomposes into reasons, and every reason names the rule that
produced it. This is the whole point of the design: "why was this channel
removed" has an answer that does not require reading any code.

```jsonc
{
  "rule": "category:scams",       // category: | quality: | hard: | pattern: | override:
  "field": "channel_title",       // where it matched
  "video": null,                  // index into the sampled uploads, when it was one
  "matched": ["free robux"],      // the exact terms — or ["[redacted]"] for local terms
  "severity": 4,
  "base_severity": 4,             // before any context relief
  "context_relief": false,
  "weight": 1.0,                  // the field's weight
  "contribution": 4               // severity x weight
}
```

An exempted match keeps its entry with `contribution: 0` and an `exempted_by`
list, so a channel that matched and was cleared looks different from one that
never matched at all.

## The four files a build writes

| File | What is in it | Served publicly |
|---|---|---|
| `data/channels.json` | everything that passed | **yes**, `/api/database` |
| `data/review.json` | matched, not enough to remove | no — admin token |
| `data/rejected.json` | removed, with reasons | no — admin token |
| `data/unresolved.json` | the API could not find it, and what was skipped | not served |
| `data/build-report.json` | counts, quota spent, timing | via `/api/database/stats` |

`rejected.json` is a list of named channels with an accusation attached. It
stays behind the admin token for that reason, and the browse page has no code
path that can request it.
