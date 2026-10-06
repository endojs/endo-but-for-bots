// @ts-check

/**
 * Delivers security warnings to the Chat renderer on every load of the Chat
 * page, never to a `localhttp:` weblet or other page in the same window.
 * Sends immediately if the page has already loaded, and again on each
 * `did-finish-load`.  See designs/familiar-localhttp-protocol.md for
 * the rationale.
 */

import { pathToFileURL } from 'node:url';

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
 * The URL without its query and fragment, with its path percent-decoded.
 * Node's `pathToFileURL` and Chromium's URL canonicalizer, which produces
 * `webContents.getURL()`, escape different sets of characters (Node emits
 * `%7E` for `~`; Chromium decodes it), so comparing serialized paths could
 * miss the Chat page and silently drop its warnings.
 *
 * @param {string} url
 * @returns {string | undefined}
 */
const pageIdentity = url => {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return undefined;
  }
};

/**
 * The `file:` URL of the built Chat page at `chatDistPath`.  Unlike a
 * `file://${path}` template, this percent-encodes characters such as a space,
 * `#`, `?`, or `%`, so the path survives parsing intact and `isChatPageUrl`
 * still matches when the install path contains them.
 *
 * @param {string} chatDistPath
 * @returns {string}
 */
export const chatFilePageUrl = chatDistPath => pathToFileURL(chatDistPath).href;
harden(chatFilePageUrl);

/**
 * Whether `url` is the Chat page at `chatPageUrl`, the URL
 * `electron-main.js` loads into the window.  The query and fragment may
 * differ; the protocol, host, port, and percent-decoded path must not.
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
 * Install one `did-finish-load` listener on `webContents` and return a
 * function that replaces the warnings it delivers.  Each replacement is sent
 * at once if the Chat page has loaded, and every later load of the Chat page
 * receives the latest warnings, not the ones current when the listener was
 * installed.  An empty list is never sent.
 *
 * @param {WebContentsLike} webContents
 * @param {string} chatPageUrl - the Chat page URL, as for `isChatPageUrl`
 * @returns {(warnings: string[]) => void}
 */
const makeWarningDelivery = (webContents, chatPageUrl) => {
  /** @type {string[]} */
  let payload = [];
  const send = () => {
    if (
      payload.length > 0 &&
      isChatPageUrl(webContents.getURL(), chatPageUrl)
    ) {
      webContents.send(SECURITY_WARNINGS_CHANNEL, payload);
    }
  };
  webContents.on('did-finish-load', send);
  return warnings => {
    payload = [...warnings];
    if (!webContents.isLoading()) {
      send();
    }
  };
};

/**
 * Send `warnings` to the renderer of `webContents` now (if its page has
 * loaded) and again after every subsequent load of the Chat page.  Does
 * nothing when there are no warnings.
 *
 * Each call installs a new `did-finish-load` listener that keeps resending
 * this call's `warnings`, so call it at most once per `webContents`.  To
 * deliver a fresh verdict on every window creation or reload, use
 * `makeSecurityWarningReporter`, which reuses one delivery per `webContents`.
 *
 * @param {WebContentsLike} webContents
 * @param {string[]} warnings
 * @param {string} chatPageUrl - the Chat page URL, as for `isChatPageUrl`
 */
export const deliverSecurityWarnings = (webContents, warnings, chatPageUrl) => {
  if (warnings.length === 0) {
    return;
  }
  makeWarningDelivery(webContents, chatPageUrl)(warnings);
};
harden(deliverSecurityWarnings);

/**
 * @typedef {object} WindowLike
 * @property {() => boolean} isDestroyed
 * @property {WebContentsLike} webContents
 */

/**
 * Re-runs the defense verification for a window and delivers the fresh
 * verdict to its Chat page.  The DNS canary checks mutable runtime state
 * (resolver, VPN, network), so a window gets a new verdict whenever it is
 * created or its Chat page is reloaded for a daemon restart or purge, never
 * a replay of an earlier snapshot.  A window whose earlier verdict was clean
 * still receives warnings a later verification finds.
 *
 * @param {object} options
 * @param {() => Promise<string[]>} options.verifyDefenses
 * @param {string} options.chatPageUrl - as for `isChatPageUrl`
 * @param {(warnings: string[]) => void} [options.onWarnings] - called with
 *   each non-empty verdict, for logging
 */
export const makeSecurityWarningReporter = ({
  verifyDefenses,
  chatPageUrl,
  onWarnings = () => {},
}) => {
  /** @type {WeakMap<WebContentsLike, (warnings: string[]) => void>} */
  const deliveries = new WeakMap();

  /**
   * Verify the defenses and deliver the verdict to `window`.  Call it after
   * creating a window and before reloading its Chat page.
   *
   * @param {WindowLike} window
   */
  const verifyAndWarn = async window => {
    const warnings = await verifyDefenses();
    if (warnings.length > 0) {
      onWarnings(warnings);
    }
    if (window.isDestroyed()) {
      return;
    }
    const { webContents } = window;
    let deliver = deliveries.get(webContents);
    if (deliver === undefined) {
      deliver = makeWarningDelivery(webContents, chatPageUrl);
      deliveries.set(webContents, deliver);
    }
    deliver(warnings);
  };

  return harden({ verifyAndWarn });
};
harden(makeSecurityWarningReporter);
