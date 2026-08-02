function isDesktopBrowserLikeClient(userAgent) {
  if (!userAgent) return false;
  if (/Android|Mobile/.test(userAgent)) return false;
  const hasDesktopOs = /Windows NT|Macintosh|X11/.test(userAgent);
  const hasBrowserEngine = /Chrome\/|Safari\/|Firefox\//.test(userAgent);
  return hasDesktopOs && hasBrowserEngine;
}

module.exports = { isDesktopBrowserLikeClient };
