/**
 * Stremio Dual Subtitles Addon
 * Fetches subtitles from OpenSubtitles and merges two languages into one file.
 * Perfect for language learners who want to see both original and translation.
 */

const path = require('path');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const pako = require('pako');
const sanitize = require('sanitize-html');
const { debugServer, sanitizeForLogging } = require('./lib/debug');
/**
 * Simple SRT parser (more reliable than external libraries)
 */
function parseTimestampLine(line) {
  if (!line || typeof line !== 'string') return null;
  if (!line.includes('-->')) return null;

  const timePattern = '(\\d{1,2}:\\d{2}:\\d{2}[,.]\\d{1,3})';
  const match = line.match(new RegExp(`^\\s*${timePattern}\\s*-->\\s*${timePattern}`));
  if (!match) return null;

  const startMs = parseTimeToMs(match[1]);
  const endMs = parseTimeToMs(match[2]);

  return {
    startTime: msToSrtTime(startMs),
    endTime: msToSrtTime(endMs)
  };
}

function parseSrtSimple(srtText) {
  const lines = srtText.trim().split('\n');
  const subtitles = [];
  let current = null;
  let pendingId = null;

  function pushCurrent() {
    if (
      current &&
      current.startTime &&
      current.endTime &&
      typeof current.text === 'string' &&
      current.text.trim()
    ) {
      subtitles.push(current);
    }
    current = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const timing = parseTimestampLine(line);

    // Empty line => cue boundary
    if (!line) {
      pushCurrent();
      pendingId = null;
      continue;
    }

    // Timestamp line starts a new cue
    if (timing) {
      pushCurrent();
      current = {
        id: pendingId || String(subtitles.length + 1),
        startTime: timing.startTime,
        endTime: timing.endTime,
        text: ''
      };
      pendingId = null;
      continue;
    }

    // Cue IDs are optional in the wild. If the *next* line is a
    // timestamp, treat the current line as the cue id (even if it's not
    // numeric, e.g. VTT named IDs).
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (parseTimestampLine(nextLine)) {
      if (current) pushCurrent();
      pendingId = line;
      continue;
    }

    // Ignore preamble/garbage until a cue is started.
    if (!current) continue;

    // Otherwise it's text
    if (current.text) current.text += '\n';
    current.text += line;
  }

  // Add last subtitle if exists
  pushCurrent();

  return subtitles;
}

/**
 * Simple SRT formatter
 */
function formatSrtSimple(subtitles) {
  const lines = [];
  
  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i];
    lines.push(String(i + 1));
    lines.push(`${sub.startTime} --> ${sub.endTime}`);
    lines.push(sub.text);
    lines.push('');
  }
  
  return lines.join('\n');
}

const { decodeSubtitleBuffer, isCjkLanguage } = require('./encoding');
const {
  getLanguageOptions,
  extractBrowserLanguage,
  parseLangCode,
  getLanguageName
} = require('./languages');
const { alignAndMatch } = require('./lib/syncEngine');
const { generateCandidatePairs, rankCandidatesForLanguage, buildHebrewEntries } = require('./lib/sourceSelection');

// Optional video-matching parameters (forwarded from Stremio extras).
// These help OpenSubtitles pick the right release variant for the exact
// video file the user is playing.
const VIDEO_PARAM_KEYS = ['filename', 'videoSize', 'videoHash'];

function normalizeVideoParams(params = {}) {
  const normalized = {};
  if (!params || typeof params !== 'object') return normalized;

  for (const key of VIDEO_PARAM_KEYS) {
    let value = params[key];
    if (Array.isArray(value)) value = value[0];
    if (value == null) continue;

    const s = String(value).trim();
    if (!s) continue;
    normalized[key] = s;
  }
  return normalized;
}

function serializeVideoParams(params = {}) {
  const normalized = normalizeVideoParams(params);
  const search = new URLSearchParams();
  for (const key of VIDEO_PARAM_KEYS) {
    if (normalized[key]) search.set(key, normalized[key]);
  }
  return search.toString();
}

// Match rate at or above this is considered "good enough" — we stop
// trying further candidate pairs. Empirically high-quality matches land
// 90-99%, decent ones 80-90%, mismatched ones 45-70%. We pick 0.85 so
// the gate trusts a clearly-high pair (1 attempt) but still spends a
// second fetch to triangulate when the first is only "okay".
const QUALITY_GATE_THRESHOLD = 0.85;
// Hard cap on how many pairs we'll fetch+merge before giving up. Three
// is enough to cover (best same-group, zipped-popularity, runner-up)
// while keeping the serverless cold path bounded.
const MAX_PAIR_ATTEMPTS = 3;

// Configuration
const ADDON_NAME = process.env.ADDON_NAME || 'Dual Subtitles';
const ADDON_VERSION = '1.0.0';

function buildConfiguredManifestName(mainCode, transCode) {
  return `${mainCode.toUpperCase()}+${transCode.toUpperCase()}`;
}



// Create addon manifest
const manifest = {
  id: 'community.dualsubtitles',
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: 'Watch movies and series with dual subtitles - see two languages simultaneously for better language learning!',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: '/logo.png',
  behaviorHints: {
    configurable: true,
    configurationRequired: true
  },
  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..0dhMmLAGB8GgrgR0k_QVag.QvSVlwg-SctRXOgQgdIhydZx55LSndygGe4uCb2VrwGzHfQm5hyH0j3BxQOMrMZWuBxFkMkVYt9QF4jNx6yyffbx1ub8KJCjnKl9SfBCkI9aFk9RrD7T0FbuPurxIbrd.OH-8gvJWWzw6O7QtreVs_w'
  },
  config: [
    {
      key: 'mainLang',
      type: 'select',
      title: 'Primary Language (Audio/Learning Language)',
      options: getLanguageOptions(),
      required: true,
      default: 'English [eng]'
    },
    {
      key: 'transLang',
      type: 'select',
      title: 'Secondary Language (Your Native Language)',
      options: getLanguageOptions(),
      required: true,
      default: 'Turkish [tur]'
    }
  ]
};

const builder = new addonBuilder(manifest);

async function fetchWithRetry(url, options = {}, retries = 2, backoffMs = 500) {
  try {
    return await axios.get(url, options);
  } catch (error) {
    const status = error && error.response ? error.response.status : null;
    if (retries > 0 && (status === 429 || status === 469 || status === 503 || status === 504)) {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return fetchWithRetry(url, options, retries - 1, backoffMs * 2);
    }
    throw error;
  }
}

/**
 * Fetch subtitles from the OpenSubtitles primary index ONLY.
 *
 * Deliberately has NO mirror fallback: callers that want the mirror must
 * ask for it explicitly so they stay in control of the trigger condition
 * and of how mirror-sourced entries get attributed. `fetchAllSubtitles`
 * below wraps this with the legacy implicit fallback for the non-Hebrew
 * path; the Hebrew multi-source path calls this one directly.
 *
 * @returns {Promise<Array>} raw entries (possibly empty), never null
 */
async function fetchOpenSubtitlesPrimary(imdbId, type, season = null, episode = null, videoParams = {}) {
  let apiUrl = `https://opensubtitles-v3.strem.io/subtitles/${type}/tt${imdbId}`;

  if (type === 'series' && season && episode) {
    apiUrl += `:${season}:${episode}`;
  }

  // Add query params for better matching
  const queryParams = [];
  const normalizedVideoParams = normalizeVideoParams(videoParams);
  if (normalizedVideoParams.filename) {
    queryParams.push(`filename=${encodeURIComponent(normalizedVideoParams.filename)}`);
  }
  if (normalizedVideoParams.videoSize) queryParams.push(`videoSize=${normalizedVideoParams.videoSize}`);
  if (normalizedVideoParams.videoHash) queryParams.push(`videoHash=${normalizedVideoParams.videoHash}`);

  if (queryParams.length > 0) {
    apiUrl += `/${queryParams.join('&')}`;
  }

  apiUrl += '.json';

  let primarySubs = [];
  try {
    const response = await fetchWithRetry(apiUrl, { timeout: 15000 });
    if (response.data && Array.isArray(response.data.subtitles)) {
      primarySubs = response.data.subtitles;
    }
  } catch (error) {
    debugServer.error('Error fetching subtitles:', sanitizeForLogging(error.message));
  }

  return primarySubs;
}

/**
 * Fetch all subtitles for a title: OpenSubtitles primary, plus the
 * community mirror if primary is missing coverage for a needed language.
 *
 * NOTE: this wrapper has an IMPLICIT mirror fallback. Mirror entries are
 * concatenated into the returned list with `v3plus-*` ids and no source
 * tag, so callers that care about per-source attribution must NOT use
 * this — use `fetchOpenSubtitlesPrimary` plus an explicit mirror call.
 * Kept as-is for the legacy (non-Hebrew) single-best-pair path.
 */
async function fetchAllSubtitles(imdbId, type, season = null, episode = null, videoParams = {}, mainLang = null, transLang = null) {
  const primarySubs = await fetchOpenSubtitlesPrimary(imdbId, type, season, episode, videoParams);

  // Fallback: only hit the secondary mirror if the primary source is
  // missing coverage for a language we actually need. Keeps the
  // already-working path (most titles) at one network call.
  const missingMain = mainLang && !primarySubs.some(s => s.lang === mainLang);
  const missingTrans = transLang && !primarySubs.some(s => s.lang === transLang);

  let secondarySubs = [];
  if (missingMain || missingTrans) {
    const { fetchSecondarySubtitles } = require('./lib/secondarySource');
    debugServer.log(`Primary source missing coverage (main=${missingMain}, trans=${missingTrans}), trying secondary source`);
    secondarySubs = await fetchSecondarySubtitles(imdbId, type, mainLang, transLang);
    if (secondarySubs.length > 0) {
      debugServer.log(`Secondary source added ${secondarySubs.length} subtitle(s)`);
    }
  }

  const combined = primarySubs.concat(secondarySubs);
  return combined.length > 0 ? combined : null;
}

/**
 * Fetch and decode subtitle content from URL.
 */
async function fetchSubtitleContent(url, languageCode = null) {
  try {
    const response = await fetchWithRetry(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024 // 5MB limit
    });

    // Skip forced subtitles — they only contain signs/songs, not full dialogue
    const disposition = response.headers && response.headers['content-disposition'];
    if (disposition && disposition.toLowerCase().includes('forced')) {
      return null;
    }

    let buffer = Buffer.from(response.data);

    // Handle gzip compressed files
    if (url.endsWith('.gz') || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
      try {
        buffer = Buffer.from(pako.ungzip(buffer));
      } catch (e) {
        debugServer.error('Error decompressing gzip:', sanitizeForLogging(e.message));
        return null;
      }
    }

    const text = decodeSubtitleBuffer(buffer, languageCode);
    return text;
  } catch (error) {
    debugServer.error('Error fetching subtitle:', sanitizeForLogging(error.message));
    return null;
  }
}

/**
 * Parse SRT/VTT time format to milliseconds.
 * Accepts both comma (SRT: 00:01:23,456) and period (VTT: 00:01:23.456) separators.
 */
function parseTimeToMs(timeString) {
  if (!timeString) return 0;

  const match = timeString.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const ms = match[4].padEnd(3, '0');
  const milliseconds = parseInt(ms, 10);
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
}

/**
 * Normalize VTT content to SRT-compatible format.
 * Strips WEBVTT header, style blocks, and adds numeric cue IDs if missing.
 */
function normalizeVttToSrt(text) {
  const lines = text.split('\n');
  const output = [];
  let cueIndex = 0;
  let inHeader = true;
  let inStyleBlock = false;
  let expectTimestamp = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (inHeader) {
      if (line === '' || line.startsWith('WEBVTT') || line.startsWith('Kind:') ||
          line.startsWith('Language:') || line.startsWith('NOTE')) {
        continue;
      }
      inHeader = false;
    }

    if (line.startsWith('STYLE') || line.startsWith('::cue')) {
      inStyleBlock = true;
      continue;
    }
    if (inStyleBlock) {
      if (line === '') inStyleBlock = false;
      continue;
    }

    if (line.includes('-->')) {
      cueIndex++;
      const normalized = line.replace(/\./g, ',');
      output.push('');
      output.push(String(cueIndex));
      output.push(normalized);
      expectTimestamp = false;
      continue;
    }

    // Skip VTT numeric cue identifiers (a number line right before a timestamp)
    if (/^\d+$/.test(line) && i + 1 < lines.length && lines[i + 1].includes('-->')) {
      continue;
    }

    output.push(line);
    expectTimestamp = false;
  }

  return output.join('\n');
}

/**
 * Parse SRT text into subtitle objects. Also handles VTT input.
 */
function parseSrt(srtText) {
  if (!srtText || typeof srtText !== 'string') return null;

  try {
    // Normalize line endings
    srtText = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Remove BOM if present
    if (srtText.charCodeAt(0) === 0xFEFF) {
      srtText = srtText.substring(1);
    }

    // Detect and convert VTT format
    const trimmed = srtText.trimStart();
    if (trimmed.startsWith('WEBVTT')) {
      srtText = normalizeVttToSrt(srtText);
    }
    
    // Normalize period-separated timestamps to comma-separated for the parser
    srtText = srtText.replace(
      /(\d{1,2}:\d{2}:\d{2})\.(\d{1,3})/g,
      '$1,$2'
    );
    
    // Use simple parser
    const parsed = parseSrtSimple(srtText);
    
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    // Filter out ads
    const adKeywords = ['OpenSubtitles.org', 'OpenSubtitles.com', 'osdb.link', 'Advertise your', 'OpenSubtitles v3+'];
    const filtered = parsed.filter(sub => 
      !adKeywords.some(keyword => (sub.text || '').includes(keyword))
    );

    return filtered;
  } catch (error) {
    debugServer.error('Error parsing SRT:', sanitizeForLogging(error.message));
    return null;
  }
}

/**
 * Convert milliseconds to SRT time format.
 */
function msToSrtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

/**
 * Join multi-line subtitle text into a single line.
 * For CJK languages, joins without spaces to avoid breaking character flow.
 */
function joinSubtitleLines(text, langCode) {
  if (!text) return '';
  const cjk = isCjkLanguage(langCode);
  return text.replace(/\r?\n|\r/g, cjk ? '' : ' ').trim();
}

/** Escape text embedded in SRT HTML tags (avoid breaking markup / injection). */
function htmlEncodeSrt(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Muted color for secondary line; players that ignore <font> still have <b> + › marker. */
const DUAL_SUB_TRANS_COLOR = '#94a3b8';

/**
 * Merge two subtitle arrays into one, aligning the secondary track to the
 * primary track's timebase before matching.
 *
 * The actual alignment work (global offset detection via cross-correlation,
 * affine drift correction, and overlap-based bipartite assignment) is in
 * lib/syncEngine.js. This function is a thin wrapper that converts SRT
 * timestamp strings to milliseconds, runs the engine, and renders the
 * dual-line SRT text.
 *
 * @param {Array} mainSubs - Primary language subtitles (SRT-time strings)
 * @param {Array} transSubs - Translation language subtitles (SRT-time strings)
 * @param {Object|number} options - Merge options (number = legacy threshold)
 * @param {string|null} [options.mainLang]  - For CJK-aware line joining
 * @param {string|null} [options.transLang] - For CJK-aware line joining
 * @param {number}      [options.matchThresholdMs=1500]
 * @param {boolean}     [options.allowMultiTrans=true]
 *        If true, several short trans cues may be concatenated into one
 *        primary cue (handles cue-boundary mismatches).
 * @param {boolean}     [options.enableOffset=true]
 * @param {boolean}     [options.enableDrift=true]
 */
function mergeSubtitles(mainSubs, transSubs, options = {}) {
  const opts = typeof options === 'number'
    ? { matchThresholdMs: Math.max(options, 1500) }
    : options;

  const {
    mainLang = null,
    transLang = null,
    matchThresholdMs = 1500,
    allowMultiTrans = true,
    enableOffset = true,
    enableDrift = true
  } = opts;

  const mainTimed = [];
  for (const s of mainSubs || []) {
    if (!s || !s.startTime || !s.endTime) continue;
    const startMs = parseTimeToMs(s.startTime);
    const endMs = parseTimeToMs(s.endTime);
    if (endMs <= startMs) continue;
    mainTimed.push({ ...s, startMs, endMs });
  }

  const transTimed = [];
  for (const s of transSubs || []) {
    if (!s || !s.startTime || !s.endTime) continue;
    const startMs = parseTimeToMs(s.startTime);
    const endMs = parseTimeToMs(s.endTime);
    if (endMs <= startMs) continue;
    transTimed.push({ ...s, startMs, endMs });
  }

  const alignment = alignAndMatch(mainTimed, transTimed, {
    enableOffset,
    enableDrift,
    matchThreshold: matchThresholdMs,
    allowMultiTrans,
    log: msg => debugServer.log(sanitizeForLogging(msg))
  });
  const { matches } = alignment;

  const transJoiner = isCjkLanguage(transLang) ? '' : ' ';
  const mergedSubs = [];

  for (let mi = 0; mi < mainTimed.length; mi++) {
    const mainSub = mainTimed[mi];

    const cleanMainText = joinSubtitleLines(
      sanitize(mainSub.text, { allowedTags: [], allowedAttributes: {} }),
      mainLang
    );
    if (!cleanMainText) continue;

    let mergedText;
    const transIdxs = matches.get(mi);
    if (transIdxs && transIdxs.length > 0) {
      const transParts = [];
      for (const ti of transIdxs) {
        const t = transTimed[ti];
        if (!t) continue;
        const piece = joinSubtitleLines(
          sanitize(t.text, { allowedTags: [], allowedAttributes: {} }),
          transLang
        );
        if (piece) transParts.push(piece);
      }
      if (transParts.length > 0) {
        const cleanTransText = transParts.join(transJoiner);
        const encMain = htmlEncodeSrt(cleanMainText);
        const encTrans = htmlEncodeSrt(cleanTransText);
        mergedText =
          `<b>${encMain}</b>\n\u203a <i><font color="${DUAL_SUB_TRANS_COLOR}">${encTrans}</font></i>`;
      }
    }

    if (mergedText === undefined) {
      mergedText = `<b>${htmlEncodeSrt(cleanMainText)}</b>`;
    }

    if (!mergedText) continue;

    mergedSubs.push({
      id: mainSub.id,
      startTime: mainSub.startTime,
      endTime: mainSub.endTime,
      text: mergedText
    });
  }

  // Backwards compatible: callers that used `mergeSubtitles` as a plain
  // array still iterate / .length / spread it as before. Quality-gate
  // callers can read alignment metrics from non-enumerable properties.
  Object.defineProperty(mergedSubs, 'matchRate', {
    value: alignment.matchRate || 0,
    enumerable: false
  });
  Object.defineProperty(mergedSubs, 'alignment', {
    value: {
      offsetMs: alignment.offsetMs,
      drift: alignment.drift,
      localAnchors: alignment.localAnchors,
      matchedCount: matches.size,
      mainCount: mainTimed.length
    },
    enumerable: false
  });
  return mergedSubs;
}

/**
 * Format subtitle array back to SRT string.
 */
function formatSrt(subtitleArray) {
  if (!Array.isArray(subtitleArray)) return null;

  try {
    return formatSrtSimple(subtitleArray);
  } catch (error) {
    debugServer.error('Error formatting SRT:', sanitizeForLogging(error.message));
    return null;
  }
}

// In-memory cache for merged subtitles
const subtitleCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Store subtitle in cache and return data URL.
 */
function storeSubtitle(key, srtContent) {
  // Clean old entries
  const now = Date.now();
  for (const [k, v] of subtitleCache.entries()) {
    if (now - v.timestamp > CACHE_TTL) {
      subtitleCache.delete(k);
    }
  }

  subtitleCache.set(key, {
    content: srtContent,
    timestamp: now
  });

  return key;
}

/**
 * Get subtitle from cache.
 */
function getSubtitle(key) {
  const entry = subtitleCache.get(key);
  if (!entry) return null;
  
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    subtitleCache.delete(key);
    return null;
  }
  
  return entry.content;
}

/**
 * Try candidate (main, trans) pairs in order. For each pair, fetch both
 * subtitle files, parse them, and run mergeSubtitles. The first pair whose
 * match rate clears QUALITY_GATE_THRESHOLD wins; otherwise we return the
 * best pair we saw, capped at MAX_PAIR_ATTEMPTS.
 *
 * Each fetched subtitle is cached in `parsedCache` so retrying with the
 * same main against a different trans (or vice versa) doesn't re-download.
 *
 * @param {Array} candidatePairs    output of generateCandidatePairs
 * @param {string} mainLang
 * @param {string} transLang
 * @returns {Promise<{
 *   merged: Array, mergedSrt: string, matchRate: number,
 *   mainSub: object, transSub: object, attempts: number,
 *   passedGate: boolean
 * } | null>}
 */
async function selectAndMergeBestPair(candidatePairs, mainLang, transLang) {
  if (!Array.isArray(candidatePairs) || candidatePairs.length === 0) return null;

  const parsedCache = new Map();
  async function getParsed(sub, lang) {
    if (parsedCache.has(sub.id)) return parsedCache.get(sub.id);
    const content = await fetchSubtitleContent(sub.url, lang);
    const parsed = content ? parseSrt(content) : null;
    parsedCache.set(sub.id, parsed);
    return parsed;
  }

  let best = null;
  const attempts = Math.min(candidatePairs.length, MAX_PAIR_ATTEMPTS);

  for (let i = 0; i < attempts; i++) {
    const pair = candidatePairs[i];
    debugServer.log(
      `Pair attempt ${i + 1}/${attempts}: main=${pair.main.id} trans=${pair.trans.id} ` +
      `source=${pair.source} sameGroup=${pair.sameGroup} g=${pair.group}`
    );

    const [mainParsed, transParsed] = await Promise.all([
      getParsed(pair.main, mainLang),
      getParsed(pair.trans, transLang)
    ]);
    if (!mainParsed || mainParsed.length === 0) {
      debugServer.warn(`  main subtitle ${pair.main.id} unparsable, skipping`);
      continue;
    }
    if (!transParsed || transParsed.length === 0) {
      debugServer.warn(`  trans subtitle ${pair.trans.id} unparsable, skipping`);
      continue;
    }

    const merged = mergeSubtitles(mainParsed, transParsed, { mainLang, transLang });
    const matchRate = merged && merged.matchRate != null ? merged.matchRate : 0;
    debugServer.log(`  match rate: ${(matchRate * 100).toFixed(1)}%`);

    if (!best || matchRate > best.matchRate) {
      best = {
        merged,
        mergedSrt: merged && merged.length > 0 ? formatSrt(merged) : null,
        matchRate,
        mainSub: pair.main,
        transSub: pair.trans,
        attempts: i + 1,
        passedGate: matchRate >= QUALITY_GATE_THRESHOLD
      };
    }
    if (matchRate >= QUALITY_GATE_THRESHOLD) {
      debugServer.log(`  passed quality gate, stopping`);
      break;
    }
  }

  if (best) {
    debugServer.log(
      `Selected pair: main=${best.mainSub.id} trans=${best.transSub.id} ` +
      `matchRate=${(best.matchRate * 100).toFixed(1)}% attempts=${best.attempts} ` +
      `passedGate=${best.passedGate}`
    );
  }
  return best;
}

// ============================================================================
// Hebrew multi-source registry
// ============================================================================

/**
 * SINGLE SOURCE OF TRUTH for the Hebrew multi-source picker.
 *
 * Each row ties together the three things that used to be written out
 * independently in four places (listing code, re-resolution dispatch, the
 * prefix list, and the source-group array): the source name, the id
 * prefix its candidates carry, the network call that fetches its raw
 * list, and the pure selector that turns that raw list into normalized
 * `{id, url, lang, source, label}` candidates for one language.
 *
 * Rows are in picker priority order. `fallbackOnly` rows are never
 * queried during a normal listing — see `buildHebrewMultiSourceResponse`
 * for the trigger condition.
 *
 * Because the listing path and `fetchLockedCandidate` both build ids
 * through the same `candidatesForLang`, a published entry id can always
 * be re-resolved by exactly one row and can never be mis-attributed.
 */
const HEB_SOURCES = [
  {
    source: 'wizdom',
    fallbackOnly: false,
    // Already returns normalized `wizdom:`-prefixed heb-only candidates.
    fetchRaw: ctx => {
      const { fetchWizdomSubtitles } = require('./lib/hebrewSources');
      return fetchWizdomSubtitles(ctx.imdbId, ctx.type, ctx.season, ctx.episode);
    },
    candidatesForLang: (raw, lang) => (raw || []).filter(c => c.lang === lang)
  },
  {
    source: 'ktuvit',
    fallbackOnly: false,
    fetchRaw: ctx => {
      const { fetchKtuvitSubtitles } = require('./lib/hebrewSources');
      return fetchKtuvitSubtitles(ctx.imdbId, ctx.type, ctx.season, ctx.episode);
    },
    candidatesForLang: (raw, lang) => (raw || []).filter(c => c.lang === lang)
  },
  {
    source: 'opensubtitles',
    fallbackOnly: false,
    // Primary index ONLY — deliberately not `fetchAllSubtitles`, whose
    // implicit mirror fallback would smuggle `v3plus-*` mirror entries in
    // here and get them stamped `source: 'opensubtitles'`.
    fetchRaw: ctx =>
      fetchOpenSubtitlesPrimary(ctx.imdbId, ctx.type, ctx.season, ctx.episode, ctx.videoParams),
    candidatesForLang: (raw, lang) =>
      rankCandidatesForLanguage(raw || [], lang).map(s => ({
        id: `opensubtitles:${s.id}`,
        url: s.url,
        lang,
        source: 'opensubtitles',
        // The v3 index exposes no release name, so the numeric id is the
        // only label available.
        label: String(s.id)
      }))
  },
  {
    source: 'mirror',
    fallbackOnly: true,
    // Always queried with (heb, fixedLang) in that order so the listing
    // and the later re-resolution hit the identical URL and therefore
    // see the identical id set.
    fetchRaw: ctx => {
      const { fetchSecondarySubtitles } = require('./lib/secondarySource');
      return fetchSecondarySubtitles(ctx.imdbId, ctx.type, 'heb', ctx.fixedLang);
    },
    candidatesForLang: (raw, lang) =>
      (raw || [])
        .filter(s => s.lang === lang)
        .map(s => ({
          id: `mirror:${s.id}`,
          url: s.url,
          lang,
          source: 'mirror',
          // The mirror DOES expose a human-readable release title.
          label: s.label || String(s.id)
        }))
  }
];

for (const entry of HEB_SOURCES) entry.prefix = `${entry.source}:`;

const HEB_SOURCE_PREFIXES = HEB_SOURCES.map(s => s.prefix);

function isLockedSourceId(id) {
  return typeof id === 'string' && HEB_SOURCE_PREFIXES.some(p => id.startsWith(p));
}

/**
 * Per-request context shared by every registry lookup. `_cache` memoizes
 * the in-flight fetch promise per source so asking one source for two
 * different languages (heb candidates + the fixedLang pick) costs one
 * network call, not two.
 */
function createHebSourceContext({ imdbId, type, season, episode, videoParams, fixedLang }) {
  return {
    imdbId,
    type,
    season,
    episode,
    videoParams: videoParams || {},
    fixedLang,
    _cache: new Map()
  };
}

function fetchSourceRawList(entry, ctx) {
  if (!ctx._cache.has(entry.source)) {
    ctx._cache.set(entry.source, Promise.resolve(entry.fetchRaw(ctx)));
  }
  return ctx._cache.get(entry.source);
}

/**
 * Place the Hebrew candidate and the fixed-language candidate into the
 * user's ACTUALLY configured main/trans slots.
 *
 * `mergeSubtitles` treats main and trans asymmetrically — main drives cue
 * timing and gets the bold line — so a user who configured
 * mainLang=Russian, transLang=Hebrew must get Russian in the main slot,
 * not Hebrew. Pure + exported for testing.
 */
function assignHebrewSlots(mainLang, transLang, hebSub, fixedSub) {
  const hebIsMain = mainLang === 'heb';
  return {
    mainLang,
    transLang,
    hebIsMain,
    mainSub: hebIsMain ? hebSub : fixedSub,
    transSub: hebIsMain ? fixedSub : hebSub
  };
}

/**
 * Build the Stremio subtitles-handler response for a Hebrew-involved
 * language pair: one picker entry per Hebrew candidate from every
 * source (no cap), each paired with a single fixed candidate for the
 * other configured language. Priority order: Wizdom, Ktuvit,
 * OpenSubtitles primary, then the community mirror — the mirror is
 * queried only if the first three collectively have zero Hebrew
 * candidates or zero fixedLang candidate.
 *
 * Takes the user's configured `mainLang`/`transLang` (one of which is
 * `heb`) rather than just `fixedLang`, so each candidate lands in the
 * slot the user actually asked for.
 */
async function buildHebrewMultiSourceResponse(imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  const ctx = createHebSourceContext({ imdbId, type, season, episode, videoParams, fixedLang });

  const primarySources = HEB_SOURCES.filter(s => !s.fallbackOnly);
  const rawLists = await Promise.all(primarySources.map(s => fetchSourceRawList(s, ctx)));

  const sourceGroups = primarySources.map((entry, i) => ({
    source: entry.source,
    candidates: entry.candidatesForLang(rawLists[i], 'heb')
  }));

  const osIdx = primarySources.findIndex(s => s.source === 'opensubtitles');
  const osEntry = primarySources[osIdx];
  let fixedCandidate = osEntry.candidatesForLang(rawLists[osIdx], fixedLang)[0] || null;

  const hasAnyHeb = sourceGroups.some(g => g.candidates.length > 0);

  // Explicit, reachable mirror fallback. It can only fire here because we
  // fetched the OpenSubtitles PRIMARY index above — the `fetchAllSubtitles`
  // wrapper would have already run its own hidden mirror call and made
  // this condition permanently false.
  if (!hasAnyHeb || !fixedCandidate) {
    debugServer.log(
      `Hebrew multi-source: primary sources missing coverage (heb=${!hasAnyHeb}, ${fixedLang}=${!fixedCandidate}), trying mirror fallback`
    );
    const mirrorEntry = HEB_SOURCES.find(s => s.source === 'mirror');
    const mirrorRaw = await fetchSourceRawList(mirrorEntry, ctx);

    if (!hasAnyHeb) {
      sourceGroups.push({
        source: mirrorEntry.source,
        candidates: mirrorEntry.candidatesForLang(mirrorRaw, 'heb')
      });
    }
    if (!fixedCandidate) {
      fixedCandidate = mirrorEntry.candidatesForLang(mirrorRaw, fixedLang)[0] || null;
    }
  }

  if (!fixedCandidate) {
    debugServer.warn(`Hebrew multi-source: no ${fixedLang} candidate found from any source`);
    return { subtitles: [] };
  }

  const entries = buildHebrewEntries(sourceGroups, fixedCandidate);

  if (entries.length === 0) {
    debugServer.warn('Hebrew multi-source: no Hebrew candidates found from any source');
    return { subtitles: [] };
  }

  const finalSubtitles = entries.map(entry => {
    const slots = assignHebrewSlots(mainLang, transLang, entry.hebSub, entry.fixedSub);
    const dynamicParams = [
      type,
      imdbId,
      season || '0',
      episode || '0',
      slots.mainLang,
      slots.transLang,
      encodeURIComponent(slots.mainSub.id),
      encodeURIComponent(slots.transSub.id)
    ].join('/');

    return {
      id: entry.id,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: mainLang,
      SubtitlesName: `★ [${entry.source}] ${entry.label} + ${getLanguageName(fixedLang)}`
    };
  });

  debugServer.log(`Hebrew multi-source: publishing ${finalSubtitles.length} entries`);

  return { subtitles: finalSubtitles, cacheMaxAge: 6 * 3600 };
}

// Subtitle handler function
async function subtitlesHandler({ type, id, extra, config }) {
  debugServer.log('Subtitle request:', sanitizeForLogging({ type, id }));

  // Get configured languages
  const mainLangRaw = config?.mainLang || 'English [eng]';
  const transLangRaw = config?.transLang || 'Turkish [tur]';

  const mainLang = parseLangCode(mainLangRaw);
  const transLang = parseLangCode(transLangRaw);

  debugServer.log(`Languages: Primary=${mainLang}, Secondary=${transLang}`);

  // Prevent same language selection
  if (mainLang === transLang) {
    debugServer.warn('Error: Same language selected for both');
    return { subtitles: [] };
  }

  // Parse IMDB ID
  let imdbId = extra?.imdbId || id;
  let season = extra?.season;
  let episode = extra?.episode;

  if (imdbId.includes(':')) {
    const parts = imdbId.split(':');
    imdbId = parts[0];
    if (parts.length >= 3) {
      season = season || parts[1];
      episode = episode || parts[2];
    }
  }

  imdbId = imdbId.replace('tt', '');

  if (!imdbId) {
    debugServer.warn('No valid IMDB ID');
    return { subtitles: [] };
  }

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
    if (mainLang === 'heb' || transLang === 'heb') {
      return await buildHebrewMultiSourceResponse(
        imdbId, type, season, episode, mainLang, transLang, videoParams, videoQuery
      );
    }

    // Fetch all subtitles
    debugServer.log('Fetching subtitles from OpenSubtitles...');
    const allSubtitles = await fetchAllSubtitles(imdbId, type, season, episode, videoParams, mainLang, transLang);

    if (!allSubtitles) {
      debugServer.warn('No subtitles found');
      return { subtitles: [] };
    }

    debugServer.log(`Found ${allSubtitles.length} total subtitles`);

    // Build the ordered list of (main, trans) candidates. Same-`g`
    // (same release) pairs come first; this is our biggest single
    // accuracy win on titles like Sopranos S01E03.
    const candidatePairs = generateCandidatePairs(allSubtitles, mainLang, transLang);

    if (candidatePairs.length === 0) {
      debugServer.warn(`No ${mainLang}/${transLang} candidate pairs available`);
      return { subtitles: [] };
    }

    debugServer.log(
      `Built ${candidatePairs.length} candidate pair(s); ` +
      `same-group: ${candidatePairs.filter(p => p.sameGroup).length}`
    );

    // CPU-cheap path: do NOT fetch / parse / merge here. Just publish
    // the URL of the best-ranked pair. The actual download + alignment
    // happens once, on demand, when Stremio fetches the .srt URL. This
    // halves Vercel Active CPU per dual-subtitle request, since the old
    // code ran the entire pipeline twice (once here for nothing).
    const best = candidatePairs[0];

    const dynamicParams = [
      type,
      imdbId,
      season || '0',
      episode || '0',
      mainLang,
      transLang,
      best.main.id,
      best.trans.id
    ].join('/');

    const finalSubtitles = [{
      id: `dual-${best.main.id}-${best.trans.id}`,
      url: `{{ADDON_URL}}/subs/${dynamicParams}.srt${videoQuery ? `?${videoQuery}` : ''}`,
      lang: mainLang,
      SubtitlesName:
        `★ Dual (${mainLang.toUpperCase()}+${transLang.toUpperCase()}) - ` +
        `${getLanguageName(mainLang)} + ${getLanguageName(transLang)}`
    }];

    debugServer.log(
      `Selected pair (no merge): main=${best.main.id} trans=${best.trans.id} ` +
      `source=${best.source} sameGroup=${best.sameGroup}`
    );

    return {
      subtitles: finalSubtitles,
      cacheMaxAge: 6 * 3600
    };

  } catch (error) {
    debugServer.error('Error in subtitle handler:', sanitizeForLogging(error.message));
    return { subtitles: [] };
  }
}

// Register the handler with the builder
builder.defineSubtitlesHandler(subtitlesHandler);

/**
 * Re-resolve a single source-prefixed subtitle id back to its
 * {id, url, lang} by re-fetching that source's list for this title and
 * finding the matching entry. Wizdom/Ktuvit/the mirror only expose a
 * per-title list endpoint, not a per-id lookup, so this re-fetch is
 * unavoidable — but it's the same call the listing step already made,
 * so it's a cache-friendly repeat, not new load shape.
 *
 * Dispatch comes straight off the HEB_SOURCES registry — same rows, same
 * fetchers, same id construction the listing used — so listing and
 * re-resolution cannot drift and produce silent 404s.
 */
async function fetchLockedCandidate(prefixedId, ctx, lang) {
  const entry = HEB_SOURCES.find(s => prefixedId.startsWith(s.prefix));
  if (!entry) return null;

  const raw = await fetchSourceRawList(entry, ctx);
  const candidates = entry.candidatesForLang(raw, lang);
  return candidates.find(c => c.id === prefixedId) || null;
}

/**
 * Merge exactly the requested (mainSubId, transSubId) pair — no
 * quality-gate try-loop, no substitution. If either side can't be
 * re-resolved, fetched, parsed, or merged, return null so the caller
 * (server.js's /subs/ route) responds 404 rather than serving a
 * different Hebrew subtitle than the one the user picked.
 *
 * `mainLang`/`transLang` arrive in the user's configured order (whichever
 * one is `heb` may be either), and the ids were placed into those same
 * slots by `assignHebrewSlots` at listing time — so `mergeSubtitles` gets
 * them in the user's actual order, not Hebrew-first.
 */
async function generateLockedPairSubtitle(mainSubId, transSubId, mainLang, transLang, imdbId, type, season, episode, cacheKey, videoParams = {}) {
  const fixedLang = mainLang === 'heb' ? transLang : mainLang;
  // Shared context: both re-resolutions hit each source's list at most
  // once, and `videoParams` is threaded through so the OpenSubtitles
  // primary re-fetch sees the same filename/videoSize/videoHash the
  // listing used (otherwise the two id sets could legitimately differ).
  const ctx = createHebSourceContext({ imdbId, type, season, episode, videoParams, fixedLang });

  const [mainCandidate, transCandidate] = await Promise.all([
    fetchLockedCandidate(mainSubId, ctx, mainLang),
    fetchLockedCandidate(transSubId, ctx, transLang)
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

/**
 * Generate merged subtitle dynamically (for serverless environments)
 * Called directly by URL. Results are cached in `subtitleCache` so any
 * repeat hit on the same Vercel instance skips fetch + parse + merge
 * entirely — even ahead of Vercel's edge cache (which ALSO caches via
 * Cache-Control headers in server.js routes).
 */
async function generateDynamicSubtitle(
  type,
  imdbId,
  season,
  episode,
  mainLang,
  transLang,
  mainSubId,
  transSubId,
  videoParams = {}
) {
  debugServer.log('Dynamic subtitle generation:', { type, imdbId, mainLang, transLang });

  const videoCacheFragment = serializeVideoParams(videoParams);
  const cacheKey =
    `${imdbId}_${season || ''}_${episode || ''}` +
    `_${mainLang}_${transLang}_${mainSubId}_${transSubId}` +
    `_${videoCacheFragment || ''}`;
  const cached = getSubtitle(cacheKey);
  if (cached) {
    debugServer.log(`Cache hit (in-instance): ${cacheKey}`);
    return cached;
  }

  if (isLockedSourceId(mainSubId) && isLockedSourceId(transSubId)) {
    // Guarded separately from the legacy try/catch below: mergeSubtitles,
    // formatSrt and storeSubtitle are not internally guarded, so an
    // unguarded throw here would surface as a 500 instead of the intended
    // 404 ("this exact pair could not be produced").
    try {
      return await generateLockedPairSubtitle(
        mainSubId, transSubId, mainLang, transLang, imdbId, type,
        // Normalize the '0' sentinels the listing URL uses for movies the
        // same way the legacy path below does. Both paths must agree:
        // downstream fetchers guard on `type === 'series'` first today, so
        // the raw '0' was harmless — but keeping the two paths symmetric
        // means nobody has to rediscover that when touching a guard.
        season !== '0' ? season : null,
        episode !== '0' ? episode : null,
        cacheKey,
        normalizeVideoParams(videoParams)
      );
    } catch (error) {
      debugServer.error('Error generating locked pair subtitle:', sanitizeForLogging(error.message));
      return null;
    }
  }

  try {
    // Fetch all subtitles
    const normalizedVideoParams = normalizeVideoParams(videoParams);
    const allSubtitles = await fetchAllSubtitles(
      imdbId,
      type,
      season !== '0' ? season : null,
      episode !== '0' ? episode : null,
      normalizedVideoParams,
      mainLang,
      transLang
    );

    if (!allSubtitles) {
      debugServer.warn('No subtitles found');
      return null;
    }

    // Build candidate pairs for this title; we'll start by trying the
    // exact pair encoded in the URL (the one subtitlesHandler picked),
    // then fall back to other candidates if the match rate is too low.
    const candidatePairs = generateCandidatePairs(allSubtitles, mainLang, transLang);

    const requestedMain = allSubtitles.find(s => String(s.id) === String(mainSubId));
    const requestedTrans = allSubtitles.find(s => String(s.id) === String(transSubId));

    let orderedPairs = candidatePairs;
    if (requestedMain && requestedTrans) {
      // Move the URL-requested pair to the front (or insert it if it
      // wasn't in the candidate list, e.g. addon was upgraded mid-cache).
      const isSameGroup =
        requestedMain.g === requestedTrans.g && requestedMain.g != null;
      const head = {
        main: requestedMain,
        trans: requestedTrans,
        sameGroup: isSameGroup,
        group: isSameGroup ? requestedMain.g : null,
        source: 'requested'
      };
      orderedPairs = [
        head,
        ...candidatePairs.filter(
          p => !(String(p.main.id) === String(mainSubId) &&
                 String(p.trans.id) === String(transSubId))
        )
      ];
    } else {
      debugServer.warn(
        'Requested specific pair not present in fresh subtitle list; ' +
        'falling back to ranked candidates'
      );
    }

    if (orderedPairs.length === 0) return null;

    const best = await selectAndMergeBestPair(orderedPairs, mainLang, transLang);
    if (!best || !best.merged || best.merged.length === 0) {
      debugServer.warn('No usable merged subtitle from any pair');
      return null;
    }

    const srtContent = best.mergedSrt;
    debugServer.log(
      `Generated ${best.merged.length} merged subtitle entries ` +
      `(matchRate=${(best.matchRate * 100).toFixed(1)}%, attempts=${best.attempts})`
    );

    if (srtContent) storeSubtitle(cacheKey, srtContent);
    return srtContent;
  } catch (error) {
    debugServer.error('Error generating dynamic subtitle:', sanitizeForLogging(error.message));
    return null;
  }
}

module.exports = {
  builder,
  manifest,
  getSubtitle,
  subtitleCache,
  subtitlesHandler,
  generateDynamicSubtitle,
  buildConfiguredManifestName,
  // Exported for testing
  _test: {
    parseTimeToMs,
    parseSrt,
    parseSrtSimple,
    normalizeVttToSrt,
    mergeSubtitles,
    joinSubtitleLines,
    formatSrt,
    formatSrtSimple,
    msToSrtTime,
    assignHebrewSlots,
    isLockedSourceId,
    HEB_SOURCES,
    buildHebrewMultiSourceResponse
  }
};
