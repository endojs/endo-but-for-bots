// @ts-check
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';
import harden from '@endo/harden';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import * as readline from 'node:readline';
import * as timers from 'node:timers';
import * as url from 'node:url';
import * as util from 'node:util';

/**
 * Wrap host functions so hardening the capability record never traverses Node's
 * mutable prototypes or constructor properties.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @returns {F}
 */
const wrap = fn =>
  /** @type {F} */ ((...args) => Reflect.apply(fn, undefined, args));

/**
 * Construct the Node host's platform authority at its composition boundary.
 * Core factories receive this record explicitly; importing core grants no I/O.
 * Accessors expose mutable streams without recursively freezing Node internals.
 */
export const makeNodePowers = () =>
  harden({
    childProcess: { spawn: wrap(childProcess.spawn) },
    crypto: {
      createHash: wrap(crypto.createHash),
      randomBytes: wrap(crypto.randomBytes),
      randomFillSync: wrap(crypto.randomFillSync),
    },
    fs: {
      appendFileSync: wrap(fs.appendFileSync),
      closeSync: wrap(fs.closeSync),
      existsSync: wrap(fs.existsSync),
      fsyncSync: wrap(fs.fsyncSync),
      mkdirSync: wrap(fs.mkdirSync),
      openSync: wrap(fs.openSync),
      readdirSync: wrap(fs.readdirSync),
      readFileSync: wrap(fs.readFileSync),
      renameSync: wrap(fs.renameSync),
      rmSync: wrap(fs.rmSync),
      writeFileSync: wrap(fs.writeFileSync),
      statSync: wrap(fs.statSync),
      createReadStream: wrap(fs.createReadStream),
    },
    fsPromises: {
      chmod: wrap(fsPromises.chmod),
      mkdtemp: wrap(fsPromises.mkdtemp),
      realpath: wrap(fsPromises.realpath),
      lstat: wrap(fsPromises.lstat),
      mkdir: wrap(fsPromises.mkdir),
      open: wrap(fsPromises.open),
      readFile: wrap(fsPromises.readFile),
      readdir: wrap(fsPromises.readdir),
      rename: wrap(fsPromises.rename),
      rm: wrap(fsPromises.rm),
      copyFile: wrap(fsPromises.copyFile),
    },
    http: { createServer: wrap(http.createServer) },
    net: {
      createServer: wrap(net.createServer),
      createConnection: wrap(net.createConnection),
    },
    path: {
      join: wrap(path.join),
      resolve: wrap(path.resolve),
      dirname: wrap(path.dirname),
      isAbsolute: wrap(path.isAbsolute),
    },
    readline: { createInterface: wrap(readline.createInterface) },
    timers: {
      setTimeout: wrap(timers.setTimeout),
      clearTimeout: wrap(timers.clearTimeout),
      setImmediate: wrap(timers.setImmediate),
    },
    url: {
      fileURLToPath: wrap(url.fileURLToPath),
      pathToFileURL: wrap(url.pathToFileURL),
    },
    util: { inspect: wrap(util.inspect) },
    performance: { now: () => performance.now() },
    now: () => Date.now(),
    randomBytes: (/** @type {number} */ length) =>
      new Uint8Array(crypto.randomBytes(length)),
    console: {
      log: (...args) => console.log(...args),
      error: (...args) => console.error(...args),
    },
    process: {
      getuid: process.getuid?.bind(process),
      get env() {
        return process.env;
      },
      get stdin() {
        return process.stdin;
      },
      get stdout() {
        return process.stdout;
      },
      once: process.once.bind(process),
      removeListener: process.removeListener.bind(process),
    },
    readPowers: makeReadPowers({ fs, path, url, crypto }),
  });
harden(makeNodePowers);
/** @typedef {ReturnType<typeof makeNodePowers>} NodePowers */
