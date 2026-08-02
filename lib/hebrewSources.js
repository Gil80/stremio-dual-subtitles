/**
 * Hebrew-specific subtitle sources: Wizdom (wizdom.xyz) and Ktuvit
 * (ktuvit.me), both queried via their public, already-hosted Stremio
 * addon instances — no self-hosting or credentials needed. (The
 * KTUVIT_USER_EMAIL/hashed-password env vars documented in the Ktuvit
 * repo are only for self-hosting a private instance; the public
 * instance queried here needs none of that.)
 *
 * Verified live 2026-08-02 against tt15047880 (Disclosure Day, which
 * has 0 Hebrew subs on the OpenSubtitles primary index): Wizdom
 * returned 9 heb entries, Ktuvit returned 3, both as
 * { id, lang: "heb", url }.
 *
 * Every returned entry's `id` is prefixed with its source name
 * (e.g. "wizdom:...", "ktuvit:...") so addon.js can route a later
 * generateDynamicSubtitle request back to the correct source without
 * needing an extra URL parameter.
 */

const axios = require('axios');
const { debugServer, sanitizeForLogging } = require('./debug');

const WIZDOM_BASE = 'https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club';
const KTUVIT_BASE = 'https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club';

// Wizdom/Ktuvit's own public addon already bakes a bracketed source tag
// into `id` (e.g. "[WIZDOM]Some.Release.srt") — strip it so it doesn't
// duplicate the "[wizdom]"/"[ktuvit]" tag addon.js adds on top when
// building the display label.
function stripBracketedSourceTag(id) {
  return id.replace(/^\[[^\]]*\]\s*/, '');
}

function buildSubtitlesUrl(base, type, imdbId, season, episode) {
  let path = `${base}/subtitles/${type}/tt${imdbId}`;
  if (type === 'series' && season && episode) {
    path += `:${season}:${episode}`;
  }
  return `${path}.json`;
}

async function fetchFromSource(base, sourcePrefix, imdbId, type, season, episode) {
  const url = buildSubtitlesUrl(base, type, imdbId, season, episode);

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const raw = response.data && response.data.subtitles;
    if (!Array.isArray(raw) || raw.length === 0) return [];

    return raw
      .filter(s => s && s.url && s.id && s.lang === 'heb')
      .map(s => ({
        id: `${sourcePrefix}:${s.id}`,
        url: s.url,
        lang: 'heb',
        source: sourcePrefix,
        label: stripBracketedSourceTag(s.id)
      }));
  } catch (error) {
    debugServer.warn(`${sourcePrefix} fetch failed:`, sanitizeForLogging(error.message));
    return [];
  }
}

async function fetchWizdomSubtitles(imdbId, type, season = null, episode = null) {
  return fetchFromSource(WIZDOM_BASE, 'wizdom', imdbId, type, season, episode);
}

async function fetchKtuvitSubtitles(imdbId, type, season = null, episode = null) {
  return fetchFromSource(KTUVIT_BASE, 'ktuvit', imdbId, type, season, episode);
}

module.exports = {
  fetchWizdomSubtitles,
  fetchKtuvitSubtitles,
  _test: { stripBracketedSourceTag }
};
