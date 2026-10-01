// @ts-check
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import * as readline from 'node:readline';
import * as nodeTimers from 'node:timers';
import * as url from 'node:url';
import * as util from 'node:util';

// Powers whose implementation is already portable: they take plain
// functions, so the Node host only has to supply them.
import { makeDisplayPowers } from '../display.js';
import { makeEnvironmentPowers } from '../environment.js';
import { makeLogPowers } from '../logging.js';
import { makePathPowers } from '../paths.js';
import { makeRandomPowers } from '../random.js';
import { MAX_TIMER_DELAY_MS, makeTimerPowers } from '../timers.js';

// Powers with a Node-specific implementation, each the sole module allowed
// to see the corresponding Node API.
import { makeFilePowers } from './files.js';
import { makeHashPowers } from './hashes.js';
import { makeProcessPowers } from './processes.js';
import { makeNativeWorkerPowers } from './native-workers.js';
import { makeSocketPowers } from './sockets.js';
import { makeSyncFilePowers } from './sync-files.js';
import { makeTerminalPowers } from './terminal.js';

/** @import { PlatformPowers } from '../powers.js' */
/** @typedef {import('../timers.js').TimerHandle} TimerHandle */

/**
 * Construct the Node host's platform authority at its composition boundary.
 * Every member is a minimal capability object with plain return values, and
 * core factories receive only the members they name; the record itself is a
 * convenience for entry points, never a parameter to core.
 *
 * @returns {PlatformPowers}
 */
export const makeNodePowers = () => {
  /** @type {Map<TimerHandle, NodeJS.Timeout>} */
  const timers = new Map();
  const timerPowers = makeTimerPowers({
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    setTimer: (callback, delayMs) => {
      // Node would silently treat a wider or non-finite delay as about a
      // millisecond; fail here instead, where the port documents the bound.
      (Number.isFinite(delayMs) &&
        delayMs >= 0 &&
        delayMs <= MAX_TIMER_DELAY_MS) ||
        Fail`Timer delay ${q(delayMs)} must be between 0 and ${q(
          MAX_TIMER_DELAY_MS,
        )} milliseconds`;
      const token = harden({});
      const timer = nodeTimers.setTimeout(() => {
        timers.delete(token);
        callback();
      }, delayMs);
      timers.set(token, timer);
      return token;
    },
    clearTimer: token => {
      const timer = timers.get(token);
      if (timer !== undefined) nodeTimers.clearTimeout(timer);
      timers.delete(token);
    },
    unrefTimer: token => {
      timers.get(token)?.unref();
    },
  });
  const random = makeRandomPowers({
    randomBytes: length => new Uint8Array(crypto.randomBytes(length)),
  });
  // OCapN's info channel traces every frame and session step, so it is off
  // unless the operator asks for it. Nothing below this line gets to make
  // that decision again: libraries pass the logger through as given.
  const traced = process.env.THIXOTROPE_TRACE !== undefined;
  const logging = makeLogPowers({
    log: (...args) => console.log(...args),
    info: traced ? (...args) => console.error(...args) : () => {},
    error: (...args) => console.error(...args),
  });
  const paths = makePathPowers({
    join: (...parts) => path.join(...parts),
    dirname: p => path.dirname(p),
    resolve: (...parts) => path.resolve(...parts),
    isAbsolute: p => path.isAbsolute(p),
    fileURLToPath: u => url.fileURLToPath(u),
    pathToFileURL: p => url.pathToFileURL(p).href,
  });
  const randomUUID = () => crypto.randomUUID();
  const getUserId = () => process.getuid?.();
  const files = makeFilePowers({
    fsp,
    createReadStream: p => fs.createReadStream(p),
    dirname: p => path.dirname(p),
    randomUUID,
    getUserId,
  });
  const syncFiles = makeSyncFilePowers({
    fs,
    dirname: p => path.dirname(p),
    randomUUID,
    getUserId,
  });
  const processes = makeProcessPowers({ childProcess, readline });
  const sockets = makeSocketPowers({
    net,
    chmod: (p, mode) => fsp.chmod(p, mode),
  });
  const terminal = makeTerminalPowers({ readline, process });
  const hashes = makeHashPowers({
    createHash: algorithm => crypto.createHash(algorithm),
    readChunks: files.readChunks,
  });
  const environment = makeEnvironmentPowers({
    get: name => process.env[name],
  });
  const display = makeDisplayPowers({
    describe: value =>
      util.inspect(value, { customInspect: false, getters: false, depth: 3 }),
  });
  // The compartment mapper is heavy and only needed to install something,
  // so load it on first use to keep ordinary startup light.
  const loadBundler = async () => {
    const [{ makeBundlerPowers }, { makeReadPowers }] = await Promise.all([
      import('../bundler.js'),
      import('@endo/compartment-mapper/node-powers.js'),
    ]);
    return makeBundlerPowers({
      readPowers: makeReadPowers({ fs, path, url, crypto }),
      pathToFileURL: paths.pathToFileURL,
      resolve: (...parts) => path.resolve(...parts),
      sha256Hex: hashes.sha256Hex,
    });
  };
  const bundler = harden({
    bundle: async file => {
      const loaded = await loadBundler();
      return loaded.bundle(file);
    },
    bundleNative: async file => {
      const loaded = await loadBundler();
      return loaded.bundleNative(file);
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
    nativeWorkers: makeNativeWorkerPowers({ timers: timerPowers }),
    sockets,
    terminal,
    hashes,
    environment,
    display,
    bundler,
  });
};
harden(makeNodePowers);

/** @typedef {PlatformPowers} NodePowers */
