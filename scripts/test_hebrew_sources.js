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
