# Hebrew Subtitle Source Label — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On confirmed desktop/browser-shaped Stremio clients, show which source (Wizdom/Ktuvit/OpenSubtitles/mirror) each Hebrew picker entry came from, by setting that entry's `lang` field to a short label instead of the plain language code. On every other client (including Android phone/TV, which sends no `User-Agent` at all) the picker stays exactly as it is today.

**Architecture:** One new pure-logic module (`lib/clientDetection.js`) holding the UA classifier, consumed once per request inside `buildHebrewMultiSourceResponse` (`addon.js`) to decide each entry's `lang` value. No other file changes. Spec: `docs/superpowers/specs/2026-08-03-hebrew-subtitle-source-label-phase2-design.md`.

**Tech Stack:** Node.js, plain `assert`-based tests (`test.js`, run via `npm test`).

## Global Constraints

- The matcher must be a pure function: no env reads, no I/O, no side effects — same shape as `lib/sourceSelection.js`.
- Missing/empty/`undefined` `User-Agent` must always classify as non-desktop (deny) — this is what keeps Android (confirmed: sends no `User-Agent` header at all) safe by construction, not by a special case.
- Match on UA *structure* (desktop-OS token + browser-engine token, no `Android`/`Mobile` token), never an exact UA string — exact-string matching breaks on the next Chrome/Edge version bump.
- The non-Hebrew single-pair path (`addon.js:1108`, `★ Dual (...)` naming) is untouched — out of scope, same boundary the original multi-source design and Phase 1 both held.
- `SubtitlesName` stays in the response unchanged — no reason to remove it, it's inert but harmless.
- Never introduce a code path where a non-Hebrew, non-desktop, or unrecognized client can end up with anything other than the current plain `lang: mainLang` value — this repo has broken Android TV subtitle listing once already by setting a non-standard `lang` value (`git show cbafce7`).

---

### Task 1: `lib/clientDetection.js` — the UA classifier

**Files:**
- Create: `lib/clientDetection.js`
- Test: `test.js` (new block, own section)

**Interfaces:**
- Produces: `isDesktopBrowserLikeClient(userAgent)` — pure function, `userAgent` is a string or `undefined`/`null`/`''`, returns a boolean.

- [ ] **Step 1: Write the failing tests**

Add a new section to `test.js`, after the existing `--- Hebrew multi-source ---` block ends (that block currently runs from `test.js:838` through the last `testAsync(...)` call — add this new section after all of it, before the final `runAsyncTests()` invocation at the bottom of the file):

```js
// ============================================================================
// clientDetection — desktop/browser UA classifier [Phase 2]
// ============================================================================
console.log('\n--- clientDetection ---');

const { isDesktopBrowserLikeClient } = require('./lib/clientDetection');

test('isDesktopBrowserLikeClient: the confirmed live Windows desktop UA is allowed', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0';
  assert.strictEqual(isDesktopBrowserLikeClient(ua), true);
});

test('isDesktopBrowserLikeClient: a Firefox-on-Linux desktop UA is allowed (not Chrome-only)', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
  assert.strictEqual(isDesktopBrowserLikeClient(ua), true);
});

test('isDesktopBrowserLikeClient: a Mac desktop browser UA is allowed', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15';
  assert.strictEqual(isDesktopBrowserLikeClient(ua), true);
});

test('isDesktopBrowserLikeClient: an Android phone browser UA is denied', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
  assert.strictEqual(isDesktopBrowserLikeClient(ua), false);
});

test('isDesktopBrowserLikeClient: no User-Agent at all (the confirmed live Android app behavior) is denied', () => {
  assert.strictEqual(isDesktopBrowserLikeClient(undefined), false);
  assert.strictEqual(isDesktopBrowserLikeClient(null), false);
  assert.strictEqual(isDesktopBrowserLikeClient(''), false);
});

test('isDesktopBrowserLikeClient: the literal string "unknown" (Phase 1 logging fallback) is denied', () => {
  assert.strictEqual(isDesktopBrowserLikeClient('unknown'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './lib/clientDetection'` (the file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/clientDetection.js`:

```js
function isDesktopBrowserLikeClient(userAgent) {
  if (!userAgent) return false;
  if (/Android|Mobile/.test(userAgent)) return false;
  const hasDesktopOs = /Windows NT|Macintosh|X11/.test(userAgent);
  const hasBrowserEngine = /Chrome\/|Safari\/|Firefox\//.test(userAgent);
  return hasDesktopOs && hasBrowserEngine;
}

module.exports = { isDesktopBrowserLikeClient };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for all 6 new assertions, and every pre-existing test (97 as of the end of Phase 1) still PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/clientDetection.js test.js
git commit -m "feat: add isDesktopBrowserLikeClient UA classifier"
```

---

### Task 2: Wire the classifier into the Hebrew multi-source listing

**Files:**
- Modify: `addon.js:12` (import), `addon.js:918-924` (function signature + decision), `addon.js:988-994` (per-entry `lang`)
- Test: `test.js` (extend the existing `listWithStubbedSources` helper and Hebrew multi-source block)
- Test (manual/live, optional): `scripts/test_hebrew_multisource.js`

**Interfaces:**
- Consumes: `isDesktopBrowserLikeClient(userAgent)` from Task 1.
- Produces: no new exports — `buildHebrewMultiSourceResponse`'s existing signature and return shape are unchanged; only the *values* inside published entries' `lang` field change, conditionally.

- [ ] **Step 1: Write the failing tests**

`test.js`'s existing `listWithStubbedSources` helper (`test.js:902-921`) calls `buildHebrewMultiSourceResponse('15047880', 'movie', null, null, mainLang, transLang, {}, '')` — 8 positional args, no `userAgent`. Extend it to accept and forward an optional 4th parameter:

```js
// Before (test.js:902)
async function listWithStubbedSources({ wizdom = [], ktuvit = [], opensubtitles = [], mirror = [] }, mainLang, transLang) {

// After
async function listWithStubbedSources({ wizdom = [], ktuvit = [], opensubtitles = [], mirror = [] }, mainLang, transLang, userAgent) {
```

```js
// Before (test.js:914-916)
    const result = await buildHebrewMultiSourceResponse(
      '15047880', 'movie', null, null, mainLang, transLang, {}, ''
    );

// After
    const result = await buildHebrewMultiSourceResponse(
      '15047880', 'movie', null, null, mainLang, transLang, {}, '', userAgent
    );
```

This is backward-compatible — every existing call site omits the 4th argument, so `userAgent` is `undefined` there, same as before this change.

Then add new tests in the `--- Hebrew multi-source ---` block, right after the existing `HEB_SOURCES: every row constructs ids...` test (`test.js:873-896`) and before the `listWithStubbedSources` helper definition — actually, since the helper itself is being modified, add these new tests **after** the helper definition and the `MIRROR_RAW` constant (i.e., after `test.js:928`, alongside the other `testAsync(...)` calls that use `listWithStubbedSources`):

```js
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0';

testAsync('listing: desktop UA gets a [source]-labeled lang; no UA keeps plain lang [Phase 2]', async () => {
  const wizdomRaw = [{ id: 'wizdom:1', url: 'https://w/1.srt', lang: 'heb', source: 'wizdom', label: 'Some.Release.Name' }];
  const osRaw = [{ id: '777', url: 'https://os/r.srt', lang: 'rus' }];

  const withDesktopUa = await listWithStubbedSources(
    { wizdom: wizdomRaw, opensubtitles: osRaw }, 'heb', 'rus', DESKTOP_UA
  );
  assert.strictEqual(withDesktopUa.subtitles.length, 1);
  assert.strictEqual(
    withDesktopUa.subtitles[0].lang,
    '[wizdom] Some.Release.Name + Russian',
    `expected a [source]-labeled lang, got: ${withDesktopUa.subtitles[0].lang}`
  );
  // SubtitlesName must be unaffected by this change — still the existing ★-prefixed text.
  assert.strictEqual(withDesktopUa.subtitles[0].SubtitlesName, '★ [wizdom] Some.Release.Name + Russian');

  const withNoUa = await listWithStubbedSources(
    { wizdom: wizdomRaw, opensubtitles: osRaw }, 'heb', 'rus', undefined
  );
  assert.strictEqual(withNoUa.subtitles.length, 1);
  assert.strictEqual(
    withNoUa.subtitles[0].lang,
    'heb',
    `expected plain lang for a client with no User-Agent, got: ${withNoUa.subtitles[0].lang}`
  );

  const androidUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
  const withAndroidUa = await listWithStubbedSources(
    { wizdom: wizdomRaw, opensubtitles: osRaw }, 'heb', 'rus', androidUa
  );
  assert.strictEqual(
    withAndroidUa.subtitles[0].lang,
    'heb',
    `expected plain lang for an Android UA even if one were ever sent, got: ${withAndroidUa.subtitles[0].lang}`
  );
});

testAsync('listing: desktop-UA labeling applies per entry across multiple sources [Phase 2]', async () => {
  const { subtitles } = await listWithStubbedSources({
    wizdom: [{ id: 'wizdom:1', url: 'https://w/1.srt', lang: 'heb', source: 'wizdom', label: 'W.Release' }],
    ktuvit: [{ id: 'ktuvit:1', url: 'https://k/1.srt', lang: 'heb', source: 'ktuvit', label: 'K.Release' }],
    opensubtitles: [{ id: '777', url: 'https://os/r.srt', lang: 'rus' }]
  }, 'heb', 'rus', DESKTOP_UA);

  assert.strictEqual(subtitles.length, 2);
  assert.strictEqual(subtitles[0].lang, '[wizdom] W.Release + Russian');
  assert.strictEqual(subtitles[1].lang, '[ktuvit] K.Release + Russian');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildHebrewMultiSourceResponse` still ignores `userAgent` (`void userAgent;` at `addon.js:924`), so every entry's `lang` is still plain `mainLang`/`heb` regardless of the UA passed; the assertion expecting `'[wizdom] Some.Release.Name + Russian'` fails.

- [ ] **Step 3: Write minimal implementation**

In `addon.js`, add the import at the top (`addon.js:12`, alongside the existing `lib/debug` import):

```js
// Before
const { debugServer, sanitizeForLogging, logUserAgentSample } = require('./lib/debug');

// After
const { debugServer, sanitizeForLogging, logUserAgentSample } = require('./lib/debug');
const { isDesktopBrowserLikeClient } = require('./lib/clientDetection');
```

Replace the unused-parameter placeholder (`addon.js:918-924`):

```js
// Before
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  // userAgent is accepted and threaded through but intentionally unused
  // beyond this point — Phase 2 (see docs/superpowers/specs/2026-08-02-
  // hebrew-subtitle-source-label-design.md) will gate a per-entry `lang`
  // label on it once real client User-Agent samples are collected.
  void userAgent;

// After
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  const showSourceLabel = isDesktopBrowserLikeClient(userAgent);
```

Replace the per-entry return block (`addon.js:988-994`):

```js
// Before
    return {
      id: entry.id,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: mainLang,
      SubtitlesName: `★ [${entry.source}] ${entry.label} + ${getLanguageName(fixedLang)}`
    };
  });

// After
    const labelText = `[${entry.source}] ${entry.label} + ${getLanguageName(fixedLang)}`;
    return {
      id: entry.id,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: showSourceLabel ? labelText : mainLang,
      SubtitlesName: `★ ${labelText}`
    };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for both new tests and every pre-existing test (all offline, no network required for this step).

- [ ] **Step 5: Optional live integration check**

In `scripts/test_hebrew_multisource.js`, in `testHebrewListing`, after the existing call to `subtitlesHandler` (the one using `tt15047880`), add a second call passing the confirmed desktop UA and assert the difference end-to-end against real Wizdom/Ktuvit data:

```js
const desktopResult = await subtitlesHandler({
  type: 'movie',
  id: 'tt15047880',
  extra: {},
  config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
});
const desktopSubs = desktopResult.subtitles || [];
const labeledCount = desktopSubs.filter(s => /^\[\w+\]/.test(s.lang)).length;
console.log(`Desktop-UA listing: ${labeledCount}/${desktopSubs.length} entries have a [source]-labeled lang`);
if (labeledCount !== desktopSubs.length) {
  console.log('FAILED: expected every entry to carry a [source]-labeled lang when the UA is desktop-shaped');
  process.exit(1);
}
```

Run: `node scripts/test_hebrew_multisource.js` (needs live network + any Ktuvit credentials the script already relies on). Expected: existing output unchanged, plus the new `Desktop-UA listing: N/N entries have a [source]-labeled lang` line. This step is a manual live-network check, same as the rest of this script — it does not run as part of `npm test`.

- [ ] **Step 6: Manual verification (requires real deploy)**

After deploying, open the addon on your real Windows Stremio client and confirm the Hebrew picker now shows distinguishable rows (e.g. `[wizdom] ...`, `[ktuvit] ...`) instead of identical `HEB+RUS` rows. Then open it on your real Android phone and confirm the picker still shows only `עברית` with no `und` and no blank rows — this is the check that matters most, since it's re-verifying the exact failure mode `cbafce7` fixed.

- [ ] **Step 7: Commit**

```bash
git add addon.js test.js scripts/test_hebrew_multisource.js
git commit -m "feat: label Hebrew picker entries by source on confirmed desktop/browser clients"
```
