# Hebrew subtitle source label — Phase 2 (allowlist-gated label)

## Context

Phase 1 (`2026-08-02-hebrew-subtitle-source-label-design.md`) shipped inert
`User-Agent` logging behind `UA_SAMPLING_MODE=true`, specifically to collect
real client samples before risking the `lang`-field trick that could repeat
the Android TV regression this repo already hit once
(`git show cbafce7`). Real samples are now in from Gil's own deployment:

- **Windows desktop app:** `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36
  Edg/150.0.0.0` — a standard Chromium/Edge browser-shaped string.
- **Android phone app:** no `User-Agent` header sent at all (logged as
  `unknown` by Phase 1's `userAgent || 'unknown'` fallback).

Android TV was not independently sampled but shares the same native app
codebase as the Android phone app (per
[stremio-features#1551](https://github.com/Stremio/stremio-features/issues/1551),
which treats "Android" as one behavior class distinct from desktop) — so
it's a reasonable inference, not a confirmed sample, that it also sends no
`User-Agent`. Web was not independently sampled either, but Stremio's web
client is a literal website loaded in a real desktop/laptop browser, so its
`User-Agent` will structurally match the same Chromium/WebKit/Firefox shape
as the confirmed Windows sample — again an inference, not a sample.

Gil explicitly chose to proceed on this evidence rather than wait for
Android TV / Web confirmation, given the fail-closed design makes a wrong
inference here degrade to "no label shown," never to "und"/blank listing.

## Design

### Matcher: structural pattern, not an exact UA pin

Exact-string matching on the sampled UA breaks the next time Chrome/Edge
bumps its version number. Match UA *shape* instead:

**Allow** (desktop/browser-shaped client — eligible for the label) when the
UA contains at least one desktop-OS token (`Windows NT`, `Macintosh`, or
`X11`) **and** at least one browser-engine token (`Chrome/`, `Safari/`, or
`Firefox/`) **and** contains neither `Android` nor `Mobile`.

**Deny** (fall back to plain `lang: mainLang`, today's safe behavior) for
everything else: no `User-Agent` at all (Android phone/TV, per the
confirmed sample), any UA containing `Android` or `Mobile` (defense in
depth, in case a future Android build ever starts sending a UA), and any
unrecognized/empty/future client shape.

A wrong classification can only under-deliver (no label shown) — the
allow-list can never accidentally match Android's actual observed
behavior (a **missing** header simply cannot match a regex requiring
specific tokens to be present).

### Where it lives

New file `lib/clientDetection.js`, a pure/stateless module (no env reads,
no I/O — matches the shape of `lib/sourceSelection.js`):

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

### Consuming it in `buildHebrewMultiSourceResponse`

`addon.js:918` already receives `userAgent` as its final parameter (added
in Phase 1, currently `void userAgent;` at `addon.js:924` — that line is
deleted in Phase 2). Compute the allow/deny decision **once** per response
(same client for every entry in one picker listing), then use it inside the
existing `entries.map` at `addon.js:975-994`:

```js
// Before (addon.js:918-924)
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  // userAgent is accepted and threaded through but intentionally unused
  // beyond this point — Phase 2 ... will gate a per-entry `lang`
  // label on it once real client User-Agent samples are collected.
  void userAgent;

// After
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery, userAgent) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  const showSourceLabel = isDesktopBrowserLikeClient(userAgent);
```

```js
// Before (addon.js:988-993)
    return {
      id: entry.id,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: mainLang,
      SubtitlesName: `★ [${entry.source}] ${entry.label} + ${getLanguageName(fixedLang)}`
    };

// After
    const labelText = `[${entry.source}] ${entry.label} + ${getLanguageName(fixedLang)}`;
    return {
      id: entry.id,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: showSourceLabel ? labelText : mainLang,
      SubtitlesName: `★ ${labelText}`
    };
```

`SubtitlesName` is left in place unchanged in spirit (still computed,
still harmless/ignored by the protocol) — no reason to remove it, it costs
nothing and doesn't conflict with anything.

The non-Hebrew single-pair path (`addon.js:1108`, the `★ Dual (...)` naming)
is untouched — same boundary Phase 1 and the original multi-source design
both held: only the Hebrew multi-source picker path is in scope.

### Data flow

```
Stremio client request
  → server.js route (reads req.headers['user-agent'])   [already wired, Phase 1]
  → subtitlesHandler({ ..., userAgent })                 [already wired, Phase 1]
  → buildHebrewMultiSourceResponse(..., userAgent)        [already wired, Phase 1]
      → isDesktopBrowserLikeClient(userAgent)             [NEW]
      → per-entry: lang = match ? "[source] label + lang" : mainLang
```

### Error handling

- `isDesktopBrowserLikeClient(undefined)` / `(null)` / `('')` all return
  `false` via the leading `if (!userAgent) return false;` guard — no
  exceptions possible.
- No new failure modes: this is a pure string-pattern decision consumed
  synchronously, no I/O, no async.

### Testing

- Unit tests for `lib/clientDetection.js` covering: the exact confirmed
  Windows sample (allow), a representative Android UA string like
  `Mozilla/5.0 (Linux; Android 14; Pixel 8) ... Mobile Safari/537.36`
  (deny, via the `Android`/`Mobile` exclusion), `undefined` (deny), `''`
  (deny), a Firefox-on-Linux desktop shape (allow, to confirm the matcher
  isn't Chrome-only), and a plain `'unknown'` string — the literal
  fallback value Phase 1's logging uses when no header is present — must
  also deny (it contains neither a desktop-OS token nor a browser-engine
  token, so the existing rules already cover it; a test makes that
  explicit and regression-proof).
- Integration-level: extend `scripts/test_hebrew_multisource.js`'s
  Hebrew-listing test to assert that passing the confirmed desktop UA
  string produces `lang` values matching the `[source] label` shape, and
  that passing no `userAgent` (or omitting it) keeps producing plain
  `lang: 'heb'`/`'rus'`/etc. exactly as today — this is the live-network
  regression guard that the plain-`lang` behavior for Android never
  regresses.
- Manual verification: after deploy, confirm on the real Windows client
  that the picker now shows distinguishable Wizdom/Ktuvit/OpenSubtitles/
  mirror rows, and confirm on the real Android phone that the picker still
  shows only "עברית" (no "und", no blank rows) — this second check is the
  one that actually matters most, since it's re-verifying the exact
  failure mode `cbafce7` fixed.

### Out of scope

- Android TV / Web confirmation sampling — proceeding on the inference
  described above per Gil's explicit choice. If either later turns out to
  send a UA that happens to match the allow pattern incorrectly (e.g. an
  Android TV browser-based build reporting a desktop-shaped UA), that
  would be a new bug report, not something this design can pre-empt
  without a real sample.
- Changing the non-Hebrew single-pair naming/labeling.
- Removing `SubtitlesName`.
