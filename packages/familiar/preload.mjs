// @ts-check

/**
 * Electron preload script.
 *
 * Exposes a minimal IPC bridge to the renderer via `contextBridge`.
 *
 * Electron 28+ supports ESM preload scripts when the file uses the
 * `.mjs` extension (the `"type": "module"` field in `package.json` is
 * ignored for preload).  The renderer here is unsandboxed
 * (`webPreferences.sandbox` is omitted in `electron-main.js`), so an
 * ESM preload is allowed.  See:
 * https://www.electronjs.org/docs/latest/tutorial/esm
 */

// @ts-ignore Electron is not typed in this project
import { contextBridge, ipcRenderer } from 'electron';

// Warnings may arrive before the page subscribes, so the latest set is kept
// and replayed to each subscriber.
/** @type {string[] | undefined} */
let latestSecurityWarnings;
/** @type {Set<(warnings: string[]) => void>} */
const securityWarningSubscribers = new Set();
// The channel name repeats SECURITY_WARNINGS_CHANNEL from
// src/security-warnings.js rather than importing it: the packaged app ships
// this file unbundled beside bundles/, without src/ (scripts/package-app.mjs),
// so a relative import would not resolve there.  The preload test subscribes
// through the imported constant, so the two names cannot drift silently.
ipcRenderer.on(
  'familiar:security-warnings',
  (/** @type {unknown} */ _event, /** @type {string[]} */ warnings) => {
    latestSecurityWarnings = warnings;
    // One throwing subscriber must not starve the others.
    for (const callback of securityWarningSubscribers) {
      try {
        callback(warnings);
      } catch (error) {
        console.error(error);
      }
    }
  },
);

contextBridge.exposeInMainWorld(
  'familiar',
  /** @type {object} */ ({
    restartDaemon: () => ipcRenderer.invoke('familiar:restart-daemon'),
    purgeDaemon: () => ipcRenderer.invoke('familiar:purge-daemon'),
    getVersion: () => ipcRenderer.invoke('familiar:get-version'),
    onSecurityWarnings: (
      /** @type {(warnings: string[]) => void} */ callback,
    ) => {
      securityWarningSubscribers.add(callback);
      if (latestSecurityWarnings !== undefined) {
        callback(latestSecurityWarnings);
      }
    },
  }),
);
