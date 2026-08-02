/**
 * UA classifier deciding whether a client is safe to send a labeled
 * (`[source] ...`) Hebrew picker `lang` value instead of the plain one.
 *
 * Deny-by-default: any missing/unrecognized User-Agent is denied, because
 * real sampling confirmed Android sends no User-Agent header at all — an
 * absent UA must never be treated as "probably fine".
 *
 * Structural matching (OS token + browser engine token) rather than an
 * exact UA string, so it survives ordinary browser/engine version bumps
 * without needing updates.
 *
 * This exists because a previous change set a non-standard `lang` value
 * unconditionally and broke Android TV subtitle listing (see `cbafce7`).
 * Keeping non-desktop clients on the plain `lang` is the whole point.
 */
function isDesktopBrowserLikeClient(userAgent) {
  if (!userAgent) return false;
  if (/Android|Mobile/.test(userAgent)) return false;
  const hasDesktopOs = /Windows NT|Macintosh|X11/.test(userAgent);
  const hasBrowserEngine = /Chrome\/|Safari\/|Firefox\//.test(userAgent);
  return hasDesktopOs && hasBrowserEngine;
}

module.exports = { isDesktopBrowserLikeClient };
