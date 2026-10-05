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
 */

export const SECURITY_WARNINGS_CHANNEL = 'familiar:security-warnings';

/**
 * @typedef {object} WebContentsLike
 * @property {(channel: string, ...args: unknown[]) => void} send
 * @property {() => boolean} isLoading
 * @property {(event: 'did-finish-load', listener: () => void) => void} on
 */

/**
 * Send `warnings` to the renderer of `webContents` now (if its page has
 * loaded) and again after every subsequent page load.  Does nothing when
 * there are no warnings.
 *
 * @param {WebContentsLike} webContents
 * @param {string[]} warnings
 */
export const deliverSecurityWarnings = (webContents, warnings) => {
  if (warnings.length === 0) {
    return;
  }
  const payload = [...warnings];
  const send = () => webContents.send(SECURITY_WARNINGS_CHANNEL, payload);
  webContents.on('did-finish-load', send);
  if (!webContents.isLoading()) {
    send();
  }
};
