# Hebrew subtitle source label + manifest name cleanup

## Problem

Real-device testing (Windows Stremio client, screenshot) showed the Hebrew
multi-source picker list (`2026-08-02-multi-source-hebrew-subtitles-design.md`)
does not work as intended in the actual Stremio UI:

1. Every Hebrew entry in the subtitle picker looks identical — "עברית" /
   "Dual Subtitles (HEB+R...)" repeated for each row, with no way to tell
   which entry came from Wizdom, Ktuvit, OpenSubtitles, or the mirror.
2. The addon's per-config display name ("Dual Subtitles (HEB+RUS)") is
   redundant once the language pair is visible — "HEB+RUS" already says
   it's dual.

## Root cause

The Stremio subtitle object only supports three fields per the official
protocol: `id`, `url`, `lang` (confirmed against
`stremio-addon-sdk/docs/api/responses/subtitles.md`). There is no per-entry
display-name field. The addon currently sets a custom `SubtitlesName` field
(`addon.js:983`, `addon.js:1098`) — this is not part of the protocol and is
silently dropped by the Stremio client. What the user actually sees per row
is the language name derived from `lang` ("עברית") plus the addon's
manifest `name`, which is the same for every entry from this addon
(`server.js:365`).

An undocumented but widely-used workaround exists: if `lang` is not a
recognized ISO 639-2 code, desktop/web Stremio clients render its literal
text. Confirmed via Stremio's own tracker
([stremio-features#1551](https://github.com/Stremio/stremio-features/issues/1551)):
native Android (phone and TV — one shared app) does **not** honor this and
falls back to displaying "und" for any unrecognized `lang` value. There is
no public documentation of the exact `User-Agent` strings Stremio's four
client shapes (Windows app, Web, Android phone, Android TV) send on addon
requests, so a platform check cannot be hardcoded from research alone — it
must be confirmed from real request logs.

## Design

### Part 1 — drop redundant wording from manifest name

`server.js:365` currently builds the per-config manifest name as:

```js
name: `${manifest.name} (${mainCode.toUpperCase()}+${transCode.toUpperCase()})`
```

producing "Dual Subtitles (HEB+RUS)". Change to:

```js
name: `${mainCode.toUpperCase()}+${transCode.toUpperCase()}`
```

producing "HEB+RUS". No platform risk — this is a plain manifest field,
rendered identically everywhere. Ships immediately.

### Part 2 — phased, fail-closed source label via `lang`

Because Android (phone + TV) breaks on non-standard `lang` text and we
cannot yet distinguish it from Web/Windows via a verified `User-Agent`
pattern, the fix ships in two phases. The guiding rule: unmatched or
unknown clients always get today's safe behavior (`lang: 'heb'`), never the
enhancement. A wrong guess must be able to only under-deliver (no label),
never break (show "und").

**Phase 1 — instrumentation only, no behavior change**

- `server.js:381` (the `/:config/subtitles/:type/:id/:extra?.json` route)
  reads `req.headers['user-agent']` and passes it through to
  `subtitlesHandler({ type, id, extra, config, userAgent })`.
- `subtitlesHandler` (`addon.js:993`) threads `userAgent` into
  `buildHebrewMultiSourceResponse`.
- `buildHebrewMultiSourceResponse` (`addon.js:914`) logs the raw UA once
  per request via `debugServer.log`, but continues to always emit
  `lang: mainLang` (i.e. `'heb'` when Hebrew is one side) exactly as today.
  No entry's `lang` changes yet.
- Deployed as-is. Real-world usage across your Windows app, a browser tab
  on web.stremio.com, the Android phone app, and Android TV populates the
  Vercel function logs with real UA strings per platform.

**Phase 2 — allowlist-gated label (separate follow-up, after log review)**

- Once Phase 1 logs show the real UA strings for at least the
  Windows/Web client shape(s), add a small allowlist matcher (e.g.
  `lib/clientDetection.js`) that returns `true` only for UAs matching those
  confirmed patterns.
- In `buildHebrewMultiSourceResponse`, when the matcher returns `true` for
  the current request's UA, set each entry's `lang` to a short label
  encoding the source, e.g. `[Wizdom] <release-label>` (reusing the text
  already computed for `SubtitlesName` at `addon.js:983`). When it returns
  `false` — including Android phone, Android TV, missing UA, or any UA not
  seen in Phase 1 logs — `lang` stays plain `'heb'`.
- `SubtitlesName` stays in the response (harmless, ignored by clients) or
  gets removed as dead weight — decide during Phase 2 implementation.

### Data flow (Phase 1)

```
Stremio client request
  → server.js:381 route (reads req.headers['user-agent'])
  → subtitlesHandler({ type, id, extra, config, userAgent })   [addon.js:993]
  → buildHebrewMultiSourceResponse(..., userAgent)             [addon.js:914]
      → debugServer.log(userAgent)   (Phase 1: log only, no behavior change)
```

### Error handling

- Missing/empty `User-Agent` header: treated as "no match" in Phase 2,
  falls back to plain `'heb'`. Never throws.
- Phase 1 adds a parameter and a log line only — no new failure modes.

### Testing

- Phase 1: unit-testable that `userAgent` is threaded through and logged;
  no behavior assertion changes needed since `lang` output is unchanged.
  Manual verification: after deploy, trigger a request from each platform
  you have access to and confirm the UA shows up in Vercel logs.
- Phase 2: unit tests for the allowlist matcher (confirmed-UA → true,
  everything else → false, including empty string and Android samples
  once known). Manual re-verification on Windows app required before
  calling Phase 2 done; Android verification required before calling it
  safe (confirm still shows "עברית", not "und").

### Out of scope

- Changing the underlying Hebrew multi-source selection/ranking logic
  (`2026-08-02-multi-source-hebrew-subtitles-design.md` — unaffected).
- Removing `SubtitlesName` in Phase 1 (left as-is; revisited in Phase 2).
- Any UA pattern matching for Phase 2 — deferred until real log data
  exists.
