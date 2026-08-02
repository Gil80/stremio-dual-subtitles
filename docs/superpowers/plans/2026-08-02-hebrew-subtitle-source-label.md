# Hebrew Subtitle Source Label — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the redundant "Dual Subtitles" wording from the per-config manifest name, and add safe, zero-behavior-change User-Agent instrumentation so a future Phase 2 can gate a per-source subtitle label without risking the Android "und"/blank-label regression this repo already hit once (see `git show cbafce7`).

**Architecture:** Two independent, additive changes to `addon.js` and `server.js`. No existing output changes except the manifest `name` string. `subtitlesHandler` gains one new optional parameter (`userAgent`) that is logged and threaded through to `buildHebrewMultiSourceResponse` but not yet used to change any `lang` value — that's Phase 2, out of scope here (spec: `docs/superpowers/specs/2026-08-02-hebrew-subtitle-source-label-design.md`).

**Tech Stack:** Node.js, Express, `stremio-addon-sdk`, plain `assert`-based tests (`test.js`, run via `npm test`).

## Global Constraints

- Subtitle objects sent to Stremio may only rely on `id`/`url`/`lang` being honored — no other field is guaranteed to render (confirmed against `stremio-addon-sdk/docs/api/responses/subtitles.md`).
- Never set a non-standard `lang` value unconditionally — this repo already broke Android TV listing this way once (`git show cbafce7`, fixed by reverting to `lang: mainLang`). This plan makes **no** `lang` value changes at all; it only adds instrumentation.
- `debugServer.log`/`warn`/`error` (`lib/debug.js`) are **no-ops unless `DEBUG_MODE=true`** is set in the environment at process start (the `enabled` flag is captured once at module load, in `createLogger`). The Phase 1 logging added here will not appear in Vercel logs unless `DEBUG_MODE=true` is set on that deployment before/during the observation window — this is a deploy-config step for Gil, not a code task, but must not be forgotten or Phase 2 has no data to work from.
- `subtitlesHandler`'s existing callers (`server.js:401`, `scripts/test_hebrew_multisource.js`) call it with an object that does not include `userAgent` — the new field must be optional and default safely so none of those call sites break.

---

### Task 1: Drop "Dual Subtitles" wording from the per-config manifest name

**Files:**
- Modify: `addon.js` (add a small pure exported helper near `ADDON_NAME`/`manifest`, around line 169-181)
- Modify: `server.js:365` (use the new helper instead of the inline template string)
- Test: `test.js` (new assertions in the existing "Manifest & subtitle output" section)

**Interfaces:**
- Produces: `buildConfiguredManifestName(mainCode, transCode)` — pure function, both args are already-parsed lowercase codes (e.g. `'heb'`, `'rus'`), returns a string like `"HEB+RUS"`. Exported top-level from `addon.js` (sibling to `manifest`, `subtitlesHandler`, etc. — this is production code `server.js` consumes directly, not a test-only internal, so it does not go in `_test`).

- [ ] **Step 1: Write the failing test**

Add to `test.js`, inside the existing `--- Manifest & subtitle output [Issue #5] ---` block (after the two tests at `test.js:411-417`), and add `buildConfiguredManifestName` to the top-level destructured import at `test.js:10-22` (alongside `manifest`):

```js
test('buildConfiguredManifestName drops the redundant "Dual Subtitles" wording', () => {
  assert.strictEqual(buildConfiguredManifestName('heb', 'rus'), 'HEB+RUS');
  assert.strictEqual(buildConfiguredManifestName('eng', 'tur'), 'ENG+TUR');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildConfiguredManifestName is not a function` (it isn't exported yet, so the destructured import is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `addon.js`, immediately after the `ADDON_NAME` constant (currently `addon.js:169`), add:

```js
function buildConfiguredManifestName(mainCode, transCode) {
  return `${mainCode.toUpperCase()}+${transCode.toUpperCase()}`;
}
```

Add `buildConfiguredManifestName` as a top-level export key (sibling to `builder`, `manifest`, `getSubtitle`, `subtitlesHandler`, `generateDynamicSubtitle` at `addon.js:1329-1335`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS for both new assertions, and all pre-existing tests still PASS (no other output changed).

- [ ] **Step 5: Wire it into `server.js` and drop the old wording**

In `server.js`, add `buildConfiguredManifestName` to the existing destructured import at the top (currently `server.js:22`):

```js
const { builder, manifest, getSubtitle, subtitlesHandler, generateDynamicSubtitle, buildConfiguredManifestName } = require('./addon');
```

Then replace the `name` line inside the `configuredManifest` object at `server.js:365`:

```js
// Before
name: `${manifest.name} (${mainCode.toUpperCase()}+${transCode.toUpperCase()})`,
// After
name: buildConfiguredManifestName(mainCode, transCode),
```

- [ ] **Step 6: Manual verification**

Run: `node server.js`, then in another terminal:
`curl -s http://localhost:7000/Hebrew%20%5Bheb%5D%7CRussian%20%5Brus%5D/manifest.json | grep '"name"'`
Expected: `"name":"HEB+RUS"` (no "Dual Subtitles" text). Stop the server after checking (Ctrl+C).

- [ ] **Step 7: Commit**

```bash
git add addon.js server.js test.js
git commit -m "fix: drop redundant \"Dual Subtitles\" wording from per-config manifest name"
```

---

### Task 2: Thread and log the request `User-Agent`, no behavior change

**Files:**
- Modify: `server.js:381-401` (configuration-specific subtitles route)
- Modify: `addon.js:993` (`subtitlesHandler` signature + entry log)
- Modify: `addon.js:914` and `addon.js:1044-1048` (`buildHebrewMultiSourceResponse` accepts and stores the param, unused otherwise)
- Test: `test.js` (new assertions using the same-language early-return path — no network call)
- Test (manual/live, optional): `scripts/test_hebrew_multisource.js`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `subtitlesHandler({ type, id, extra, config, userAgent })` — `userAgent` is an optional string, `undefined` when omitted. `buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent)` — same, appended as a final optional parameter so existing positional call sites without it remain valid.

- [ ] **Step 1: Write the failing test**

Add to `test.js`, in the same "Manifest & subtitle output" block:

```js
test('subtitlesHandler logs the User-Agent without changing output on identical-language input', async () => {
  const { debugServer } = require('./lib/debug');
  const { subtitlesHandler } = require('./addon');

  const originalLog = debugServer.log;
  const logged = [];
  debugServer.log = (...args) => { logged.push(args.join(' ')); };

  let result;
  try {
    result = await subtitlesHandler({
      type: 'movie',
      id: 'tt0000000',
      extra: {},
      config: { mainLang: 'English [eng]', transLang: 'English [eng]' },
      userAgent: 'TestPlatform/1.0 (unit-test)'
    });
  } finally {
    debugServer.log = originalLog;
  }

  assert.deepStrictEqual(result, { subtitles: [] });
  assert.ok(
    logged.some(line => line.includes('TestPlatform/1.0 (unit-test)')),
    `expected a debugServer.log call containing the User-Agent, got: ${JSON.stringify(logged)}`
  );
});
```

This uses the same-language early-return path (`addon.js:1006-1009`) specifically so the test needs no network access and stays fast and deterministic — same-language input returns `{ subtitles: [] }` before any fetch happens, but only *after* the entry-point logging this task adds.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — either `result` isn't `{ subtitles: [] }` (unlikely, that path is unchanged) or, most likely, `logged` never contains the User-Agent string because nothing logs it yet.

- [ ] **Step 3: Write minimal implementation**

In `addon.js`, change the `subtitlesHandler` signature and add one log line right after the existing entry log (`addon.js:993-994`):

```js
// Before
async function subtitlesHandler({ type, id, extra, config }) {
  debugServer.log('Subtitle request:', sanitizeForLogging({ type, id }));

// After
async function subtitlesHandler({ type, id, extra, config, userAgent }) {
  debugServer.log('Subtitle request:', sanitizeForLogging({ type, id }));
  debugServer.log('Client User-Agent:', sanitizeForLogging(userAgent || 'unknown'));
```

Then thread it into the Hebrew multi-source call site (`addon.js:1044-1048`):

```js
// Before
    if (mainLang === 'heb' || transLang === 'heb') {
      return await buildHebrewMultiSourceResponse(
        imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery
      );
    }

// After
    if (mainLang === 'heb' || transLang === 'heb') {
      return await buildHebrewMultiSourceResponse(
        imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent
      );
    }
```

And update `buildHebrewMultiSourceResponse`'s own signature (`addon.js:914`) to accept and store it — no other line in that function changes:

```js
// Before
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;

// After
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  // userAgent is accepted and threaded through but intentionally unused
  // beyond this point — Phase 2 (see docs/superpowers/specs/2026-08-02-
  // hebrew-subtitle-source-label-design.md) will gate a per-entry `lang`
  // label on it once real client User-Agent samples are collected.
  void userAgent;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS for the new test, and every pre-existing test still PASS.

- [ ] **Step 5: Wire the real `User-Agent` header through from `server.js`**

In `server.js`, update the configured-subtitles route (`server.js:401`):

```js
// Before
    const result = await subtitlesHandler({ type, id, extra, config });

// After
    const result = await subtitlesHandler({ type, id, extra, config, userAgent: req.headers['user-agent'] });
```

- [ ] **Step 6: Manual verification (requires `DEBUG_MODE=true`)**

Run: `DEBUG_MODE=true node server.js`, then in another terminal:
`curl -s -A "MyTestClient/9.9" http://localhost:7000/Hebrew%20%5Bheb%5D%7CRussian%20%5Brus%5D/subtitles/movie/tt15047880.json > /dev/null`
Expected: server terminal prints a `[server] Client User-Agent: MyTestClient/9.9` line. Stop the server after checking (Ctrl+C).

- [ ] **Step 7: Optional live integration check**

In `scripts/test_hebrew_multisource.js`, update the first call in `testHebrewListing` to pass a `userAgent` so the field is exercised end-to-end against real Wizdom/Ktuvit data, confirming Phase 2's future consumption point won't choke on a real request:

```js
// Before
  const result = await subtitlesHandler({
    type: 'movie',
    id: 'tt15047880',
    extra: {},
    config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' }
  });

// After
  const result = await subtitlesHandler({
    type: 'movie',
    id: 'tt15047880',
    extra: {},
    config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' },
    userAgent: 'ManualIntegrationCheck/1.0'
  });
```

Run: `DEBUG_MODE=true node scripts/test_hebrew_multisource.js` (needs live network + any Ktuvit credentials the script already relies on). Expected: unchanged output vs. before this plan (`HEBREW LISTING SUCCESS` etc.), plus a `Client User-Agent: ManualIntegrationCheck/1.0` line in the output. This step is a manual live-network check, same as the rest of this script — it does not run as part of `npm test`.

- [ ] **Step 8: Commit**

```bash
git add addon.js server.js test.js scripts/test_hebrew_multisource.js
git commit -m "feat: thread and log client User-Agent for future Hebrew source-label gating"
```

---

## After This Plan

Deploy with `DEBUG_MODE=true` and collect real `User-Agent` values from the Windows app, a web browser, the Android phone app, and Android TV via Vercel function logs. Once samples for at least the desktop/web shape(s) exist, write the Phase 2 plan: an allowlist matcher (fail-closed to plain `'heb'` for anything unmatched, per the spec) that sets a source-labeled `lang` only for confirmed-safe clients.
