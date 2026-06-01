// @ts-check
/* global process */

/**
 * Electron main process entry point for the Endo Familiar.
 *
 * Startup sequence:
 * 1. Register localhttp:// scheme and configure command-line flags (before app
 *    ready)
 * 2. Ensure the Endo daemon is running (daemon hosts the gateway)
 * 3. Read gateway connection info (port from ENDO_ADDR, agent ID from state)
 * 4. Install localhttp:// handler, exfiltration defenses, and navigation guard
 * 5. Create a BrowserWindow loading Chat with config via URL query params
 * 6. Verify exfiltration defenses and send warnings to renderer
 *
 * The daemon outlives the Familiar.
 */

import os from 'os';
import path from 'path';
// @ts-ignore Electron is not typed in this project
import { app, BrowserWindow, Menu, ipcMain, screen } from 'electron';

import { whereEndoState } from '@endo/where';

import { makeDaemonManager } from './src/daemon-manager.js';
import { resourcePaths } from './src/resource-paths.js';
import { makeLogger } from './src/logger.js';
import { parseInviteUrl, findInviteUrlInArgv } from './src/deep-link.js';
import {
  registerLocalhttpScheme,
  installLocalhttpHandler,
} from './src/protocol-handler.js';
import { installNavigationGuard } from './src/navigation-guard.js';
import {
  configureCommandLineFlags,
  installExfiltrationDefenses,
  verifyExfiltrationDefenses,
} from './src/exfiltration-defense.js';

const { username, homedir } = os.userInfo();
const temp = os.tmpdir();
const endoInfo = { user: username, home: homedir, temp };
const statePath = whereEndoState(process.platform, process.env, endoInfo);

const logger = makeLogger(path.join(statePath, 'familiar.log'));
const {
  ensureDaemonRunning,
  restartDaemon,
  purgeDaemon,
  getAgentId,
  getGatewayAddress,
} = makeDaemonManager(logger);

const appRoot = app.getAppPath();
const isDevMode = process.argv.includes('--dev');

// --- Pre-ready setup ---
// These must be called before app.whenReady().
registerLocalhttpScheme();
configureCommandLineFlags();

const vitePort = 5173;

/** @type {Electron.BrowserWindow | null} */
let mainWindow = null;

// --- Deep-link (endo://) peer invitations ---
// (designs/familiar-deep-link-invitations.md)

/** @type {import('./src/deep-link.js').ParsedInvite | null} */
let pendingInvite = null;
// Set once the renderer has pulled any queued invite via the IPC handler
// below; until then invites are queued rather than sent, closing the race
// where a cold-start invite is emitted before the page registers its
// listener.
let rendererReady = false;

/**
 * Deliver a parsed invite to the renderer, or queue it until the renderer is
 * ready (cold start, pre-`app.whenReady`, or before the window finishes
 * loading).
 *
 * @param {import('./src/deep-link.js').ParsedInvite} parsed
 */
const deliverInvite = parsed => {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('familiar:deep-link-invite', parsed);
  } else {
    pendingInvite = parsed;
  }
};

/**
 * Parse and route an `endo://` URL handed to us by the OS. Unrecognised
 * links are logged and dropped; authoritative validation is the daemon's
 * when the renderer calls `host.accept`.
 *
 * @param {string} url
 */
const handleInviteUrl = url => {
  const parsed = parseInviteUrl(url);
  if (parsed) {
    logger.log(
      `[Familiar] Received deep-link invite from ${parsed.fingerprint}`,
    );
    deliverInvite(parsed);
  } else {
    logger.warn(
      `[Familiar] Ignoring unrecognised deep link: ${String(url).slice(0, 32)}`,
    );
  }
};

// Register endo:// as this app's protocol client. In dev the app runs from
// the electron binary, so the entry script must be passed explicitly.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('endo', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('endo');
}

// Single-instance: a second launch (e.g. the OS handing us an endo:// URL on
// Windows/Linux) routes its argv to the already-running instance instead of
// starting a second daemon-bearing process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = findInviteUrlInArgv(argv);
    if (url) {
      handleInviteUrl(url);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

// macOS delivers deep links via open-url, which can fire before the app is
// ready or the window exists; deliverInvite queues until the renderer pulls.
app.on('open-url', (_event, url) => {
  handleInviteUrl(url);
});

/** @type {string | undefined} */
let gatewayAddress;

/** @type {string | undefined} */
let agentId;

/**
 * Build the application menu.
 *
 * @param {() => void} onRestart - Callback when "Restart Daemon" is selected
 * @param {() => void} onPurge - Callback when "Purge Daemon" is selected
 */
const buildMenu = (onRestart, onPurge) => {
  const template = /** @type {Electron.MenuItemConstructorOptions[]} */ ([
    {
      label: '🐈‍⬛ Familiar',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Restart Daemon',
          click: onRestart,
        },
        {
          label: 'Purge Daemon...',
          click: onPurge,
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ]);

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

/**
 * Create the main application window.
 *
 * @returns {Electron.BrowserWindow}
 */
const createWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    title: 'Familiar',
    width,
    height,
    webPreferences: {
      preload: path.join(appRoot, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Pass config as a URL fragment (anchor) rather than a query string so
  // the agent ID is never sent on the wire in an HTTP request.
  const fragment = `gateway=${gatewayAddress}&agent=${agentId}`;

  if (isDevMode) {
    // In dev mode, load from Vite dev server.
    // Use 127.0.0.1 instead of localhost to avoid DNS resolution, which
    // is vulnerable to integrity attacks.
    const devUrl = `http://127.0.0.1:${vitePort}#${fragment}`;
    logger.log(`[Familiar] Loading dev URL: ${devUrl}`);
    win.loadURL(devUrl);
    win.webContents.openDevTools();
  } else {
    // In production mode, load the built Chat dist
    const fileUrl = `file://${resourcePaths.chatDistPath}#${fragment}`;
    logger.log(`[Familiar] Loading file URL: ${fileUrl}`);
    win.loadURL(fileUrl);
  }

  // Pipe renderer console output to main process for diagnostics
  win.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      const levelName = ['verbose', 'info', 'warning', 'error'][level] || 'log';
      logger.log(`[renderer:${levelName}] ${message} (${sourceId}:${line})`);
    },
  );

  // Install navigation guard
  installNavigationGuard(win, { isDevMode, vitePort });

  return win;
};

/**
 * Handle daemon restart: restart daemon, reload window.
 *
 * @param {Electron.BrowserWindow | null} win
 */
const handleRestartDaemon = async win => {
  await null;
  try {
    const result = await restartDaemon();
    if (result.gatewayAddress) {
      const parsed = new URL(result.gatewayAddress);
      gatewayAddress = `${parsed.hostname}:${parsed.port || '8920'}`;
    } else {
      gatewayAddress = await getGatewayAddress();
    }
    agentId = await getAgentId();
    if (win && !win.isDestroyed()) {
      // Pass config as a URL fragment (anchor) rather than a query string so
      // the agent ID is never sent on the wire in an HTTP request.
      const fragment = `gateway=${gatewayAddress}&agent=${agentId}`;
      if (isDevMode) {
        win.loadURL(`http://127.0.0.1:${vitePort}#${fragment}`);
      } else {
        win.loadURL(`file://${resourcePaths.chatDistPath}#${fragment}`);
      }
    }
  } catch (error) {
    logger.error('[Familiar] Failed to restart daemon:', error);
  }
};

/**
 * Handle daemon purge: purge daemon, restart it, reload window.
 *
 * @param {Electron.BrowserWindow | null} win
 */
const handlePurgeDaemon = async win => {
  await null;
  try {
    const result = await purgeDaemon();
    if (result.gatewayAddress) {
      const parsed = new URL(result.gatewayAddress);
      gatewayAddress = `${parsed.hostname}:${parsed.port || '8920'}`;
    } else {
      gatewayAddress = await getGatewayAddress();
    }
    agentId = await getAgentId();
    if (win && !win.isDestroyed()) {
      // Pass config as a URL fragment (anchor) rather than a query string so
      // the agent ID is never sent on the wire in an HTTP request.
      const fragment = `gateway=${gatewayAddress}&agent=${agentId}`;
      if (isDevMode) {
        win.loadURL(`http://127.0.0.1:${vitePort}#${fragment}`);
      } else {
        win.loadURL(`file://${resourcePaths.chatDistPath}#${fragment}`);
      }
    }
  } catch (error) {
    logger.error('[Familiar] Failed to purge daemon:', error);
  }
};

/**
 * Extract the gateway port from the gateway address string.
 *
 * @param {string} address - Gateway address in "host:port" format.
 * @returns {number}
 */
const parseGatewayPort = address => {
  const { port } = new URL(`http://${address}`);
  return port !== '' ? Number(port) : 8920;
};

const main = async () => {
  logger.log('[Familiar] Starting...');
  logger.log(`[Familiar] Dev mode: ${isDevMode}`);

  // Step 1: Ensure daemon is running (daemon hosts the gateway)
  const daemonResult = await ensureDaemonRunning();

  // Step 2: Read gateway connection info
  // Prefer the IPC-returned address; fall back to the persisted file.
  if (daemonResult.gatewayAddress) {
    const parsed = new URL(daemonResult.gatewayAddress);
    gatewayAddress = `${parsed.hostname}:${parsed.port || '8920'}`;
  } else {
    gatewayAddress = await getGatewayAddress();
  }
  agentId = await getAgentId();

  logger.log(`[Familiar] Gateway: ${gatewayAddress}`);
  logger.log(`[Familiar] Agent ID: ${String(agentId).slice(0, 16)}...`);

  // Wait for Electron to be ready
  await app.whenReady();

  // Step 3: Install localhttp:// handler and exfiltration defenses
  const gatewayPort = parseGatewayPort(gatewayAddress);
  installLocalhttpHandler(gatewayPort);
  installExfiltrationDefenses();

  // Step 4: Create the window
  mainWindow = createWindow();

  // A deep link may have arrived on the command line (Windows/Linux cold
  // start). Queue it; the renderer pulls it via get-pending-invite on init.
  const coldStartInvite = findInviteUrlInArgv(process.argv);
  if (coldStartInvite) {
    handleInviteUrl(coldStartInvite);
  }

  // Step 5: Build menu
  buildMenu(
    () => handleRestartDaemon(mainWindow),
    () => handlePurgeDaemon(mainWindow),
  );

  // Step 6: Register IPC handlers
  ipcMain.handle('familiar:restart-daemon', () =>
    handleRestartDaemon(mainWindow),
  );
  ipcMain.handle('familiar:purge-daemon', () => handlePurgeDaemon(mainWindow));
  ipcMain.handle('familiar:get-version', () => app.getVersion());
  // The renderer pulls any invite queued before it was listening, and by
  // doing so marks itself ready for live delivery of subsequent invites.
  ipcMain.handle('familiar:get-pending-invite', () => {
    rendererReady = true;
    const invite = pendingInvite;
    pendingInvite = null;
    return invite;
  });

  // Step 7: Verify exfiltration defenses and notify renderer
  const warnings = await verifyExfiltrationDefenses();
  if (warnings.length > 0) {
    logger.warn('[Familiar] Security warnings:', warnings);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('familiar:security-warnings', warnings);
    }
  }

  // macOS: recreate window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });

  // Quit when all windows are closed (except macOS)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Daemon continues running after quit; nothing to clean up.
};

// Only the instance that holds the single-instance lock boots the app; a
// second launch has already forwarded its argv via 'second-instance' above
// and is quitting.
if (gotSingleInstanceLock) {
  main().catch(error => {
    logger.error('[Familiar] Fatal error:', error);
    process.exit(1);
  });
}
