// @ts-check

/**
 * Delivers startup security warnings to the Chat renderer on every load of
 * the Chat page, never to a `localhttp:` weblet or other page in the same
 * window.  Sends immediately if the page has already loaded, and again on
 * each `did-finish-load`.  See designs/familiar-localhttp-protocol.md for
 * the rationale.
 */

import harden from '@endo/harden';

export const SECURITY_WARNINGS_CHANNEL = 'familiar:security-warnings';
harden(SECURITY_WARNINGS_CHANNEL);

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
harden(isChatPageUrl);

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
harden(deliverSecurityWarnings);
