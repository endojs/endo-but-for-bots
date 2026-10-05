// @ts-check

/**
 * Delivery of startup security warnings to the Chat renderer.
 *
 * The exfiltration-defense verification runs after the window is created
 * but usually before its page has loaded, and `webContents.send` drops a
 * message when no renderer is listening yet.  Any reload (a daemon restart
 * re-runs `loadURL`) also discards whatever the previous page had shown.
 * So the warnings are sent on every `did-finish-load`, and immediately when
 * the page has already finished loading.
 *
 * The listener outlives the first page, and the navigation guard lets the
 * window navigate to `localhttp:` weblets, which get the same preload
 * bridge, and it lets the window navigate to any `file:` page.  The
 * warnings describe which defense failed, so they go only to the Chat page
 * itself: the exact URL `electron-main.js` loads (the Chat dist
 * `index.html`, or the loopback Vite dev server on its pinned port),
 * ignoring only the query and the configuration fragment.
 */

export const SECURITY_WARNINGS_CHANNEL = 'familiar:security-warnings';

/**
 * @typedef {object} WebContentsLike
 * @property {(channel: string, ...args: unknown[]) => void} send
 * @property {() => boolean} isLoading
 * @property {() => string} getURL
 * @property {(event: 'did-finish-load', listener: () => void) => void} on
 */

/**
 * @param {string} url
 * @returns {string | undefined} the URL without its query and fragment
 */
const pageIdentity = url => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
};

/**
 * Whether `url` is the Chat page at `chatPageUrl`, the URL
 * `electron-main.js` loads into the window.  The query and fragment may
 * differ; the protocol, host, port, and path must not.
 *
 * @param {string} url
 * @param {string} chatPageUrl
 * @returns {boolean}
 */
export const isChatPageUrl = (url, chatPageUrl) => {
  const expected = pageIdentity(chatPageUrl);
  return expected !== undefined && pageIdentity(url) === expected;
};

/**
 * Send `warnings` to the renderer of `webContents` now (if its page has
 * loaded) and again after every subsequent load of the Chat page.  Does
 * nothing when there are no warnings.
 *
 * @param {WebContentsLike} webContents
 * @param {string[]} warnings
 * @param {string} chatPageUrl - the Chat page URL, as for `isChatPageUrl`
 */
export const deliverSecurityWarnings = (webContents, warnings, chatPageUrl) => {
  if (warnings.length === 0) {
    return;
  }
  const payload = [...warnings];
  const send = () => {
    if (isChatPageUrl(webContents.getURL(), chatPageUrl)) {
      webContents.send(SECURITY_WARNINGS_CHANNEL, payload);
    }
  };
  webContents.on('did-finish-load', send);
  if (!webContents.isLoading()) {
    send();
  }
};
