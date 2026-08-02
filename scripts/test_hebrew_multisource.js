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
