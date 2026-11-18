// @ts-check
/* eslint-disable import/no-relative-packages */
/**
 * The browser harness of M3, M4 and M5 acceptance (designs/m3-interfaces.md
 * 6.4, 12, 17; W3.8): a daemon served from a state template, the gateway on
 * port 0, the UI built, and headless Chromium on the fragment sign-in URL.
 *
 *   const { page, url, client, close } = await startBrowserGateway({
 *     template: 'm2',                       // or 'm3-300', or a Template
 *     provision: async ({ root, operator }) => { ... },
 *   });
 *
 * `provision` runs before the gateway serves, with the `HarnessRoot` and
 * its `Operator` presences from the control client (for a lane's set-up:
 * secrets, presets, backends). `client` is a signed-in Node CapTP client
 * (`serveGateway(...).connect()`, `client.powers` its `GatewayPowers`).
 * `close()` closes the browser, the client, the gateway's supervisor and
 * the test wrapping key, and releases the run lock.
 *
 * Beyond the fixed signature it also answers `state` (the template state:
 * `kill`, `restart`, `stop`, `client`, `root`), `gateway` (`serveGateway`'s
 * answer: `connect`, `admin`, `port`, `origin`, `secret`), `browser` and
 * `newPage(url?)` (a page in a fresh browser context, so another device).
 *
 * Callers gate their file on THIX_HARNESS_BROWSER=1 (`browserEnabled`) and
 * on a Chromium being present (`browserSkipReason()`); called without the
 * variable it throws. Chromium: THIX_HARNESS_CHROMIUM, else Playwright's own
 * download for its version, else the newest headless shell or Chromium in
 * Playwright's cache (an older build drives fine over CDP; J-9600). Nothing
 * is downloaded by the tests.
 *
 * The run lock: taken in process (`acquireRunLock`, shared); under
 * `corepack yarn test:browser <file>` the CLI wrapper already holds a slot
 * and the taker passes through.
 */
import '../unit/_m1a-prelude.js';

import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/far';

import { names } from '../../scripts/provision-steps.js';
import { acquireRunLock } from '../../scripts/run-lock.mjs';
import { harnessRoot, startFromTemplate } from '../template/index.js';
import { sliceTemplate } from '../integration/_m1a-slice.js';
import {
  serveGateway,
  useTestWrappingKey,
} from '../integration/_m3-gateway.js';

/** Browser files run only when asked. */
export const browserEnabled = process.env.THIX_HARNESS_BROWSER === '1';

const assetsDir = path.join(
  harnessRoot,
  'resources/agent-host/impl/gateway/assets',
);
const uiSrcDir = path.join(harnessRoot, 'ui');

/** Playwright's browser cache (its default location per platform). */
const playwrightCache = () =>
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright'));

/**
 * The Chromium executable to launch, or undefined.
 * @returns {Promise<string | undefined>}
 */
export const chromiumExecutable = async () => {
  const given = process.env.THIX_HARNESS_CHROMIUM;
  if (given) return existsSync(given) ? given : undefined;
  const { chromium } = await import('@playwright/test');
  const own = chromium.executablePath();
  if (own && existsSync(own)) return own;
  const cache = playwrightCache();
  if (!existsSync(cache)) return undefined;
  /** @param {string} prefix */
  const newest = prefix =>
    readdirSync(cache)
      .filter(name => name.startsWith(prefix))
      .sort(
        (a, b) =>
          Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)),
      );
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    ...newest('chromium_headless_shell-').map(dir =>
      path.join(
        cache,
        dir,
        process.platform === 'darwin'
          ? `chrome-headless-shell-mac-${arch}`
          : 'chrome-headless-shell-linux64',
        'chrome-headless-shell',
      ),
    ),
    ...newest('chromium-').map(dir =>
      process.platform === 'darwin'
        ? path.join(
            cache,
            dir,
            `chrome-mac${arch === 'arm64' ? '-arm64' : ''}`,
            'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          )
        : path.join(cache, dir, 'chrome-linux', 'chrome'),
    ),
  ];
  return candidates.find(file => existsSync(file));
};

/**
 * Why a browser file must skip, or undefined when it can run.
 * @returns {Promise<string | undefined>}
 */
export const browserSkipReason = async () => {
  if (!browserEnabled) return 'THIX_HARNESS_BROWSER=1 not set';
  if (!(await chromiumExecutable()))
    return 'no Chromium found: run `corepack yarn playwright install chromium-headless-shell` or set THIX_HARNESS_CHROMIUM';
  return undefined;
};

/** Newest modification time under a directory (ms). @param {string} dir */
const newestMtime = dir => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const time = entry.isDirectory()
      ? newestMtime(file)
      : statSync(file).mtimeMs;
    if (time > newest) newest = time;
  }
  return newest;
};

/**
 * Build the UI into the gateway's `assets/` when it is missing or older than
 * `ui/` (a stale shell would test old code).
 */
export const ensureUiBuilt = async () => {
  const shell = path.join(assetsDir, 'index.html');
  if (existsSync(shell) && statSync(shell).mtimeMs >= newestMtime(uiSrcDir))
    return { built: false };
  const { buildUi } = await import('../../ui/build.mjs');
  const result = await buildUi();
  return { built: true, bytes: result.bytes, gzipBytes: result.gzipBytes };
};

/**
 * A template by name: `m2` (the m1a/M2 slice template every M2 and M3
 * integration file uses) or `m3-300` (one imported 300-turn session); a
 * `Template` object is used as given.
 * @param {string | import('../template/index.js').Template} template
 */
export const templateNamed = async template => {
  if (typeof template !== 'string') return template;
  if (template === 'm2' || template === 'm1a') return sliceTemplate();
  if (template === 'm3-300') {
    const { ensureM3Template } = await import('../../perf/_m3-client.mjs');
    return ensureM3Template();
  }
  throw Error(`unknown state template ${template}`);
};

/**
 * @typedef {object} BrowserGateway
 * @property {any} page a Playwright Page on the sign-in URL
 * @property {string} url the fragment sign-in URL
 * @property {any} client a signed-in Node CapTP client
 * @property {() => Promise<void>} close
 * @property {Awaited<ReturnType<typeof startFromTemplate>>} state
 * @property {Awaited<ReturnType<typeof serveGateway>>} gateway
 * @property {any} browser
 * @property {(url?: string, before?: (page: any) => unknown) => Promise<any>} newPage
 *   a page in a new context (another device)
 */

/**
 * @param {object} options
 * @param {string | import('../template/index.js').Template} options.template
 * @param {(powers: { root: any, operator: any }) => Promise<void>} [options.provision]
 * @param {{ width: number, height: number }} [options.viewport] default 1280 x 800
 * @param {Parameters<typeof serveGateway>[1]} [options.gateway] more `serve`
 *   options (a fixed `port` for a test that restarts the daemon)
 * @param {() => void} [options.initScript] added to every browser context
 *   (`addInitScript`): runs in each page before its own scripts
 * @param {boolean} [options.lock] default true; false when the caller
 *   already holds the run lock in this process (a perf file's `runPerf`)
 * @returns {Promise<BrowserGateway>}
 */
export const startBrowserGateway = async ({
  template,
  provision,
  viewport = { width: 1280, height: 800 },
  gateway: gatewayOptions = {},
  initScript,
  lock: takeLock = true,
}) => {
  if (!browserEnabled)
    throw Error('startBrowserGateway needs THIX_HARNESS_BROWSER=1');
  const executablePath = await chromiumExecutable();
  if (!executablePath)
    throw Error(/** @type {string} */ (await browserSkipReason()));
  /** @type {(() => Promise<unknown>)[]} */
  const undo = [];
  const close = async () => {
    for (const step of undo.reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await step().catch(() => {});
    }
    undo.length = 0;
  };
  try {
    if (takeLock) {
      const lock = await acquireRunLock({ label: 'browser gateway' });
      undo.push(() => lock.release());
    }
    // Chromium first: Playwright turns on Node's async hooks (its zones use
    // AsyncLocalStorage), after which Node tags each promise it tracks with
    // an async id; a promise hardened before that point (a control
    // client's, a presence's) then throws "Cannot add property
    // Symbol(async_id_symbol)" when it settles (J-9603).
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ executablePath, headless: true });
    undo.push(() => browser.close());
    await ensureUiBuilt();
    const made = await templateNamed(template);
    const key = useTestWrappingKey('br');
    undo.push(async () => key.remove());
    const state = await startFromTemplate(made);
    undo.push(() => state.cleanup());
    if (provision) {
      const root = await state.client.call('lookup', names.harness);
      const operator = await E(root).getOperator();
      await provision({ root, operator });
    }
    const gateway = await serveGateway(state, gatewayOptions);
    const client = await gateway.connect();
    undo.push(async () => client.close());
    /**
     * @param {string} [at]
     * @param {(page: any) => unknown} [before] runs before the navigation
     *   (request listeners)
     */
    const newPage = async (at = undefined, before = undefined) => {
      const context = await browser.newContext({ viewport });
      if (initScript) await context.addInitScript(initScript);
      const opened = await context.newPage();
      if (before) await before(opened);
      await opened.goto(at ?? gateway.url);
      return opened;
    };
    const page = await newPage();
    return {
      page,
      url: gateway.url,
      client,
      close,
      state,
      gateway,
      browser,
      newPage,
    };
  } catch (error) {
    await close();
    throw error;
  }
};

/**
 * An init script (`startBrowserGateway({ initScript: trackSockets })`) that
 * records each page's WebSockets and the overlay texts it shows, for
 * reconnect tests:
 *
 * - `globalThis.thixTest.opens`: `Date.now()` of every WebSocket made;
 * - `thixTest.drop()`: close the newest socket from the page side (a lost
 *   connection as the page sees it);
 * - `thixTest.dropOnSubmit = 'before' | 'after'`: the next binary frame
 *   carrying a `submit` call is not sent (`before`) or is sent (`after`),
 *   and the socket is then closed (K3/K4 from the page);
 * - `thixTest.overlays`: `[ms, text]` of every overlay text shown.
 *
 * It runs before the page's lockdown, so the class and arrays it makes are
 * ordinary mutable objects of the page.
 */
export const trackSockets = () => {
  const g = /** @type {any} */ (globalThis);
  const Native = g.WebSocket;
  /** @type {any[]} */
  const sockets = [];
  const test = {
    opens: /** @type {number[]} */ ([]),
    overlays: /** @type {[number, string][]} */ ([]),
    /** @type {string | undefined} */
    dropOnSubmit: undefined,
    drop: () => sockets[sockets.length - 1]?.close(),
  };
  const decoder = new TextDecoder();
  class Tracked extends Native {
    /** @param {any[]} args */
    constructor(...args) {
      super(...args);
      sockets.push(this);
      test.opens.push(Date.now());
    }

    /** @param {any} data */
    send(data) {
      const mode = test.dropOnSubmit;
      if (mode && typeof data !== 'string') {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (decoder.decode(bytes).includes('"submit"')) {
          test.dropOnSubmit = undefined;
          if (mode === 'after') super.send(data);
          this.close();
          return;
        }
      }
      super.send(data);
    }
  }
  g.WebSocket = Tracked;
  g.thixTest = test;
  const watch = () => {
    let last = '';
    new MutationObserver(() => {
      const box = g.document.querySelector('.thix-overlay-box');
      const text = box ? box.textContent : '';
      if (text !== last) {
        last = text;
        test.overlays.push([Date.now(), text]);
      }
    }).observe(g.document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  if (g.document.readyState === 'loading')
    g.document.addEventListener('DOMContentLoaded', watch);
  else watch();
};
