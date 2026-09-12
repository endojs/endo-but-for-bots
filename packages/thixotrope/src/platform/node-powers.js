// @ts-check
import harden from '@endo/harden';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import * as readline from 'node:readline';
import * as nodeTimers from 'node:timers';
import * as url from 'node:url';
import * as util from 'node:util';

import { makeDisplayPowers } from './display.js';
import { makeEnvironmentPowers, makeUserPowers } from './environment.js';
import { makeFilePowers } from './files.js';
import { makeHashPowers } from './hashes.js';
import { makeHttpListenerPowers } from './http-listeners.js';
import { makeLogPowers } from './logging.js';
import { makePathPowers } from './paths.js';
import { makeProcessPowers } from './processes.js';
import { makeRandomPowers } from './random.js';
import { makeSocketPowers } from './sockets.js';
import { makeSyncFilePowers } from './sync-files.js';
import { makeTerminalPowers } from './terminal.js';
import { makeTimerPowers } from './timers.js';

/** @typedef {import('./timers.js').TimerHandle} TimerHandle */

/**
 * Construct the Node host's platform authority at its composition boundary.
 * Every member is a minimal capability object with plain return values, and
 * core factories receive only the members they name; the record itself is a
 * convenience for entry points, never a parameter to core.
 */
export const makeNodePowers = () => {
  const timerPowers = makeTimerPowers({
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    setTimer: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
    clearTimer: handle =>
      nodeTimers.clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
    unrefTimer: handle => /** @type {NodeJS.Timeout} */ (handle).unref?.(),
  });
  const random = makeRandomPowers({
    randomBytes: length => new Uint8Array(crypto.randomBytes(length)),
  });
  const logging = makeLogPowers({
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
  });
  const paths = makePathPowers({
    join: (...parts) => path.join(...parts),
    dirname: p => path.dirname(p),
    resolve: (...parts) => path.resolve(...parts),
    isAbsolute: p => path.isAbsolute(p),
    fileURLToPath: u => url.fileURLToPath(u),
    pathToFileURL: p => url.pathToFileURL(p),
  });
  const files = makeFilePowers({
    fsp,
    createReadStream: p => fs.createReadStream(p),
    dirname: p => path.dirname(p),
  });
  const syncFiles = makeSyncFilePowers({
    fs,
    dirname: p => path.dirname(p),
  });
  const processes = makeProcessPowers({ childProcess, readline });
  const sockets = makeSocketPowers({
    net,
    chmod: (p, mode) => fsp.chmod(p, mode),
  });
  const httpListeners = makeHttpListenerPowers({
    http,
    setTimeout: (callback, delayMs) => nodeTimers.setTimeout(callback, delayMs),
    clearTimeout: handle =>
      nodeTimers.clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
  });
  const terminal = makeTerminalPowers({ readline, process });
  const hashes = makeHashPowers({ files });
  const environment = makeEnvironmentPowers({
    get: name => process.env[name],
  });
  const user = makeUserPowers({ getUserId: () => process.getuid?.() });
  const display = makeDisplayPowers({
    describe: value =>
      util.inspect(value, { customInspect: false, getters: false, depth: 3 }),
  });
  const bundler = harden({
    // The compartment mapper is heavy and only needed to install an
    // application, so load it on first use to keep ordinary startup light.
    bundle: async file => {
      const [{ makeBundlerPowers }, { makeReadPowers }] = await Promise.all([
        import('./bundler.js'),
        import('@endo/compartment-mapper/node-powers.js'),
      ]);
      const bundlerPowers = makeBundlerPowers({
        readPowers: makeReadPowers({ fs, path, url, crypto }),
        pathToFileURL: p => url.pathToFileURL(p),
        resolve: (...parts) => path.resolve(...parts),
        sha256Hex: hashes.sha256Hex,
      });
      return bundlerPowers.bundle(file);
    },
  });
  return harden({
    timers: timerPowers,
    random,
    logging,
    paths,
    files,
    syncFiles,
    processes,
    sockets,
    httpListeners,
    terminal,
    hashes,
    environment,
    user,
    display,
    bundler,
  });
};
harden(makeNodePowers);

/** @typedef {ReturnType<typeof makeNodePowers>} NodePowers */
