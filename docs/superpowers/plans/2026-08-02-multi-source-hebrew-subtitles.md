# Multi-Source Hebrew Subtitle Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Hebrew (`heb`) is one of the two configured languages, list every Hebrew subtitle candidate from Wizdom, Ktuvit, OpenSubtitles primary, and (fallback-only) the community mirror as its own picker entry in Stremio — each paired with one fixed best candidate for the other configured language — so the user can try multiple Hebrew tracks per title until one is both good quality and correctly synced.

**Architecture:** Two new fetchers (`lib/hebrewSources.js`) query the already-public Wizdom and Ktuvit addon instances, same pattern as the existing `lib/secondarySource.js` mirror fetcher. A new pure function (`buildHebrewEntries` in `lib/sourceSelection.js`) assembles the ordered entry list with no network calls, so it's unit-testable like the existing `generateCandidatePairs`. `subtitlesHandler` in `addon.js` branches: if neither configured language is `heb`, the existing single-best-pair logic runs completely unchanged; if one side is `heb`, a new `buildHebrewMultiSourceResponse` path runs instead, publishing one entry per Hebrew candidate. Each published URL encodes a source-prefixed subtitle id (`wizdom:<id>`, `ktuvit:<id>`, `opensubtitles:<id>`, `mirror:<id>`); `generateDynamicSubtitle` detects these prefixes and takes a **locked-pairing** path with no quality-gate swap-loop — if the exact requested pair fails to parse or merge, it returns nothing rather than substituting a different Hebrew subtitle.

**Tech Stack:** Node.js, axios (already a dependency), existing `lib/sourceSelection.js`/`lib/secondarySource.js` patterns, hand-rolled `test(name, fn)`/`assert` harness in `test.js` (no test framework), plain Node scripts in `scripts/` for live-network verification (matches `scripts/test_secondary_fallback.js`).

## Global Constraints

- No new npm dependencies — reuse `axios`.
- Existing single-language-pair behavior (neither side `heb`) must be provably unchanged — verified by a regression check in Task 6.
- Wizdom (`https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club`) and Ktuvit (`https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club`) are queried directly as their public hosted instances — no self-hosting, no API keys, no `KTUVIT_USER_EMAIL`/password env vars.
- No cap on the number of Hebrew entries published — every release variant from every source gets its own picker entry, deliberately.
- Priority order of entries: Wizdom → Ktuvit → OpenSubtitles primary → mirror fallback.
- Mirror fallback fires only if, after querying Wizdom+Ktuvit+OpenSubtitles primary, there are zero Hebrew candidates total OR zero candidate for the other configured language — never queried unconditionally.
- Any published Hebrew multi-source entry, once selected by the user, must resolve to **exactly** that Hebrew subtitle merged with the fixed other-language subtitle — no silent substitution if the pair fails to parse/merge; return an empty result instead.
- Verified live 2026-08-02 against `tt15047880` (Disclosure Day — 0 Hebrew subs on OpenSubtitles primary): Wizdom returned 9 Hebrew entries, Ktuvit returned 3, both as `{id, lang: "heb", url}`, no auth. Exact counts may drift over time; verification steps below check for "at least 1", not exact counts.

---

## File Structure

- **Create:** `lib/hebrewSources.js` — `fetchWizdomSubtitles`/`fetchKtuvitSubtitles`, network fetchers normalizing both sources to `{id, url, lang: 'heb', source, label}`, ids prefixed with source name.
- **Modify:** `lib/secondarySource.js` — add a `label` field (`s.title || null`) to the normalized output, needed so mirror-sourced Hebrew entries in the new picker get a human-readable name instead of a bare numeric id.
- **Modify:** `lib/sourceSelection.js` — add pure function `buildHebrewEntries(sourceGroups, fixedCandidate, fixedLang)`, no network, fully unit-testable.
- **Modify:** `addon.js` — `subtitlesHandler` (~line 764) gains a `heb`-detection branch and new `buildHebrewMultiSourceResponse` function; `generateDynamicSubtitle` (~line 890) gains prefix detection and a new `generateLockedPairSubtitle`/`fetchLockedCandidate` pair of functions; import line 126 gains `rankCandidatesForLanguage` and `buildHebrewEntries`.
- **Create:** `scripts/test_hebrew_sources.js` — live verification for Task 1 (Wizdom/Ktuvit fetchers).
- **Modify:** `scripts/test_secondary_fallback.js` — extend for Task 2's `label` field.
- **Create:** `scripts/test_hebrew_multisource.js` — live end-to-end verification for Task 4/5 (full picker-list + locked-fetch pipeline, plus non-Hebrew regression check).
- **Modify:** `test.js` — unit tests for `buildHebrewEntries` (Task 3).
- **Modify:** `README.md`, `CHANGELOG.md` — document the feature (Task 7).

---

### Task 1: Wizdom and Ktuvit source fetchers

**Files:**
- Create: `lib/hebrewSources.js`
- Create: `scripts/test_hebrew_sources.js`

**Interfaces:**
- Produces: `async function fetchWizdomSubtitles(imdbId, type, season = null, episode = null)` and `async function fetchKtuvitSubtitles(imdbId, type, season = null, episode = null)`, both `Promise<Array<{id, url, lang: 'heb', source: 'wizdom'|'ktuvit', label}>>`. `id` is prefixed (`wizdom:<raw-id>` / `ktuvit:<raw-id>`). Never throws, never returns `null` — empty array on any failure.
- Consumes: nothing from other tasks (standalone module, mirrors `lib/secondarySource.js`'s shape).

- [ ] **Step 1: Write the manual verification script first**

Create `scripts/test_hebrew_sources.js`:

```javascript
const { fetchWizdomSubtitles, fetchKtuvitSubtitles } = require('../lib/hebrewSources');

async function test() {
  // tt15047880 (Disclosure Day) has 0 heb subs on the OpenSubtitles
  // primary index, verified 2026-07-29. Wizdom/Ktuvit verified live
  // 2026-08-02: Wizdom 9 heb entries, Ktuvit 3 heb entries. Counts may
  // drift over time — this only checks "at least 1 each".
  const [wizdom, ktuvit] = await Promise.all([
    fetchWizdomSubtitles('15047880', 'movie'),
    fetchKtuvitSubtitles('15047880', 'movie')
  ]);

  console.log(`Wizdom: ${wizdom.length} heb entries`);
  console.log(`Ktuvit: ${ktuvit.length} heb entries`);

  if (wizdom.length === 0) {
    console.log('FAILED: expected at least 1 Wizdom heb entry');
    process.exit(1);
  }
  if (ktuvit.length === 0) {
    console.log('FAILED: expected at least 1 Ktuvit heb entry');
    process.exit(1);
  }

  const badWizdom = wizdom.find(s => !s.id.startsWith('wizdom:') || s.lang !== 'heb' || !s.url || s.source !== 'wizdom');
  if (badWizdom) {
    console.log('FAILED: malformed Wizdom entry', badWizdom);
    process.exit(1);
  }
  const badKtuvit = ktuvit.find(s => !s.id.startsWith('ktuvit:') || s.lang !== 'heb' || !s.url || s.source !== 'ktuvit');
  if (badKtuvit) {
    console.log('FAILED: malformed Ktuvit entry', badKtuvit);
    process.exit(1);
  }

  console.log('SUCCESS');
}

test();
```

- [ ] **Step 2: Run it to confirm it fails (module doesn't exist yet)**

Run: `node scripts/test_hebrew_sources.js`
Expected: `Error: Cannot find module '../lib/hebrewSources'`

- [ ] **Step 3: Implement `lib/hebrewSources.js`**

```javascript
/**
 * Hebrew-specific subtitle sources: Wizdom (wizdom.xyz) and Ktuvit
 * (ktuvit.me), both queried via their public, already-hosted Stremio
 * addon instances — no self-hosting or credentials needed. (The
 * KTUVIT_USER_EMAIL/hashed-password env vars documented in the Ktuvit
 * repo are only for self-hosting a private instance; the public
 * instance queried here needs none of that.)
 *
 * Verified live 2026-08-02 against tt15047880 (Disclosure Day, which
 * has 0 Hebrew subs on the OpenSubtitles primary index): Wizdom
 * returned 9 heb entries, Ktuvit returned 3, both as
 * { id, lang: "heb", url }.
 *
 * Every returned entry's `id` is prefixed with its source name
 * (e.g. "wizdom:...", "ktuvit:...") so addon.js can route a later
 * generateDynamicSubtitle request back to the correct source without
 * needing an extra URL parameter.
 */

const axios = require('axios');
const { debugServer, sanitizeForLogging } = require('./debug');

const WIZDOM_BASE = 'https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club';
const KTUVIT_BASE = 'https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club';

function buildSubtitlesUrl(base, type, imdbId, season, episode) {
  let path = `${base}/subtitles/${type}/tt${imdbId}`;
  if (type === 'series' && season && episode) {
    path += `:${season}:${episode}`;
  }
  return `${path}.json`;
}

async function fetchFromSource(base, sourcePrefix, imdbId, type, season, episode) {
  const url = buildSubtitlesUrl(base, type, imdbId, season, episode);

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const raw = response.data && response.data.subtitles;
    if (!Array.isArray(raw) || raw.length === 0) return [];

    return raw
      .filter(s => s && s.url && s.id && s.lang === 'heb')
      .map(s => ({
        id: `${sourcePrefix}:${s.id}`,
        url: s.url,
        lang: 'heb',
        source: sourcePrefix,
        label: s.id
      }));
  } catch (error) {
    debugServer.warn(`${sourcePrefix} fetch failed:`, sanitizeForLogging(error.message));
    return [];
  }
}

async function fetchWizdomSubtitles(imdbId, type, season = null, episode = null) {
  return fetchFromSource(WIZDOM_BASE, 'wizdom', imdbId, type, season, episode);
}

async function fetchKtuvitSubtitles(imdbId, type, season = null, episode = null) {
  return fetchFromSource(KTUVIT_BASE, 'ktuvit', imdbId, type, season, episode);
}

module.exports = { fetchWizdomSubtitles, fetchKtuvitSubtitles };
```

- [ ] **Step 4: Run the verification script again**

Run: `node scripts/test_hebrew_sources.js`
Expected: `Wizdom: N heb entries` and `Ktuvit: M heb entries` (both ≥1) then `SUCCESS`.

- [ ] **Step 5: Commit**

```bash
git add lib/hebrewSources.js scripts/test_hebrew_sources.js
git commit -m "feat: add Wizdom and Ktuvit Hebrew subtitle source fetchers"
```

---

### Task 2: Add a `label` field to the mirror source

**Files:**
- Modify: `lib/secondarySource.js` (the `.map()` inside `fetchSecondarySubtitles`, currently around line 134-143)
- Modify: `scripts/test_secondary_fallback.js`

**Interfaces:**
- Produces: `fetchSecondarySubtitles(imdbId, type, mainLang, transLang)` return shape gains one field: `{id, url, lang, m: null, g: null, downloads: 0, label}` where `label` is the mirror's `title` field (a human-readable release name) or `null` if absent.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Extend the verification script to assert the new field**

Add to the end of `scripts/test_secondary_fallback.js` (before the final `test()` call at the bottom, keep the existing `test()` function and its call — just add this new check inside it, right after the existing `bad` check):

```javascript
  const missingLabel = subs.find(s => s.label === undefined);
  if (missingLabel) {
    console.log('FAILED: entry missing label field entirely', missingLabel);
    process.exit(1);
  }
```

- [ ] **Step 2: Run it to confirm it fails (field doesn't exist yet)**

Run: `node scripts/test_secondary_fallback.js`
Expected: `FAILED: entry missing label field entirely {...}`

- [ ] **Step 3: Modify `lib/secondarySource.js`'s `.map()`**

Change:
```javascript
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
```
to:
```javascript
    return raw
      .filter(s => s && s.url && s.lang && !AD_WATERMARK_PATTERN.test(s.title || ''))
      .map(s => ({
        id: `v3plus-${s.sub_id || s.id}`,
        url: s.url,
        lang: s.lang,
        m: null,
        g: null,
        downloads: 0,
        label: s.title || null
      }));
```

- [ ] **Step 4: Run the verification script again**

Run: `node scripts/test_secondary_fallback.js`
Expected: no `FAILED` lines, both `SUCCESS` and `FULL PIPELINE SUCCESS, length: N` printed (this script already chains into the full pipeline from the 2026-07-29 plan).

- [ ] **Step 5: Commit**

```bash
git add lib/secondarySource.js scripts/test_secondary_fallback.js
git commit -m "feat: add label field to secondary source entries"
```

---

### Task 3: Pure entry-builder function

**Files:**
- Modify: `lib/sourceSelection.js` (add function + export, end of file)
- Modify: `test.js` (add tests near the existing `sourceSelection` block, ~line 622-712)

**Interfaces:**
- Consumes: nothing from other tasks (pure function, plain object inputs).
- Produces: `buildHebrewEntries(sourceGroups, fixedCandidate, fixedLang)` → `Array<{id: string, mainSub: object, fixedSub: object, source: string, label: string}>`. `sourceGroups` is `Array<{source: string, candidates: Array<{id, url, lang, label?}>}>`. Returns `[]` if `fixedCandidate` is falsy. Skips any candidate missing `id` or `url`. Preserves `sourceGroups` order, and within each group, `candidates` order.

- [ ] **Step 1: Write the failing tests**

Add to `test.js`, immediately after the existing `sourceSelection` test block (after the last test in that block, before the next `console.log('\n--- ...')` section header — find it by searching for `generateCandidatePairs: top ranked main`):

```javascript
test('buildHebrewEntries: orders entries by source group order, one per candidate', () => {
  const groups = [
    { source: 'wizdom', candidates: [
      { id: 'wizdom:1', url: 'u1', lang: 'heb', label: 'W1' },
      { id: 'wizdom:2', url: 'u2', lang: 'heb', label: 'W2' }
    ] },
    { source: 'ktuvit', candidates: [
      { id: 'ktuvit:1', url: 'u3', lang: 'heb', label: 'K1' }
    ] }
  ];
  const fixed = { id: 'rus:9', url: 'u9', lang: 'rus' };
  const entries = buildHebrewEntries(groups, fixed, 'rus');
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].source, 'wizdom');
  assert.strictEqual(entries[0].mainSub.id, 'wizdom:1');
  assert.strictEqual(entries[1].mainSub.id, 'wizdom:2');
  assert.strictEqual(entries[2].source, 'ktuvit');
  assert.strictEqual(entries[2].fixedSub.id, 'rus:9');
});

test('buildHebrewEntries: returns empty array when fixedCandidate is missing', () => {
  const groups = [
    { source: 'wizdom', candidates: [{ id: 'wizdom:1', url: 'u1', lang: 'heb', label: 'W1' }] }
  ];
  const entries = buildHebrewEntries(groups, null, 'rus');
  assert.strictEqual(entries.length, 0);
});

test('buildHebrewEntries: skips malformed candidates (missing id or url)', () => {
  const groups = [
    { source: 'wizdom', candidates: [
      { lang: 'heb' },
      { id: 'wizdom:2', url: 'u2', lang: 'heb', label: 'W2' }
    ] }
  ];
  const fixed = { id: 'rus:9', url: 'u9', lang: 'rus' };
  const entries = buildHebrewEntries(groups, fixed, 'rus');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].mainSub.id, 'wizdom:2');
});

test('buildHebrewEntries: falls back to id as label when candidate has no label', () => {
  const groups = [
    { source: 'opensubtitles', candidates: [{ id: 'opensubtitles:42', url: 'u1', lang: 'heb' }] }
  ];
  const fixed = { id: 'rus:9', url: 'u9', lang: 'rus' };
  const entries = buildHebrewEntries(groups, fixed, 'rus');
  assert.strictEqual(entries[0].label, 'opensubtitles:42');
});
```

Also update the destructuring import at the top of that test block (find the line `generateCandidatePairs\n} = require('./lib/sourceSelection');` around line 630) to:

```javascript
const {
  rankCandidatesForLanguage,
  generateCandidatePairs,
  buildHebrewEntries
} = require('./lib/sourceSelection');
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node test.js`
Expected: failures like `buildHebrewEntries is not a function` or `TypeError: buildHebrewEntries is not defined`.

- [ ] **Step 3: Implement `buildHebrewEntries` in `lib/sourceSelection.js`**

Add before the final `module.exports` block:

```javascript
/**
 * Build the ordered list of Hebrew dual-subtitle picker entries.
 *
 * Pure function, no network — takes already-fetched candidate lists
 * grouped by source (in priority order) and the single fixed candidate
 * for the other configured language, and returns one entry per Hebrew
 * candidate, preserving source-group order and no cap on count.
 *
 * @param {Array<{source: string, candidates: Array<{id, url, lang, label?}>}>} sourceGroups
 * @param {{id: string, url: string, lang: string}|null} fixedCandidate
 * @param {string} fixedLang
 * @returns {Array<{id: string, mainSub: object, fixedSub: object, source: string, label: string}>}
 */
function buildHebrewEntries(sourceGroups, fixedCandidate, fixedLang) {
  if (!fixedCandidate) return [];

  const entries = [];
  for (const group of sourceGroups || []) {
    if (!group || !Array.isArray(group.candidates)) continue;
    for (const cand of group.candidates) {
      if (!cand || !cand.id || !cand.url) continue;
      entries.push({
        id: `dual-${cand.id}-${fixedCandidate.id}`,
        mainSub: cand,
        fixedSub: fixedCandidate,
        source: group.source,
        label: cand.label || cand.id
      });
    }
  }
  return entries;
}
```

Update the `module.exports` at the bottom of the file to:

```javascript
module.exports = {
  filterByLanguage,
  rankCandidatesForLanguage,
  generateCandidatePairs,
  buildHebrewEntries,
  _internal: { selfScore }
};
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node test.js`
Expected: all `buildHebrewEntries` tests pass, and every pre-existing test still passes (no regressions).

- [ ] **Step 5: Commit**

```bash
git add lib/sourceSelection.js test.js
git commit -m "feat: add pure buildHebrewEntries picker-list function"
```

---

### Task 4: Wire the multi-source listing into `subtitlesHandler`

**Files:**
- Modify: `addon.js:126` (import line)
- Modify: `addon.js:764-869` (`subtitlesHandler`) — insert new branch and new `buildHebrewMultiSourceResponse` function
- Create: `scripts/test_hebrew_multisource.js`

**Interfaces:**
- Consumes: `fetchWizdomSubtitles`, `fetchKtuvitSubtitles` (Task 1), `fetchSecondarySubtitles` (existing, gains `label` in Task 2), `buildHebrewEntries` (Task 3), `rankCandidatesForLanguage` (existing, needs adding to the import line), `filterSubtitlesByLanguage` (existing local function in `addon.js`), `fetchAllSubtitles` (existing local function), `getLanguageName` (existing import).
- Produces: `async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, fixedLang, videoParams, videoQuery)` → `Promise<{subtitles: Array, cacheMaxAge?: number}>` — same return shape `subtitlesHandler` already returns to the Stremio SDK.

- [ ] **Step 1: Write the live verification script first (documents expected behavior before the implementation exists)**

Create `scripts/test_hebrew_multisource.js`:

```javascript
const { subtitlesHandler } = require('../addon');

async function testHebrewListing() {
  // tt15047880 (Disclosure Day): 0 heb on OpenSubtitles primary, but
  // Wizdom (9) and Ktuvit (3) both have real entries — verified live
  // 2026-08-02. With heb configured, every one of those should become
  // its own picker entry, Wizdom first, then Ktuvit, then any
  // OpenSubtitles-heb, then mirror-heb only if still needed.
  const result = await subtitlesHandler({
    type: 'movie',
    id: 'tt15047880',
    extra: {},
    config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' }
  });

  const subs = result.subtitles || [];
  console.log(`Got ${subs.length} entries`);

  if (subs.length === 0) {
    console.log('FAILED: expected at least one Hebrew multi-source entry');
    process.exit(1);
  }

  const wizdomCount = subs.filter(s => s.SubtitlesName.includes('[wizdom]')).length;
  const ktuvitCount = subs.filter(s => s.SubtitlesName.includes('[ktuvit]')).length;
  console.log(`wizdom=${wizdomCount} ktuvit=${ktuvitCount}`);

  if (wizdomCount === 0) {
    console.log('FAILED: expected at least one wizdom entry');
    process.exit(1);
  }
  if (ktuvitCount === 0) {
    console.log('FAILED: expected at least one ktuvit entry');
    process.exit(1);
  }

  // Priority order: every wizdom entry must appear before every ktuvit entry.
  const firstKtuvitIdx = subs.findIndex(s => s.SubtitlesName.includes('[ktuvit]'));
  const lastWizdomIdx = subs.map(s => s.SubtitlesName.includes('[wizdom]')).lastIndexOf(true);
  if (firstKtuvitIdx < lastWizdomIdx) {
    console.log('FAILED: a ktuvit entry appeared before a wizdom entry');
    process.exit(1);
  }

  console.log('HEBREW LISTING SUCCESS');
}

async function testNonHebrewRegression() {
  // A non-Hebrew language pair must take the untouched legacy path:
  // exactly one entry, the existing "★ Dual (...)" naming.
  const result = await subtitlesHandler({
    type: 'series',
    id: 'tt28118211:1:1',
    extra: {},
    config: { mainLang: 'English [eng]', transLang: 'Russian [rus]' }
  });

  const subs = result.subtitles || [];
  console.log(`Non-Hebrew: got ${subs.length} entries`);

  if (subs.length !== 1) {
    console.log('FAILED: expected exactly 1 entry for the legacy non-Hebrew path, got', subs.length);
    process.exit(1);
  }
  if (!subs[0].SubtitlesName.startsWith('★ Dual (')) {
    console.log('FAILED: legacy entry naming changed unexpectedly:', subs[0].SubtitlesName);
    process.exit(1);
  }

  console.log('NON-HEBREW REGRESSION SUCCESS');
}

testHebrewListing().then(testNonHebrewRegression);
```

- [ ] **Step 2: Run it to confirm the Hebrew-listing check fails (feature not wired in yet)**

Run: `node scripts/test_hebrew_multisource.js`
Expected: `Got 1 entries` then `FAILED: expected at least one wizdom entry` (today's code still returns the single legacy entry for every language pair, Hebrew included).

- [ ] **Step 3: Add the new import**

In `addon.js:126`, change:
```javascript
const { generateCandidatePairs } = require('./lib/sourceSelection');
```
to:
```javascript
const { generateCandidatePairs, rankCandidatesForLanguage, buildHebrewEntries } = require('./lib/sourceSelection');
```

- [ ] **Step 4: Add `buildHebrewMultiSourceResponse` and branch `subtitlesHandler` into it**

In `addon.js`, `subtitlesHandler` currently starts its `try` block (around line 800) with:
```javascript
  try {
    // Video params for better matching
    const videoParams = {
      filename: extra?.filename,
      videoSize: extra?.videoSize,
      videoHash: extra?.videoHash
    };
    const videoQuery = serializeVideoParams(videoParams);

    // Fetch all subtitles
    debugServer.log('Fetching subtitles from OpenSubtitles...');
    const allSubtitles = await fetchAllSubtitles(imdbId, type, season, episode, videoParams, mainLang, transLang);
```

Change it to insert the branch right after `videoQuery` is computed, before the existing `fetchAllSubtitles` call:

```javascript
  try {
    // Video params for better matching
    const videoParams = {
      filename: extra?.filename,
      videoSize: extra?.videoSize,
      videoHash: extra?.videoHash
    };
    const videoQuery = serializeVideoParams(videoParams);

    // Hebrew gets its own multi-source picker-list path (Wizdom, Ktuvit,
    // OpenSubtitles, mirror fallback) — every other language pair keeps
    // the original single-best-pair behavior below, untouched.
    const fixedLang = mainLang === 'heb' ? transLang : (transLang === 'heb' ? mainLang : null);
    if (fixedLang !== null) {
      return await buildHebrewMultiSourceResponse(imdbId, type, season, episode, fixedLang, videoParams, videoQuery);
    }

    // Fetch all subtitles
    debugServer.log('Fetching subtitles from OpenSubtitles...');
    const allSubtitles = await fetchAllSubtitles(imdbId, type, season, episode, videoParams, mainLang, transLang);
```

Then add the new function directly above `subtitlesHandler`'s own definition (i.e. just before the line `async function subtitlesHandler({ type, id, extra, config }) {`):

```javascript
/**
 * Build the Stremio subtitles-handler response for a Hebrew-involved
 * language pair: one picker entry per Hebrew candidate from every
 * source (no cap), each paired with a single fixed candidate for the
 * other configured language. Priority order: Wizdom, Ktuvit,
 * OpenSubtitles primary, then the community mirror — the mirror is
 * queried only if the first three collectively have zero Hebrew
 * candidates or zero fixedLang candidate.
 */
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, fixedLang, videoParams, videoQuery) {
  const { fetchWizdomSubtitles, fetchKtuvitSubtitles } = require('./lib/hebrewSources');
  const { fetchSecondarySubtitles } = require('./lib/secondarySource');

  const [wizdomSubs, ktuvitSubs, primarySubs] = await Promise.all([
    fetchWizdomSubtitles(imdbId, type, season, episode),
    fetchKtuvitSubtitles(imdbId, type, season, episode),
    fetchAllSubtitles(imdbId, type, season, episode, videoParams, 'heb', fixedLang)
  ]);

  const primarySubsList = primarySubs || [];

  const primaryHebRaw = filterSubtitlesByLanguage(primarySubsList, 'heb') || [];
  const primaryHebSubs = primaryHebRaw.map(s => ({
    id: `opensubtitles:${s.id}`,
    url: s.url,
    lang: 'heb',
    source: 'opensubtitles',
    label: String(s.id)
  }));

  const fixedRanked = rankCandidatesForLanguage(primarySubsList, fixedLang);
  let fixedCandidate = fixedRanked.length > 0
    ? { id: `opensubtitles:${fixedRanked[0].id}`, url: fixedRanked[0].url, lang: fixedLang }
    : null;

  const hasAnyHeb = wizdomSubs.length > 0 || ktuvitSubs.length > 0 || primaryHebSubs.length > 0;

  let mirrorHebSubs = [];
  if (!hasAnyHeb || !fixedCandidate) {
    debugServer.log(
      `Hebrew multi-source: primary sources missing coverage (heb=${!hasAnyHeb}, ${fixedLang}=${!fixedCandidate}), trying mirror fallback`
    );
    const mirrorSubs = await fetchSecondarySubtitles(imdbId, type, 'heb', fixedLang);

    if (!hasAnyHeb) {
      mirrorHebSubs = mirrorSubs
        .filter(s => s.lang === 'heb')
        .map(s => ({
          id: `mirror:${s.id}`,
          url: s.url,
          lang: 'heb',
          source: 'mirror',
          label: s.label || s.id
        }));
    }

    if (!fixedCandidate) {
      const mirrorFixed = mirrorSubs.find(s => s.lang === fixedLang);
      if (mirrorFixed) {
        fixedCandidate = { id: `mirror:${mirrorFixed.id}`, url: mirrorFixed.url, lang: fixedLang };
      }
    }
  }

  if (!fixedCandidate) {
    debugServer.warn(`Hebrew multi-source: no ${fixedLang} candidate found from any source`);
    return { subtitles: [] };
  }

  const sourceGroups = [
    { source: 'wizdom', candidates: wizdomSubs },
    { source: 'ktuvit', candidates: ktuvitSubs },
    { source: 'opensubtitles', candidates: primaryHebSubs },
    { source: 'mirror', candidates: mirrorHebSubs }
  ];

  const entries = buildHebrewEntries(sourceGroups, fixedCandidate, fixedLang);

  if (entries.length === 0) {
    debugServer.warn('Hebrew multi-source: no Hebrew candidates found from any source');
    return { subtitles: [] };
  }

  const finalSubtitles = entries.map(entry => {
    const dynamicParams = [
      type,
      imdbId,
      season || '0',
      episode || '0',
      'heb',
      fixedLang,
      encodeURIComponent(entry.mainSub.id),
      encodeURIComponent(entry.fixedSub.id)
    ].join('/');

    return {
      id: entry.id,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: 'heb',
      SubtitlesName: `★ [${entry.source}] ${entry.label} + ${getLanguageName(fixedLang)}`
    };
  });

  debugServer.log(`Hebrew multi-source: publishing ${finalSubtitles.length} entries`);

  return { subtitles: finalSubtitles, cacheMaxAge: 6 * 3600 };
}

```

- [ ] **Step 5: Run the verification script**

Run: `node scripts/test_hebrew_multisource.js`
Expected: `HEBREW LISTING SUCCESS` printed, then it moves on to the non-Hebrew regression check — that one is expected to still print `NON-HEBREW REGRESSION SUCCESS` since the branch only fires when `fixedLang !== null`.

If it fails, note it's using real network calls, so a transient failure from Wizdom/Ktuvit/OpenSubtitles being down is possible — rerun once before treating a failure as a real bug.

- [ ] **Step 6: Run the full unit test suite to confirm no regressions**

Run: `node test.js`
Expected: all tests pass, including the `buildHebrewEntries` tests from Task 3.

- [ ] **Step 7: Commit**

```bash
git add addon.js scripts/test_hebrew_multisource.js
git commit -m "feat: publish one picker entry per Hebrew subtitle candidate across all sources"
```

---

### Task 5: Locked pairing in `generateDynamicSubtitle`

**Files:**
- Modify: `addon.js:890-984` (`generateDynamicSubtitle`) — add prefix detection and two new helper functions (`fetchLockedCandidate`, `generateLockedPairSubtitle`)

**Interfaces:**
- Consumes: `fetchWizdomSubtitles`, `fetchKtuvitSubtitles` (Task 1), `fetchSecondarySubtitles` (existing), `filterSubtitlesByLanguage`, `fetchAllSubtitles`, `fetchSubtitleContent`, `parseSrt`, `mergeSubtitles`, `formatSrt`, `storeSubtitle` (all existing local functions in `addon.js`).
- Produces: `generateDynamicSubtitle(...)` keeps its existing signature and return contract (`Promise<string|null>`); internally, ids with a recognized source prefix (`wizdom:`, `ktuvit:`, `opensubtitles:`, `mirror:`) now take the new locked-pairing path instead of the legacy quality-gate swap-loop.

- [ ] **Step 1: Extend `scripts/test_hebrew_multisource.js` to cover the locked-fetch path**

Add this function and call to `scripts/test_hebrew_multisource.js` (append before the final `testHebrewListing().then(testNonHebrewRegression);` line, and change that final line as shown):

```javascript
const { generateDynamicSubtitle } = require('../addon');

async function testLockedPairFetch() {
  // Re-run the listing to get a real Wizdom entry id, then fetch its
  // .srt via generateDynamicSubtitle exactly like server.js's /subs/
  // route would, and confirm it returns real merged content — not a
  // silently-substituted different pair.
  const listing = await subtitlesHandler({
    type: 'movie',
    id: 'tt15047880',
    extra: {},
    config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' }
  });

  const wizdomEntry = (listing.subtitles || []).find(s => s.SubtitlesName.includes('[wizdom]'));
  if (!wizdomEntry) {
    console.log('FAILED: no wizdom entry in listing to test locked-fetch against');
    process.exit(1);
  }

  // Extract mainSubId/transSubId from the entry's own generated URL
  // (same fields server.js would parse from the real request path).
  const match = wizdomEntry.url.match(/\/subs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.srt/);
  if (!match) {
    console.log('FAILED: could not parse dynamic URL', wizdomEntry.url);
    process.exit(1);
  }
  const [, type, imdbId, season, episode, mainLang, transLang, mainSubId, transSubId] = match;

  const srt = await generateDynamicSubtitle(
    type, imdbId, season, episode, mainLang, transLang,
    decodeURIComponent(mainSubId), decodeURIComponent(transSubId)
  );

  if (!srt) {
    console.log('FAILED: expected merged SRT content for the locked wizdom pair, got null');
    process.exit(1);
  }
  if (!decodeURIComponent(mainSubId).startsWith('wizdom:')) {
    console.log('FAILED: test setup bug — mainSubId is not a wizdom id');
    process.exit(1);
  }

  console.log('LOCKED PAIR FETCH SUCCESS, length:', srt.length);
}

testHebrewListing().then(testNonHebrewRegression).then(testLockedPairFetch);
```

- [ ] **Step 2: Run it to confirm the new check fails**

Run: `node scripts/test_hebrew_multisource.js`
Expected: `HEBREW LISTING SUCCESS`, `NON-HEBREW REGRESSION SUCCESS`, then `FAILED: expected merged SRT content for the locked wizdom pair, got null` (locked-pairing dispatch not wired in yet — `generateDynamicSubtitle` doesn't recognize the `wizdom:` prefix, falls into the legacy path, which looks up `mainSubId` in `allSubtitles` from `fetchAllSubtitles` and won't find it there since Wizdom isn't part of that list).

- [ ] **Step 3: Add the two new helper functions**

Add these directly above `generateDynamicSubtitle`'s own definition (i.e. just before `async function generateDynamicSubtitle(`):

```javascript
const HEB_SOURCE_PREFIXES = ['wizdom:', 'ktuvit:', 'opensubtitles:', 'mirror:'];

function isLockedSourceId(id) {
  return typeof id === 'string' && HEB_SOURCE_PREFIXES.some(p => id.startsWith(p));
}

/**
 * Re-resolve a single source-prefixed subtitle id back to its
 * {id, url, lang} by re-fetching that source's list for this title and
 * finding the matching entry. Wizdom/Ktuvit/the mirror only expose a
 * per-title list endpoint, not a per-id lookup, so this re-fetch is
 * unavoidable — but it's the same call the listing step already made,
 * so it's a cache-friendly repeat, not new load shape.
 */
async function fetchLockedCandidate(prefixedId, imdbId, type, season, episode, lang) {
  const sepIdx = prefixedId.indexOf(':');
  const source = prefixedId.slice(0, sepIdx);

  let candidates = [];
  if (source === 'wizdom') {
    const { fetchWizdomSubtitles } = require('./lib/hebrewSources');
    candidates = await fetchWizdomSubtitles(imdbId, type, season, episode);
  } else if (source === 'ktuvit') {
    const { fetchKtuvitSubtitles } = require('./lib/hebrewSources');
    candidates = await fetchKtuvitSubtitles(imdbId, type, season, episode);
  } else if (source === 'opensubtitles') {
    const primarySubs = await fetchAllSubtitles(imdbId, type, season, episode, {}, lang, lang) || [];
    const raw = filterSubtitlesByLanguage(primarySubs, lang) || [];
    candidates = raw.map(s => ({ id: `opensubtitles:${s.id}`, url: s.url, lang }));
  } else if (source === 'mirror') {
    const { fetchSecondarySubtitles } = require('./lib/secondarySource');
    const mirrorSubs = await fetchSecondarySubtitles(imdbId, type, lang, lang);
    candidates = mirrorSubs
      .filter(s => s.lang === lang)
      .map(s => ({ id: `mirror:${s.id}`, url: s.url, lang }));
  }

  return candidates.find(c => c.id === prefixedId) || null;
}

/**
 * Merge exactly the requested (mainSubId, transSubId) pair — no
 * quality-gate try-loop, no substitution. If either side can't be
 * re-resolved, fetched, parsed, or merged, return null so the caller
 * (server.js's /subs/ route) responds 404 rather than serving a
 * different Hebrew subtitle than the one the user picked.
 */
async function generateLockedPairSubtitle(mainSubId, transSubId, mainLang, transLang, imdbId, type, season, episode, cacheKey) {
  const [mainCandidate, transCandidate] = await Promise.all([
    fetchLockedCandidate(mainSubId, imdbId, type, season, episode, mainLang),
    fetchLockedCandidate(transSubId, imdbId, type, season, episode, transLang)
  ]);

  if (!mainCandidate || !transCandidate) {
    debugServer.warn('Locked pair: candidate not found on re-fetch', { mainSubId, transSubId });
    return null;
  }

  const [mainContent, transContent] = await Promise.all([
    fetchSubtitleContent(mainCandidate.url, mainLang),
    fetchSubtitleContent(transCandidate.url, transLang)
  ]);

  const mainParsed = mainContent ? parseSrt(mainContent) : null;
  const transParsed = transContent ? parseSrt(transContent) : null;

  if (!mainParsed || mainParsed.length === 0 || !transParsed || transParsed.length === 0) {
    debugServer.warn('Locked pair: one or both subtitles unparsable', { mainSubId, transSubId });
    return null;
  }

  const merged = mergeSubtitles(mainParsed, transParsed, { mainLang, transLang });
  if (!merged || merged.length === 0) {
    debugServer.warn('Locked pair: merge produced no aligned lines', { mainSubId, transSubId });
    return null;
  }

  const srtContent = formatSrt(merged);
  debugServer.log(`Locked pair generated ${merged.length} entries for ${mainSubId} + ${transSubId}`);
  if (srtContent) storeSubtitle(cacheKey, srtContent);
  return srtContent;
}
```

- [ ] **Step 4: Branch `generateDynamicSubtitle` into the locked path**

Find the start of `generateDynamicSubtitle`'s body — right after the cache-check block:
```javascript
  const cached = getSubtitle(cacheKey);
  if (cached) {
    debugServer.log(`Cache hit (in-instance): ${cacheKey}`);
    return cached;
  }

  try {
```
Change the `try` block's opening to add the branch as its first statement:
```javascript
  const cached = getSubtitle(cacheKey);
  if (cached) {
    debugServer.log(`Cache hit (in-instance): ${cacheKey}`);
    return cached;
  }

  if (isLockedSourceId(mainSubId) && isLockedSourceId(transSubId)) {
    return await generateLockedPairSubtitle(
      mainSubId, transSubId, mainLang, transLang, imdbId, type, season, episode, cacheKey
    );
  }

  try {
```

- [ ] **Step 5: Run the verification script**

Run: `node scripts/test_hebrew_multisource.js`
Expected: `HEBREW LISTING SUCCESS`, `NON-HEBREW REGRESSION SUCCESS`, `LOCKED PAIR FETCH SUCCESS, length: N` — no `FAILED` lines.

- [ ] **Step 6: Regression-check the legacy swap-loop path still works (non-Hebrew title, existing quality-gate logic untouched)**

Run:
```bash
node -e "
const { generateDynamicSubtitle } = require('./addon');
generateDynamicSubtitle('series', '28118211', '1', '1', 'eng', 'rus', 'dummyMain', 'dummyTrans')
  .then(srt => console.log(srt ? 'OK length=' + srt.length : 'FAILED'));
"
```
Expected: `OK length=N` (unprefixed ids like `dummyMain`/`dummyTrans` don't match `HEB_SOURCE_PREFIXES`, so `isLockedSourceId` returns false and the existing `candidatePairs`/`selectAndMergeBestPair` logic runs exactly as before).

- [ ] **Step 7: Run the full unit test suite**

Run: `node test.js`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add addon.js scripts/test_hebrew_multisource.js
git commit -m "feat: lock Hebrew multi-source picks to their exact pair, no silent swap"
```

---

### Task 6: End-to-end sanity pass

**Files:** none created or modified — verification only.

**Interfaces:** none (this task runs existing scripts/tests, no new code).

- [ ] **Step 1: Run every verification script in sequence**

```bash
node scripts/test_hebrew_sources.js
node scripts/test_secondary_fallback.js
node scripts/test_hebrew_multisource.js
node test.js
```
Expected: every script prints its `SUCCESS`/`OK` lines with zero `FAILED` lines, and `node test.js` reports all tests passing with no failures.

- [ ] **Step 2: Confirm no dependency or lint regressions**

Run: `npm test` (repo's `package.json` `test` script — currently just `node test.js`, confirms nothing else broke)
Expected: same as Step 1's `node test.js` result.

- [ ] **Step 3: No commit needed for this task (verification only)** — if any script fails here, stop and fix the relevant earlier task before moving to Task 7.

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (Troubleshooting section, "Subtitles Not Showing" list — same location Task 3 of the 2026-07-29 plan added its bullet, around line 440-450)
- Modify: `CHANGELOG.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a bullet to README.md's "Subtitles Not Showing" troubleshooting list**

```markdown
6. **Multiple Hebrew options**: when Hebrew is one of your two configured languages, the addon lists every Hebrew subtitle it can find from Wizdom, Ktuvit, and OpenSubtitles (labeled `★ [wizdom] ...`, `★ [ktuvit] ...`, `★ [opensubtitles] ...`) as separate picker entries instead of guessing one — if one option is out of sync, try another from the list.
```

- [ ] **Step 2: Add a CHANGELOG.md entry under the existing "Unreleased" heading (or create one at the top if the 2026-07-29 entry was already released/versioned)**

```markdown
**Added**
- Multi-source Hebrew subtitles: when Hebrew is configured, every Hebrew subtitle candidate from Wizdom, Ktuvit, and OpenSubtitles (plus the mirror as a last-resort fallback) is listed as its own picker entry, so sync issues on one release can be worked around by trying another.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document multi-source Hebrew subtitle listing"
```

---

## Self-Review

**Spec coverage:** source inventory + priority order (Task 1, 4), fallback-trigger condition (Task 4), no-cap listing (Task 3/4), naming (Task 4), locked pairing / no silent swap (Task 5), no auto/best-guess entry (Task 4 has none), legacy non-Hebrew path untouched (Task 4/5 regression checks), testing convention followed (Tasks 1-6 all use the existing `test(name,fn)`/`assert` pattern or the `scripts/*.js` live-verification pattern).

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code.

**Type consistency:** `fetchWizdomSubtitles`/`fetchKtuvitSubtitles` (Task 1) return shape `{id, url, lang, source, label}` is what `buildHebrewMultiSourceResponse` (Task 4) consumes directly as `sourceGroups[].candidates`. `buildHebrewEntries` (Task 3) signature `(sourceGroups, fixedCandidate, fixedLang)` matches its one call site in Task 4. `generateLockedPairSubtitle`'s parameter order (Task 5) matches its one call site in `generateDynamicSubtitle`. The `mirror:` prefix produced in Task 4's `mirrorHebSubs`/`fixedCandidate` mapping matches what Task 5's `fetchLockedCandidate`'s `mirror` branch re-derives (`mirror:${s.id}` in both places, same underlying `fetchSecondarySubtitles` call).
