# NovaClip — Creator Intelligence

Two things:

1. **Integrations** — real numbers for YouTube, Twitch, TikTok and Instagram
   through each platform's official API.
2. **A channel database** — those numbers collected into one searchable list,
   with a safety filter that keeps unsuitable channels out and records exactly
   why each removed one was removed.

No scraping, no undocumented endpoints, and no credential in the repository or
in a browser.

> ### About "every channel"
>
> There is no way to get one, and that is worth saying plainly rather than
> shipping something that pretends otherwise.
>
> No platform exposes an enumeration endpoint. YouTube and Twitch answer
> questions about an id you already have; TikTok and Instagram answer only about
> the account that connected. The only route to "every channel" is scraping,
> which breaks all four sets of terms and gets the key revoked.
>
> So the database is **seeded and enriched**: a curated list in
> `database/seeds/channels.seed.json`, each entry resolved and measured through
> the official API, filtered, and written out. Adding a channel is one line in
> that file. It grows deliberately instead of pretending to be complete.

---

## How this project is actually built

There is **no Node server, no bundler and no `package.json`**. NovaClip is
static HTML plus Cloudflare Workers. That matters for where secrets live:

| | file | needs |
|---|---|---|
| Models | `ai-worker.js` | `GEMINI_API_KEY`, optional OpenRouter/OpenAI |
| Accounts, leaderboard, community | `leaderboard-worker.js` | KV binding `DB` |
| **Platform integrations** | **`integrations-worker.js`** | **the credentials below + KV binding `DB`** |

The three are **not interchangeable**. Each answers `/health` with a `worker`
field naming itself, so a swapped deploy is visible in a browser.

A `.env` file has nothing to read it at runtime here. Credentials live in
Cloudflare's secret store; `.env.example` documents the names and is what
`wrangler dev` reads locally.

### What is in this repo

```
integrations-worker.js          the Worker: platform APIs, OAuth, and the database endpoints
integrations.html               credential status and live connection tests
database.html                   browse, search and sort the database

database/build.js               the pipeline: resolve -> measure -> filter -> write
database/count.js               how many channels match a set of parameters
database/discover.js            finds channels you do not already know about
database/estimate.js            approximately how many exist that would pass
database/estimate.json          the population anchors, with confidence bands
database/SCHEMA.md              the channel record, field by field
database/safety/rules.json      the entire policy — terms, weights, thresholds, overrides
database/safety/filter.js       executes the policy; holds no opinions of its own
database/seeds/channels.seed.json   the curated seed list
database/seeds/fixtures.json    hand-written cases, also what --offline builds from
database/data/                  the built output (channels, review, rejected, unresolved, report)

tests/metrics.test.mjs          medians, tiers, engagement, normalisation
tests/filter.test.mjs           the safety filter, mostly its false positives
.env.example                    every variable name, no values
```

---

## 1. Local setup

```bash
cp .env.example .env          # .env is gitignored — never commit it
```

Fill in what you have. Every platform is independent: **YouTube alone is
enough to see real data**, and anything missing degrades to a clear
"not configured" instead of breaking the app.

Generate the encryption key (required before any OAuth connection is allowed):

```bash
openssl rand -base64 32       # paste into TOKEN_ENCRYPTION_KEY
```

## 2. Run it

```bash
# the static site — any static server will do
python3 -m http.server 8080

# the integrations Worker
npx wrangler dev integrations-worker.js --port 8787
```

Then open:

```
http://localhost:8080/integrations.html      credentials and connection tests
http://localhost:8080/database.html          the channel database
```

Paste `http://localhost:8787` into the address box at the top. The page reads
`/api/integrations/status` and shows each platform as **Configured** or
**Missing**. It can never see a key — the endpoint returns booleans and
variable *names* only.

## 3. Tests

```bash
node --test tests/*.test.mjs
```

38 tests. 14 on the metrics, the tiers and the normalisation — the parts where
a quiet mistake ranks the wrong creator first. 24 on the safety filter, most of
them on the direction that fails silently: a filter letting something through
gets noticed, while removing a legitimate channel is invisible, because the
person it happened to never finds out.

> Note: `node --test tests/` (directory form) fails on this Node version with
> `Cannot find module`. Use the glob above.

There is no lint or type-check step to run: no toolchain is installed and
adding one would mean adding a build system this project deliberately does not
have.

---

## 4. Deploying

```bash
npx wrangler deploy integrations-worker.js
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put ADMIN_TOKEN            # publishing and the private lists
# ...one per credential you use
```

Bind KV as `DB` (Settings → Bindings → KV namespace, variable name `DB`).
Set `PUBLIC_URL` to the Worker's public address — the OAuth redirect URIs are
built from it and must match what you registered:

```
<PUBLIC_URL>/auth/tiktok/callback
<PUBLIC_URL>/auth/instagram/callback
```

Check it with `<PUBLIC_URL>/health`.

---

## 5. What each platform can actually do

This is the part that decides what you can build, so it is stated plainly.

| Platform | Auth | Approval needed | Can read other creators? |
|---|---|---|---|
| **YouTube** | API key | none | **Yes** — any public channel |
| **Twitch** | client credentials | none | **Yes** — any public channel |
| **TikTok** | user OAuth | app review for production | **No** — only the connected account |
| **Instagram** | user OAuth | app review + Business verification | **No** — only the connected account |

Specifically:

- **YouTube** — the one that just works. Enable *YouTube Data API v3* on the
  key. Free quota is 10,000 units/day; a channel + recent videos lookup costs
  about 3, and results are cached for 5 minutes.
- **Twitch** — follower **count** is available; the follower **list** needs a
  user token with moderator scope and is not offered. VODs have no likes or
  comments, so those come back as 0 and are named in `unavailable`.
- **TikTok** — Login Kit and Display API. Looking up an arbitrary creator needs
  the **Research API**, a separate academic application. Not having it is
  reported, never worked around.
- **Instagram** — the account must be **Creator or Business, linked to a
  Facebook Page**. A personal account cannot return insights; the error says
  exactly that rather than "something went wrong".

---

## 6. Endpoints

```
GET  /health
GET  /api/integrations/status
GET  /api/integrations/test?platform=youtube|twitch|tiktok|instagram|ai
GET  /api/creator/{youtube|twitch|tiktok|instagram}?id=<id>[&demo=1]
POST /api/creators                     {"creators":[{"platform":"youtube","id":"UC..."}]}
GET  /auth/tiktok        /auth/tiktok/callback
GET  /auth/instagram     /auth/instagram/callback
POST /api/integrations/{platform}/disconnect
```

Every creator response is normalised to one shape regardless of platform, with
`unavailable` naming anything the platform genuinely cannot provide — so a `0`
is never mistaken for a measurement.

## 7. Why medians

Ranking uses **median**, not mean. One video that caught an algorithm can be
fifty times a creator's normal, and a mean lets that single post speak for the
whole channel — which is how a brand ends up paying for reach that will not
happen again.

Engagement uses medians on **both** sides of the ratio. Mixing mean likes with
median views reported 177% engagement for a channel whose real figure was
11.5%; that bug is now covered by a test.

Mean is still reported, because the gap between the two is itself the signal:
mean far above median means one spike, the two close together means a reliable
channel.

## 8. Security

- No credential is ever in a response body, a log line, or any page.
- OAuth tokens are encrypted at rest with **AES-GCM**, key derived from
  `TOKEN_ENCRYPTION_KEY` with SHA-256, fresh 12-byte IV per record.
- Without `TOKEN_ENCRYPTION_KEY`, starting OAuth is **refused** rather than
  storing a bearer token in plain text.
- The OAuth `state` is HMAC-signed and expires after 10 minutes, so a callback
  cannot be forged to attach an attacker's account to someone else's record.
- Disconnecting deletes the token **and** the cached creator record.
- Rotating `TOKEN_ENCRYPTION_KEY` makes existing connections read as
  disconnected — reconnect, no data corruption.

## 9. The channel database

```bash
node database/build.js --offline        # fixtures, no keys, no network
node database/build.js                  # the real seed list through the real APIs
node database/build.js --only youtube --limit 10
node database/build.js --publish https://your-worker.workers.dev
```

Then open `database.html`. It loads `database/data/channels.json` on arrival and
the Worker when you give it an address.

### What the build does

For each seeded channel it resolves the handle through the official API, pulls
the channel and its recent uploads, computes the metrics in `SCHEMA.md`, and
runs the result past `database/safety/rules.json`. Three outcomes:

| | meaning | where it goes |
|---|---|---|
| **allow** | nothing fired, or only signals too weak to mean anything | `channels.json` — the database |
| **review** | something fired, not enough to remove a channel over | `review.json` — for a person |
| **block** | removed, with the rule that removed it | `rejected.json` |

`review` is the important one. Term matching cannot tell a documentary about
cartels from a channel selling drugs, and a filter that pretends it can removes
journalism and keeps the actual problem. Everything ambiguous goes to a person.

A build spends about **3 YouTube quota units per channel** out of 10,000 a day,
and the exact figure is printed and written to `build-report.json`.

### Long runs: resume, staleness and cost

A run over thousands of channels takes hours, so every measurement is cached in
`data/measured.json` and flushed every 25 channels. Re-run the same command and
it picks up where it stopped, spending no quota on anything it already has.

```bash
node database/build.js                    # resumes; re-measures anything older than 7 days
node database/build.js --max-age 1        # treat anything over a day old as stale
node database/build.js --refresh          # ignore the cache, measure everything again
```

The cache is the source of truth; `channels.json`, `review.json` and
`rejected.json` are rebuilt from it on every run. That means **editing
`rules.json` and re-running re-classifies everything without re-measuring
anything** — a policy change costs no quota at all.

It is gitignored: regenerable, and tens of megabytes at scale.

### Finding channels you do not already know about

`build.js` measures channels you name. `discover.js` finds them, using the only
documented endpoints on any of the four platforms that return channels you did
not already have an id for.

```bash
node database/discover.js --twitch-live --pages 50
node database/discover.js --youtube-niches --budget 3000
node database/discover.js --youtube-search "video editing tutorial"
```

Results accumulate in `seeds/discovered.json` across runs, and `build.js` reads
it alongside the curated seed list.

| Platform | What is possible | Practical yield |
|---|---|---|
| **Twitch** | `GET /helix/streams` pages through **every channel live right now**, 100 at a time. Real enumeration. | ~100k live at peak. Run it daily and the union approaches every active streamer. |
| **YouTube** | `search.list?type=channel` — asking questions, not enumerating. ~500 channels per query, hard ceiling. | 100 units/call, so ~100 searches/day on free quota, up to ~5,000 channels/day. |
| **TikTok** | **Nothing.** Display API returns the connected account only. Any other creator needs the Research API — an academic application. | 0 |
| **Instagram** | **Nothing enumerable.** `business_discovery` looks up a professional account by a username you already have. A lookup, not a search. | 0 |

Twitch is the one where something close to a census is genuinely achievable.
TikTok and Instagram are not difficult — they are closed.

### Why "every channel" is arithmetic, not ambition

YouTube has upwards of a hundred million channels. Measuring one costs about 3
quota units; a free key allows 10,000 units a day. That is ~3,300 channels a
day, or **roughly ninety years** — and only if enumeration existed, which it
does not. Quota increases are granted per use case after an audit, and
"index every channel" is not a use case Google approves.

This is why the database is curated. The constraint is not effort.

### Approximately how many exist

`count.js` answers "how many do I have". `estimate.js` answers "how many are
out there" — a Fermi estimate, population anchors times expected pass rate.

```bash
node database/estimate.js
node database/estimate.js --tier 1k+      # any tier from 1+ to 1M+
```

Every run prints the whole ladder, 1 follower to 1M, because the shape matters
more than any single row:

```
  tier         YouTube      Twitch      TikTok   Instagram       total
  1+               30M        4.6M        180M         90M        300M
  1k+              21M        710k         46M         19M         87M
  10k+            4.3M        120k        6.4M        4.8M         16M
  100k+           700k         12k        720k        570k          2M
  1M+              33k         740         80k         61k        180k
```

For a range rather than a cumulative tier, use `--from` / `--to`:

```bash
node database/estimate.js --from 1+ --to 10k+
```

```
    660M   exist
    280M   would pass the filter   (43%)
     28M   ...and still post       (4% of all, 10% of those that pass)
```

**Active is the number that matters, and it is a tenth of the filtered one.**
Most channels in this range were made, used a few times and abandoned: a 2019
YouTube cohort study found 74.8% dormant, fading or gone seven years on.
"Active" here means at least one public upload in the last 90 days — there is no
shared definition, which is why published YouTube active-channel counts range
from 47M to 138M.

Activity is applied per tier and per platform, not as one flat rate. A
1M-subscriber channel is almost certainly still posting; a 50-follower one
almost certainly is not, and averaging the two overstates the top and
understates the bottom at once.

The band is the `1+` row minus the `10k+` row, differenced on the **filtered**
figures rather than the raw ones — the pass rate is not constant across the
range, and the bottom of it is where nearly all the spam is.

It also prints **provenance per row**, because a measured percentile and a
number somebody made up must never look alike in the same table. YouTube is
measured from 100 to 100k subscribers; Twitch below 1k and every TikTok row
are not.

At 10k+ followers it lands around **16 million**, band 7.3M–36M. The number
that matters more sits underneath it: about **72% of them are on TikTok and
Instagram, which have no discovery endpoint at all**. They can never be
reached by any amount of quota or patience — only by their owners connecting.
Of the ~4.4M that is reachable, YouTube is 97% and takes about four years at
free quota; Twitch is small enough to finish in days.

The anchors are cited in `estimate.json` under `sources` — vidIQ's July 2026
analysis of 61.2M YouTube channels, Twitch's 2026 streamer counts, a December
2025 Instagram creator snapshot. **TikTok is marked VERY LOW confidence and its
row should not be quoted alone**: no creator census exists and published
figures disagree by more than an order of magnitude.

The softest assumption left is the pass rate, and one real Twitch run replaces
that guess with the true figure from `build-report.json`.

### How many channels match a set of parameters

```bash
node database/count.js
node database/count.js --min-followers 10000 --niche gaming
node database/count.js --tier Micro --min-engagement 3 --include-review
```

It prints the count, then what each parameter removed on its own — so a filter
that returns nothing tells you which condition emptied it instead of leaving
you to bisect the flags.

**The number is a count of your seed list, not of the platform.** There is no
endpoint on any of the four that counts or lists channels by criteria. YouTube's
search endpoint returns a `totalResults` that Google documents as an
approximation of matching *videos*, capped and unreliable — it is not a census
of channels and this project does not present it as one. The ceiling on any
count is the seed list, currently 84 entries, and the only way to raise it is to
add channels to it.

### The filter

All of the policy is in `database/safety/rules.json` — terms, weights,
thresholds, exemptions, overrides. `filter.js` executes it and has no opinions
of its own, so changing what counts as unsuitable is a JSON edit, and every
rejection traces to a line in that file.

The design decisions worth knowing:

- **Word boundaries, never substrings.** Substring matching is what blocks
  Scunthorpe, Penistone and every channel with "analysis" in the title. There
  are tests for exactly this.
- **A single match can never remove a channel.** The heaviest term in one video
  title reaches `review` and stops there. Removal needs the term in the
  channel's own name or description, two independent categories, or a pattern
  across many uploads.
- **Context relief.** A history channel says the words a hate filter watches
  for; a mental health channel says the words a self-harm filter watches for.
  Categories marked context-sensitive lose severity when the channel is clearly
  news, education or medical — a discount, never below 1, not an exemption.
- **Same-field exemptions.** "How the free robux scam works — do not fall for
  it" is a warning. The match is still recorded, marked exempted, and scored 0.
- **Quality is not safety.** Engagement bait is flagged on the row and never
  touches the verdict. The first version of the rules removed a channel purely
  for saying "sub4sub" a lot, which is how a safety filter quietly becomes a
  taste filter.
- **The platform's own signals outrank guesses.** A Twitch channel that flags
  itself mature, or a YouTube channel with age-restricted uploads as a pattern,
  is removed on that alone — those are declarations, not inferences.
- **Slurs are not in this repository.** Putting a slur list in a repo creates a
  slur list in a repo. Drop one in `database/safety/slurs.local.txt` (gitignored,
  one per line) and the filter loads it, matches it and redacts it out of the
  audit trail.
- **Human overrides win.** `overrides.allow` and `overrides.block` in
  rules.json beat every score, and appear in the reasons when they do.

### Database endpoints

```
GET  /api/database?q=&platform=&niche=&tier=&min_followers=&sort=&limit=&offset=
GET  /api/database/stats
GET  /api/database/{platform}/{id}
GET  /api/database/review        Authorization: Bearer ADMIN_TOKEN
GET  /api/database/rejected      Authorization: Bearer ADMIN_TOKEN
POST /api/database/publish       Authorization: Bearer ADMIN_TOKEN
```

`review` and `rejected` are lists of named channels with a reason they were
removed attached — that is an accusation about real people, so they need the
token and the browse page has no code path that requests them. The token is
compared in constant time; an early return on the first wrong byte leaks a
token one byte at a time.

The Worker classifies nothing at request time. A verdict that can change
between two reads is not a verdict, and the build produces an audit trail a
request handler has nowhere to keep.

---

## 10. Demo mode

Demo data is served **only** when asked for by name (`?demo=1`) or when nothing
is configured at all, and it is labelled `"demo": true` with
`"data_source": "demo"`.

It is never substituted for a real call that failed. A configured platform that
errors returns the real error — a dashboard that quietly shows invented numbers
when the API is down is worse than one that admits it is down.
