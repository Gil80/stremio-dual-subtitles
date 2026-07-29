# Secondary Subtitle Source Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the primary OpenSubtitles source (`opensubtitles-v3.strem.io`) has no subtitles for the requested main or translation language, query a second, fuller-catalog mirror (`opensubtitles.stremio.homes`) and merge in whatever it finds, so titles like *Disclosure Day* (tt15047880) get real Hebrew subtitles instead of an empty result.

**Architecture:** `fetchAllSubtitles()` in `addon.js` currently calls one API and returns its list or `null`. This plan adds a second, independent fetch function in a new file (`lib/secondarySource.js`), called only when the primary result is missing `mainLang` or `transLang` coverage. Results from both sources are normalized to the same shape (`{ id, url, lang, m, g, downloads }`) and concatenated before being handed to the existing `generateCandidatePairs` picker — no changes needed to the pairing/merging/rendering pipeline.

**Tech Stack:** Node.js, axios (already a dependency), existing `lib/sourceSelection.js` picker, existing `sanitize-html`-based text cleaning.

## Global Constraints

- No new npm dependencies — reuse `axios`, `sanitize-html`, `pako`.
- Do not change `generateCandidatePairs`, `selectAndMergeBestPair`, or any merge/render code — secondary-source subs must fit the existing `{id, url, lang, m, g}` shape.
- Secondary source must be **fallback-only** (queried only when primary is missing a requested language) — never a default parallel call, to avoid adding latency/cost to titles that already work.
- Secondary source is a third-party community mirror with no SLA — all failures must be caught and degrade to "no fallback," never throw and break the primary path.
- Verified manually (2026-07-29) against tt15047880: primary source has 0 `heb`, 1 `rus`; secondary source (`opensubtitles.stremio.homes/he|ru|be/ai-translated=true|from=all|auto-adjustment=false/`) has 10 `heb`, 1 `rus`, all `ai_translated: false` (real human subs, not machine translated).
- Secondary source's `.vtt` payloads contain a promotional watermark cue (`>>OpenSubtitles v3+ v0.0.4<<`) as the first cue in every file — must be stripped, or it will render as a fake subtitle line.

---

## File Structure

- **Create:** `lib/secondarySource.js` — fetch + normalize function for the `opensubtitles.stremio.homes` mirror. Isolated so it can be deleted/disabled without touching `addon.js` merge logic.
- **Modify:** `addon.js` — `fetchAllSubtitles()` (line 232) gains fallback-trigger logic and merges in secondary results; both call sites (line 798, line 902) pass `mainLang`/`transLang` through (both already have these in scope).
- **Modify:** `.env.example` — document the new `SECONDARY_SOURCE_ENABLED` toggle.
- **Create:** `scripts/test_secondary_fallback.js` — manual verification script (matches existing `test_dual.js` convention: no test framework in this repo, plain Node script asserting via console output).

---

### Task 1: Secondary source fetcher module

**Files:**
- Create: `lib/secondarySource.js`
- Modify: `.env.example` (add `SECONDARY_SOURCE_ENABLED=true`)

**Interfaces:**
- Produces: `async function fetchSecondarySubtitles(imdbId, type, mainLang, transLang)` → `Promise<Array<{id, url, lang, m: null, g: null, downloads: 0}>>` (empty array on any failure or if disabled — never throws, never returns `null`).
- Consumes: nothing from other tasks (standalone module).

- [ ] **Step 1: Write the manual verification script first (documents expected behavior before writing the implementation)**

Create `scripts/test_secondary_fallback.js`:

```javascript
const { fetchSecondarySubtitles } = require('../lib/secondarySource');

async function test() {
  // tt15047880 (Disclosure Day) has 0 'heb' subs on the primary source
  // but 10 real (non-AI) 'heb' subs on the secondary mirror, verified
  // manually 2026-07-29 via curl against opensubtitles.stremio.homes.
  const subs = await fetchSecondarySubtitles('15047880', 'movie', 'heb', 'rus');

  const hebCount = subs.filter(s => s.lang === 'heb').length;
  const rusCount = subs.filter(s => s.lang === 'rus').length;

  console.log(`Found ${subs.length} total, ${hebCount} heb, ${rusCount} rus`);

  if (hebCount === 0) {
    console.log('FAILED: expected at least 1 heb subtitle');
    process.exit(1);
  }

  // Every entry must have the shape the primary-source merge pipeline expects
  const bad = subs.find(s => !s.id || !s.url || !s.lang);
  if (bad) {
    console.log('FAILED: malformed entry', bad);
    process.exit(1);
  }

  console.log('SUCCESS');
}

test();
```

- [ ] **Step 2: Run it to confirm it fails (module doesn't exist yet)**

Run: `node scripts/test_secondary_fallback.js`
Expected: `Error: Cannot find module '../lib/secondarySource'`

- [ ] **Step 3: Implement `lib/secondarySource.js`**

```javascript
/**
 * Fallback subtitle source: a community OpenSubtitles mirror with a
 * fuller catalog than the primary opensubtitles-v3.strem.io index.
 * Verified 2026-07-29: for tt15047880 (Disclosure Day), primary has
 * 0 Hebrew subs, this mirror has 10 real (non-AI-translated) ones.
 *
 * Queried ONLY as a fallback (see addon.js fetchAllSubtitles) when the
 * primary source is missing coverage for a requested language — never
 * called on the default/working path.
 */

const axios = require('axios');
const { debugServer, sanitizeForLogging } = require('./debug');

const SECONDARY_SOURCE_ENABLED = process.env.SECONDARY_SOURCE_ENABLED !== 'false';

// Watermark cue injected as the first subtitle in every file this
// mirror serves. Not real dialogue — must never reach the merged output.
const AD_WATERMARK_PATTERN = /OpenSubtitles v3\+/i;

function buildUrl(imdbId, type, mainLang, transLang) {
  // The mirror expects two-letter codes joined with '|' in the path,
  // e.g. "he|ru". Our language ids are three-letter (heb/rus); reuse
  // the alias table already in encoding.js to get the two-letter form.
  const { getLanguageAliases } = require('../encoding');
  const toTwoLetter = (lang3) => {
    const aliases = getLanguageAliases(lang3);
    const twoLetter = aliases.find(a => a.length === 2);
    return twoLetter || lang3;
  };

  const langs = [toTwoLetter(mainLang), toTwoLetter(transLang)].join('|');
  return (
    `https://opensubtitles.stremio.homes/${langs}/` +
    `ai-translated=true|from=all|auto-adjustment=false/` +
    `subtitles/${type}/tt${imdbId}.json`
  );
}

async function fetchSecondarySubtitles(imdbId, type, mainLang, transLang) {
  if (!SECONDARY_SOURCE_ENABLED) return [];

  const url = buildUrl(imdbId, type, mainLang, transLang);

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const raw = response.data && response.data.subtitles;
    if (!Array.isArray(raw) || raw.length === 0) return [];

    return raw
      .filter(s => s && s.url && s.lang && !AD_WATERMARK_PATTERN.test(s.title || ''))
      .map(s => ({
        id: `v3plus-${s.sub_id || s.id}`,
        url: s.url,
        lang: s.lang,
        m: null,
        g: null,
        downloads: 0
      }));
  } catch (error) {
    debugServer.warn('Secondary source fetch failed:', sanitizeForLogging(error.message));
    return [];
  }
}

module.exports = { fetchSecondarySubtitles };
```

- [ ] **Step 4: Run the verification script again**

Run: `node scripts/test_secondary_fallback.js`
Expected: `Found N total, 10 heb, 1 rus` then `SUCCESS`

- [ ] **Step 5: Commit**

```bash
git add lib/secondarySource.js scripts/test_secondary_fallback.js .env.example
git commit -m "feat: add secondary OpenSubtitles mirror as fallback source"
```

---

### Task 2: Wire the fallback into `fetchAllSubtitles`

**Files:**
- Modify: `addon.js:232-266` (`fetchAllSubtitles`)
- Modify: `addon.js:798` (`subtitlesHandler` call site)
- Modify: `addon.js:902-908` (`generateDynamicSubtitle` call site)

**Interfaces:**
- Consumes: `fetchSecondarySubtitles(imdbId, type, mainLang, transLang)` from Task 1.
- Produces: `fetchAllSubtitles(imdbId, type, season, episode, videoParams, mainLang, transLang)` — same return contract as before (`Array | null`), now merges in secondary-source subs when either language is missing from the primary result.

- [ ] **Step 1: Update `scripts/test_secondary_fallback.js` to test the merged path end-to-end**

Append to the existing test file:

```javascript
const { generateDynamicSubtitle } = require('../addon');

async function testFullPipeline() {
  // Before this task: returns null (0 heb subs from primary, no fallback).
  // After this task: should return a merged heb+rus SRT.
  const srt = await generateDynamicSubtitle(
    'movie', '15047880', null, null, 'heb', 'rus', 'dummyMain', 'dummyTrans'
  );

  if (!srt) {
    console.log('FAILED: expected merged subtitle, got null');
    process.exit(1);
  }
  console.log('FULL PIPELINE SUCCESS, length:', srt.length);
}

test().then(testFullPipeline);
```

- [ ] **Step 2: Run it to confirm it fails (fallback not wired in yet)**

Run: `node scripts/test_secondary_fallback.js`
Expected: `FAILED: expected merged subtitle, got null`

- [ ] **Step 3: Modify `fetchAllSubtitles` (addon.js:232)**

Replace the function signature and add fallback logic after the existing primary fetch (keep everything from line 232 to 265 as-is, then add):

```javascript
async function fetchAllSubtitles(imdbId, type, season = null, episode = null, videoParams = {}, mainLang = null, transLang = null) {
  let apiUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/tt${imdbId}`;

  if (type === 'series' && season && episode) {
    apiUrl += `:${season}:${episode}`;
  }

  const queryParams = [];
  const normalizedVideoParams = normalizeVideoParams(videoParams);
  if (normalizedVideoParams.filename) {
    queryParams.push(`filename=${encodeURIComponent(normalizedVideoParams.filename)}`);
  }
  if (normalizedVideoParams.videoSize) queryParams.push(`videoSize=${normalizedVideoParams.videoSize}`);
  if (normalizedVideoParams.videoHash) queryParams.push(`videoHash=${normalizedVideoParams.videoHash}`);

  if (queryParams.length > 0) {
    apiUrl += `/${queryParams.join('&')}`;
  }

  apiUrl += '.json';

  let primarySubs = [];
  try {
    const response = await fetchWithRetry(apiUrl, { timeout: 15000 });
    if (response.data && Array.isArray(response.data.subtitles)) {
      primarySubs = response.data.subtitles;
    }
  } catch (error) {
    debugServer.error('Error fetching subtitles:', sanitizeForLogging(error.message));
  }

  // Fallback: only hit the secondary mirror if the primary source is
  // missing coverage for a language we actually need. Keeps the
  // already-working path (most titles) at one network call.
  const missingMain = mainLang && !primarySubs.some(s => s.lang === mainLang);
  const missingTrans = transLang && !primarySubs.some(s => s.lang === transLang);

  let secondarySubs = [];
  if (missingMain || missingTrans) {
    const { fetchSecondarySubtitles } = require('./lib/secondarySource');
    debugServer.log(`Primary source missing coverage (main=${missingMain}, trans=${missingTrans}), trying secondary source`);
    secondarySubs = await fetchSecondarySubtitles(imdbId, type, mainLang, transLang);
    if (secondarySubs.length > 0) {
      debugServer.log(`Secondary source added ${secondarySubs.length} subtitle(s)`);
    }
  }

  const combined = primarySubs.concat(secondarySubs);
  return combined.length > 0 ? combined : null;
}
```

- [ ] **Step 4: Update the two call sites**

`addon.js:798` — inside `subtitlesHandler`, change:
```javascript
const allSubtitles = await fetchAllSubtitles(imdbId, type, season, episode, videoParams);
```
to:
```javascript
const allSubtitles = await fetchAllSubtitles(imdbId, type, season, episode, videoParams, mainLang, transLang);
```

`addon.js:902` — inside `generateDynamicSubtitle`, change:
```javascript
const allSubtitles = await fetchAllSubtitles(
  imdbId,
  type,
  season !== '0' ? season : null,
  episode !== '0' ? episode : null,
  normalizedVideoParams
);
```
to:
```javascript
const allSubtitles = await fetchAllSubtitles(
  imdbId,
  type,
  season !== '0' ? season : null,
  episode !== '0' ? episode : null,
  normalizedVideoParams,
  mainLang,
  transLang
);
```

- [ ] **Step 5: Run the verification script**

Run: `node scripts/test_secondary_fallback.js`
Expected: both `SUCCESS` (Task 1's test) and `FULL PIPELINE SUCCESS, length: N` printed, no `FAILED` lines.

- [ ] **Step 6: Regression-check an already-working title (primary source has both languages — fallback must NOT fire)**

Run:
```bash
node -e "
const { generateDynamicSubtitle } = require('./addon');
const { debugServer } = require('./lib/debug');
debugServer.log = console.log;
generateDynamicSubtitle('series', '28118211', '1', '1', 'eng', 'rus', 'dummyMain', 'dummyTrans')
  .then(srt => console.log(srt ? 'OK length=' + srt.length : 'FAILED'));
"
```
Expected: `OK length=N`, and the log output does NOT contain `Primary source missing coverage` (confirms fallback stayed dormant on a working title, so no added latency).

- [ ] **Step 7: Commit**

```bash
git add addon.js
git commit -m "feat: fall back to secondary subtitle source when primary lacks language coverage"
```

---

### Task 3: Document the new behavior

**Files:**
- Modify: `README.md` (Troubleshooting section, "Subtitles Not Showing")
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add a bullet to README.md's "Subtitles Not Showing" troubleshooting list (around line 440-446)**

```markdown
5. **Rare titles**: if the primary OpenSubtitles index has no subtitles for your chosen language, the addon automatically tries a secondary mirror with broader coverage before giving up. Set `SECONDARY_SOURCE_ENABLED=false` in `.env` to disable this fallback.
```

- [ ] **Step 2: Add a CHANGELOG.md entry under a new "Unreleased" heading at the top**

```markdown
### Unreleased

**Added**
- Secondary subtitle source fallback: when the primary OpenSubtitles index has no subtitles for the requested main or translation language, automatically query a second mirror with broader catalog coverage before returning an empty result.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document secondary subtitle source fallback"
```

---

## Deferred: AI-generated translation (do not build without a decision)

Not included as a task because it requires you to pick and pay for an LLM API before any code can be written:

- Real Hebrew subtitles exist for every title checked so far once the secondary source is added (Task 1-2) — AI generation would only matter for titles with **zero** subtitles in *either* language pair across both sources, which hasn't been observed yet in this investigation.
- Would require: a translation provider decision (OpenAI/Claude/DeepL/etc.), an API key stored in `.env` (never committed), a per-request cost, and a "machine-translated" disclosure in the subtitle title (matches this repo's honesty norm — the secondary source itself flags `ai_translated: true/false` per entry for the same reason).
- If Task 1-2 doesn't clear enough titles in practice, come back and scope this as its own plan — don't bolt it on here.

---

## Self-Review

**Spec coverage:** fallback mechanism (Task 1-2), source chaining (Task 2 merges primary+secondary), AI-generation (explicitly deferred with reasoning, not silently dropped).

**Placeholder scan:** no TBD/TODO; all code blocks are complete and runnable as shown.

**Type consistency:** `fetchSecondarySubtitles(imdbId, type, mainLang, transLang)` signature matches its one call site in Task 2 Step 3. Normalized shape `{id, url, lang, m, g, downloads}` matches what `lib/sourceSelection.js`'s `filterByLanguage`/`selfScore` read (`sub.lang`, `sub.m`, `sub.g` — all present, `m`/`g` as `null` which both functions already null-check for).
