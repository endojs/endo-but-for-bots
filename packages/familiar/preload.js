// @ts-check
/* eslint-disable @jessie.js/safe-await-separator */

'use strict';

// Electron preload script (CommonJS required by Electron)
// Exposes a minimal IPC bridge to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron'); // eslint-disable-line @typescript-eslint/no-require-imports

contextBridge.exposeInMainWorld(
  'familiar',
  /** @type {object} */ ({
    restartDaemon: () => ipcRenderer.invoke('familiar:restart-daemon'),
    purgeDaemon: () => ipcRenderer.invoke('familiar:purge-daemon'),
    getVersion: () => ipcRenderer.invoke('familiar:get-version'),
    onSecurityWarnings: (
      /** @type {(warnings: string[]) => void} */ callback,
    ) =>
      ipcRenderer.on('familiar:security-warnings', (_event, warnings) =>
        callback(warnings),
      ),
    // endo:// deep-link peer invitations
    // (designs/familiar-deep-link-invitations.md). The renderer pulls any
    // invite queued before it was listening, then subscribes for live ones.
    getPendingDeepLinkInvite: () =>
      ipcRenderer.invoke('familiar:get-pending-invite'),
    onDeepLinkInvite: (/** @type {(invite: object) => void} */ callback) =>
      ipcRenderer.on('familiar:deep-link-invite', (_event, invite) =>
        callback(invite),
      ),
  }),
);
