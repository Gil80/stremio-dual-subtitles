const { generateDynamicSubtitle } = require('./addon');
const { debugServer } = require('./lib/debug');

async function test() {
  debugServer.log = console.log;
  debugServer.warn = console.warn;
  debugServer.error = console.error;
  
  // Try to generate eng+rus for Good Girl's Guide to Murder S1E1
  const srt = await generateDynamicSubtitle(
    'series', '28118211', '1', '1', 'eng', 'rus', 'dummyMain', 'dummyTrans'
  );
  
  if (srt) {
    console.log("SUCCESS! Length:", srt.length);
  } else {
    console.log("FAILED to generate subtitle");
  }
}

test();
