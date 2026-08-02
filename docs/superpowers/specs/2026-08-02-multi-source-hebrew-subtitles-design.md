# Multi-Source Hebrew Subtitle Candidates — Design

**Date:** 2026-08-02
**Status:** Approved, pending implementation plan

## Problem

The addon currently publishes exactly one dual-subtitle entry per request, chosen by an internal quality-gate algorithm from a single subtitle-source pool (OpenSubtitles primary, with a community-mirror fallback only when primary is missing a requested language). Even "good quality" subtitles can be out of sync with a given release's fps/timing, and the current design gives no way to try an alternative. Two well-regarded Hebrew-specific subtitle addons exist (Wizdom, Ktuvit) that the current pipeline never queries.

## Goal

When Hebrew (`heb`) is one of the two configured languages, list **every** Hebrew subtitle candidate from all available sources as its own picker entry in Stremio, each paired with a single fixed best-ranked candidate for the other configured language. This lets the user try multiple Hebrew tracks per title until they find one that's both good quality and correctly synced. No language pair other than one involving Hebrew is affected — existing behavior for other language pairs (e.g. English+Turkish) is unchanged.

## Source inventory (verified live, 2026-08-02)

Both are public, already-hosted Stremio subtitle addons — no self-hosting or credentials required to query them:

- **Wizdom** — `https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club/subtitles/{type}/{ttId}.json`. Source: wizdom.xyz. Verified against `tt15047880` (Disclosure Day): 9 Hebrew results, `{id, lang: "heb", url}` shape.
- **Ktuvit** — `https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club/subtitles/{type}/{ttId}.json`. Source: ktuvit.me. Verified against `tt15047880`: 3 Hebrew results, same shape. (The `KTUVIT_USER_EMAIL`/hashed-password env vars documented in that repo are only needed to *self-host* your own instance — not required against the public instance.)
- **OpenSubtitles primary** — existing `fetchAllSubtitles` call, unchanged.
- **Mirror fallback** — existing `lib/secondarySource.js`, unchanged trigger condition (see below).

## Priority order

Picker entries appear in this order: **Wizdom → Ktuvit → OpenSubtitles primary → mirror fallback** (only the segment(s) that fired).

## Data flow (`subtitlesHandler` in `addon.js`)

1. Resolve which configured language (`mainLang`/`transLang`) is `heb`; call the other one `fixedLang`. If neither side is `heb`, skip this entire feature — existing single-entry behavior runs unchanged.
2. In parallel: fetch Wizdom Hebrew list, fetch Ktuvit Hebrew list, fetch OpenSubtitles primary (existing call, unchanged).
3. Pick one fixed-best `fixedLang` candidate from the OpenSubtitles primary result via the existing `rankCandidatesForLanguage` (top-ranked by `selfScore`).
4. **Fallback trigger** (mirror, `lib/secondarySource.js`, unchanged module): query it only if, after step 2-3, there are zero Hebrew candidates across Wizdom+Ktuvit+OpenSubtitles, OR zero `fixedLang` candidate from OpenSubtitles primary. If it fires because Hebrew was missing, its Hebrew hits are appended last (after OpenSubtitles-Hebrew, if any). If it fires because `fixedLang` was missing, its result replaces the fixed `fixedLang` pick.
5. Build one picker entry per Hebrew candidate (**no cap** — every release variant from every source gets its own entry), each paired with the single fixed `fixedLang` candidate, in the priority order above.
6. Listing stays CPU-cheap exactly as today: no fetch/parse/merge of actual subtitle content at this stage, only metadata + a deferred `.srt` URL per entry — the merge happens on demand when Stremio requests that specific entry's URL.

## Naming and identity

- `SubtitlesName`: `★ [Wizdom] <release-label>`, `★ [Ktuvit] <release-label>`, `★ [OpenSubtitles] <release-label>` — `<release-label>` is the release filename each source already returns in its `id`/`SubtitlesName`-equivalent field, truncated if very long. Truncation length and exact separator are an implementation detail for the plan, not fixed here.
- Entry `id`: `dual-{source}-{hebSubId}-{fixedLangSubId}` (e.g. `dual-wizdom-350739-abc123`) — stable and distinct per source+variant across requests.

## Locked pairing (behavior change from today)

Today, `generateDynamicSubtitle` can silently swap to a *different* candidate pair than the one encoded in the requested URL if the originally-requested pair fails the internal alignment quality gate (`QUALITY_GATE_THRESHOLD`). That swap-on-failure behavior is **removed** for these Hebrew multi-source entries: the URL for each entry encodes an exact source and subtitle id; on fetch, the addon merges exactly that pair. If parse or merge fails for that exact pair, return nothing (empty subtitle result) rather than substituting a different Hebrew file — the whole point of the feature is letting the user pick a *specific* candidate to test for sync, so silent substitution would defeat it.

The existing quality-gate/try-loop logic (`selectAndMergeBestPair`, `generateCandidatePairs`'s same-`g`-group interleaving) stays exactly as-is for the non-Hebrew legacy path (step 1 above) — untouched.

No "auto/best guess" entry is added on top of the per-source list — dropped per explicit decision; the user picks manually among the listed entries.

## Explicitly out of scope

- No per-source cap on number of variants listed (deliberate — sync issues are release-specific, more options is the point).
- No Ktuvit authentication/env-var setup — querying the public hosted instance needs none.
- No quality/ranking heuristic to auto-pick a "best" Hebrew candidate — no source exposes one; the user's manual trial *is* the mechanism.
- No change to Russian (or any non-Hebrew `fixedLang`) candidate selection beyond the fallback-trigger condition above — it stays a single fixed pick reused across every Hebrew entry.

## Testing

Follow the existing hand-rolled `test(name, fn)` / `assert` pattern in `test.js` (no framework). New coverage needed: Wizdom/Ktuvit fetcher shape parsing, the `heb`-side-detection branch, fallback-trigger condition (zero-Hebrew and zero-fixedLang cases independently), entry ordering, and the locked-pairing failure path (exact-pair-fails → empty result, not a substituted pair). Exact test list is for the implementation plan.
