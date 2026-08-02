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
    config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' },
    userAgent: 'ManualIntegrationCheck/1.0'
  });

  const subs = result.subtitles || [];
  console.log(`Got ${subs.length} entries`);

  if (subs.length === 0) {
    console.log('FAILED: expected at least one Hebrew multi-source entry');
    process.exit(1);
  }

  // Safety-critical direction: a non-desktop UA must never get a
  // [source]-labeled lang. This is the case that matters most (it's what
  // Android actually sends), and nothing else in this live-network script
  // checked it directly.
  const plainLangViolations = subs.filter(s => /^\[\w+\]/.test(s.lang));
  if (plainLangViolations.length > 0) {
    console.log('FAILED: non-desktop UA got a [source]-labeled lang on:', plainLangViolations.map(s => s.SubtitlesName));
    process.exit(1);
  }

  // Print EVERY entry. The original version of this script only counted
  // wizdom/ktuvit and never looked at the rest, which is exactly how the
  // mislabeled mirror entries shipped unnoticed.
  subs.forEach((s, i) => {
    const idInUrl = decodeURIComponent(s.url.split('/').slice(-2)[0]);
    console.log(`  [${String(i).padStart(2)}] lang=${s.lang} ${s.SubtitlesName}   (mainId=${idInUrl})`);
  });

  // Regression guard for the mislabeling bug: an entry attributed to
  // OpenSubtitles must never carry a mirror (`v3plus-*`) id, and no
  // entry may expose a raw v3plus id as its human-readable label.
  for (const s of subs) {
    const idInUrl = decodeURIComponent(s.url.split('/').slice(-2)[0]);
    if (s.SubtitlesName.includes('[opensubtitles]') && idInUrl.includes('v3plus-')) {
      console.log('FAILED: mirror-sourced entry attributed to opensubtitles:', s.SubtitlesName);
      process.exit(1);
    }
    if (s.SubtitlesName.includes('v3plus-')) {
      console.log('FAILED: raw v3plus id leaked into the entry label:', s.SubtitlesName);
      process.exit(1);
    }
  }

  // Every published id must be re-resolvable: it must carry one of the
  // known source prefixes, matching the prefix in its own label.
  for (const s of subs) {
    const idInUrl = decodeURIComponent(s.url.split('/').slice(-2)[0]);
    const labelSource = s.SubtitlesName.match(/\[(\w+)\]/);
    if (!labelSource) {
      console.log('FAILED: entry has no [source] tag:', s.SubtitlesName);
      process.exit(1);
    }
    if (!idInUrl.startsWith(`${labelSource[1]}:`)) {
      console.log(`FAILED: entry labeled [${labelSource[1]}] but id is "${idInUrl}"`);
      process.exit(1);
    }
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

  const desktopResult = await subtitlesHandler({
    type: 'movie',
    id: 'tt15047880',
    extra: {},
    config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
  });
  const desktopSubs = desktopResult.subtitles || [];
  if (desktopSubs.length === 0) {
    console.log('FAILED: expected at least one entry from the desktop-UA call (got 0, cannot verify labeling)');
    process.exit(1);
  }
  const labeledCount = desktopSubs.filter(s => /^\[\w+\]/.test(s.lang)).length;
  console.log(`Desktop-UA listing: ${labeledCount}/${desktopSubs.length} entries have a [source]-labeled lang`);
  if (labeledCount !== desktopSubs.length) {
    console.log('FAILED: expected every entry to carry a [source]-labeled lang when the UA is desktop-shaped');
    process.exit(1);
  }

  console.log('HEBREW LISTING SUCCESS');
}

async function testMirrorFallbackLiveLabeling() {
  // On tt15047880 Wizdom+Ktuvit both have Hebrew, so the mirror correctly
  // never fires. To exercise the real mirror end-to-end we silence just
  // those two sources (the OpenSubtitles primary and the mirror itself
  // still hit the live network) and confirm the mirror's entries come
  // back attributed to [mirror] with their real release titles — the
  // exact thing that used to render as "[opensubtitles] v3plus-13921081".
  const { _test: { HEB_SOURCES } } = require('../addon');

  const silenced = HEB_SOURCES.filter(s => s.source === 'wizdom' || s.source === 'ktuvit');
  const originals = silenced.map(s => s.fetchRaw);
  silenced.forEach(s => { s.fetchRaw = () => Promise.resolve([]); });

  let subs;
  try {
    const result = await subtitlesHandler({
      type: 'movie',
      id: 'tt15047880',
      extra: {},
      config: { mainLang: 'Hebrew [heb]', transLang: 'Russian [rus]' }
    });
    subs = result.subtitles || [];
  } finally {
    silenced.forEach((s, i) => { s.fetchRaw = originals[i]; });
  }

  console.log(`Mirror-fallback live: got ${subs.length} entries`);
  subs.slice(0, 12).forEach((s, i) => {
    const idInUrl = decodeURIComponent(s.url.split('/').slice(-2)[0]);
    console.log(`  [${String(i).padStart(2)}] ${s.SubtitlesName}   (mainId=${idInUrl})`);
  });

  if (subs.length === 0) {
    console.log('FAILED: expected mirror Hebrew entries when Wizdom/Ktuvit are silenced');
    process.exit(1);
  }

  const mirrorEntries = subs.filter(s => s.SubtitlesName.includes('[mirror]'));
  if (mirrorEntries.length === 0) {
    console.log('FAILED: no [mirror]-attributed entries — mirror fallback did not fire');
    process.exit(1);
  }
  for (const s of mirrorEntries) {
    const idInUrl = decodeURIComponent(s.url.split('/').slice(-2)[0]);
    if (!idInUrl.startsWith('mirror:')) {
      console.log('FAILED: [mirror] entry without a mirror: id:', idInUrl);
      process.exit(1);
    }
    if (s.SubtitlesName.includes('v3plus-')) {
      console.log('FAILED: raw v3plus id used as label:', s.SubtitlesName);
      process.exit(1);
    }
  }

  // Round-trip: a published mirror entry must be re-resolvable through
  // the same registry row that produced it (no listing/re-resolution
  // drift, no collision with an opensubtitles: id).
  const m = mirrorEntries[0].url.match(/\/subs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.srt/);
  if (!m) {
    console.log('FAILED: could not parse mirror entry URL', mirrorEntries[0].url);
    process.exit(1);
  }
  const [, mType, mImdb, mSeason, mEpisode, mMainLang, mTransLang, mMainId, mTransId] = m;
  const srt = await generateDynamicSubtitle(
    mType, mImdb, mSeason, mEpisode, mMainLang, mTransLang,
    decodeURIComponent(mMainId), decodeURIComponent(mTransId)
  );
  if (!srt) {
    console.log('FAILED: mirror-sourced locked pair did not re-resolve to merged content');
    process.exit(1);
  }

  console.log(`MIRROR FALLBACK LABELING SUCCESS (${mirrorEntries.length} mirror entries, locked re-fetch ${srt.length} chars)`);
}

async function testHebrewAsTransLangSlotOrder() {
  // Same title, but Hebrew configured as the SECONDARY language. Russian
  // must then occupy the main/bold slot in the generated URL — Hebrew must
  // not be force-promoted to main.
  const result = await subtitlesHandler({
    type: 'movie',
    id: 'tt15047880',
    extra: {},
    config: { mainLang: 'Russian [rus]', transLang: 'Hebrew [heb]' }
  });

  const subs = result.subtitles || [];
  console.log(`Hebrew-as-transLang: got ${subs.length} entries`);
  if (subs.length === 0) {
    console.log('FAILED: expected at least one entry with Hebrew as transLang');
    process.exit(1);
  }

  const m = subs[0].url.match(/\/subs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.srt/);
  if (!m) {
    console.log('FAILED: could not parse dynamic URL', subs[0].url);
    process.exit(1);
  }
  const [, , , , , urlMainLang, urlTransLang, mainId, transId] = m;
  console.log(`  slots: main=${urlMainLang}(${decodeURIComponent(mainId)}) trans=${urlTransLang}(${decodeURIComponent(transId)}) entryLang=${subs[0].lang}`);

  if (urlMainLang !== 'rus' || urlTransLang !== 'heb') {
    console.log(`FAILED: expected main=rus trans=heb, got main=${urlMainLang} trans=${urlTransLang}`);
    process.exit(1);
  }
  if (decodeURIComponent(transId).startsWith('opensubtitles:') === true &&
      decodeURIComponent(mainId).startsWith('opensubtitles:') === false) {
    console.log('FAILED: Hebrew candidate landed in the main slot');
    process.exit(1);
  }
  if (subs[0].lang !== 'rus') {
    console.log(`FAILED: published entry lang should follow the main slot, got ${subs[0].lang}`);
    process.exit(1);
  }

  console.log('HEBREW-AS-TRANSLANG SLOT ORDER SUCCESS');
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

testHebrewListing()
  .then(testMirrorFallbackLiveLabeling)
  .then(testHebrewAsTransLangSlotOrder)
  .then(testNonHebrewRegression)
  .then(testLockedPairFetch);
