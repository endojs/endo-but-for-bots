// @ts-check

/* global setTimeout, clearTimeout, Buffer */

/**
 * @file Endo daemon plugin: unconfined DBus socket layer.
 *
 * Provides raw Unix socket I/O with D-Bus SASL EXTERNAL authentication.
 * Must be loaded as an unconfined plugin because it accesses the
 * filesystem (Unix domain socket).
 *
 * ```sh
 * endo make --UNCONFINED src/dbus-sock.js -n dbus-sock
 * ```
 *
 * The returned `DBusSock` remotable exposes `connect`, `authenticate`,
 * `callMethod`, `readMessage`, and `close`. `make()` requires `UID` in its injected
 * `env` option and derives the session bus path as `/run/user/<uid>/bus`.
 */

/** @import { DBusSock } from './types.js' */
/** @import { Socket } from 'node:net' */

import { decodeBase64, encodeBase64 } from '@endo/base64';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import net from 'node:net';
import { buildHelloPayload, withSerial } from './dbus-msg.js';

/**
 * @typedef {{
 *   setTimeout: (callback: () => void, timeoutMs: number) => unknown,
 *   clearTimeout: (token: unknown) => void,
 * }} TimerPowers
 */

const DEFAULT_TIMER_POWERS = /** @type {TimerPowers} */ (
  harden({ setTimeout, clearTimeout })
);

const { Fail } = assert;

/**
 * @param {string | undefined} uidText
 * @returns {number}
 */
const parseUid = uidText => {
  uidText !== undefined || Fail`UID must be set in the environment`;
  const uid = Number(uidText);
  (Number.isSafeInteger(uid) && uid >= 0) ||
    Fail`UID must be a non-negative integer: ${uidText}`;
  return uid;
};
harden(parseUid);

/** Interface for the raw D-Bus socket capability. */
const DBusSockI = M.interface('DBusSock', {
  connect: M.callWhen().returns(M.undefined()),
  authenticate: M.callWhen().returns(M.undefined()),
  hello: M.callWhen().returns(M.undefined()),
  callMethod: M.callWhen(M.string()).optional(M.number()).returns(M.string()),
  readMessage: M.callWhen().optional(M.number()).returns(M.string()),
  close: M.callWhen().returns(M.undefined()),
});

/**
 * @param {Socket} socket
 * @param {number} timeoutMs
 * @param {TimerPowers} [timerPowers]
 * @returns {Promise<Buffer>}
 */
export const firstData = (
  socket,
  timeoutMs,
  timerPowers = DEFAULT_TIMER_POWERS,
) =>
  new Promise(
    /** @type {(res: (val: Buffer) => void) => void} */ (
      (resolve, reject) => {
        let timer;
        const onError = error => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          socket.off('data', onData);
          socket.off('error', onError);
          if (timer !== undefined) {
            timerPowers.clearTimeout(timer);
          }
        };
        const onData = data => {
          cleanup();
          resolve(data);
        };
        socket.on('data', onData);
        socket.on('error', onError);
        timer = timerPowers.setTimeout(() => {
          cleanup();
          reject(Error('D-Bus reply timeout'));
        }, timeoutMs);
      }
    ),
  );
harden(firstData);

/**
 * Check whether a reply buffer represents a method-return (type byte 2).
 * @param {Buffer} data
 * @returns {boolean}
 */
const isMethodReturn = data => data.length >= 2 && data[1] === 2;

/**
 * Create a fresh DBusSocket.
 *
 * The daemon invokes this `make` export and stores the returned
 * remotable under the configured pet name (e.g. "dbus-sock").
 *
 * @param {unknown} [_powers]
 * @param {unknown} [_context]
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {DBusSock}
 */
export const make = (
  _powers = undefined,
  _context = undefined,
  options = {},
) => {
  const { env = {} } = options;
  const uid = parseUid(env.UID);
  const path = `/run/user/${uid}/bus`;
  let connected = false;
  let nextSerial = 1;
  /** @type {Record<string, PromiseWithResolvers<Socket>>} */
  const state = {
    connect: Promise.withResolvers(),
    auth: Promise.withResolvers(),
    hello: Promise.withResolvers(),
  };

  // @ts-expect-error — M.callWhen in interface guards is a documented caveat
  return makeExo('DBusSock', DBusSockI, {
    /**
     * Connect to a D-Bus bus socket.
     * @returns {Promise<void>}
     */
    async connect() {
      if (connected) {
        return;
      }
      const sock = net.createConnection(path);
      await /** @type {Promise<void>} */ (
        new Promise((resolve, reject) => {
          sock.once('connect', () => resolve(undefined));
          sock.once('error', reject);
        })
      );
      state.connect.resolve(sock);
      connected = true;
    },

    /**
     * Perform SASL EXTERNAL authentication.
     * @returns {Promise<void>}
     */
    async authenticate() {
      const socket = await state.connect.promise;
      const uidHex = Buffer.from(String(uid)).toString('hex');
      socket.write(`\0AUTH EXTERNAL ${uidHex}\r\n`);
      socket.write('NEGOTIATE_UNIX_FD\r\n');
      socket.write('BEGIN\r\n');

      await firstData(socket, 2000);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await firstData(socket, 10);
        } catch {
          break;
        }
      }
      state.auth.resolve(socket);
    },

    /**
     * Send the initial D-Bus `Hello` method.
     * @returns {Promise<void>}
     */
    async hello() {
      const socket = await state.auth.promise;
      const helloBytes = withSerial(buildHelloPayload(), nextSerial);
      nextSerial += 1;
      const helloBuf = Buffer.from(
        helloBytes.buffer,
        helloBytes.byteOffset,
        helloBytes.byteLength,
      );
      socket.write(helloBuf);
      const helloData = await firstData(socket, 3000);
      if (!isMethodReturn(helloData)) {
        throw Error('D-Bus method call rejected');
      }
      state.hello.resolve(socket);
    },

    /**
     * Send a D-Bus method call and return the reply body bytes.
     * @param {string} payload
     * @param {number} [timeoutMs]
     * @returns {Promise<string>}
     */
    async callMethod(payload, timeoutMs = 3000) {
      const socket = await state.hello.promise;
      const payloadBytes = withSerial(decodeBase64(payload), nextSerial);
      nextSerial += 1;
      const buf = Buffer.from(
        payloadBytes.buffer,
        payloadBytes.byteOffset,
        payloadBytes.byteLength,
      );
      socket.write(buf);
      const data = await firstData(socket, timeoutMs);
      if (!isMethodReturn(data)) {
        throw Error('D-Bus method call rejected');
      }
      return encodeBase64(new Uint8Array(data));
    },

    /**
     * Read the next raw D-Bus message from the socket.
     * @param {number} [timeoutMs]
     * @returns {Promise<string>}
     */
    async readMessage(timeoutMs = 3000) {
      const socket = await state.hello.promise;
      const data = await firstData(socket, timeoutMs);
      return encodeBase64(new Uint8Array(data));
    },

    /**
     * Close the D-Bus socket.
     * @returns {void}
     */
    close() {
      if (connected) {
        connected = false;
        state.connect.promise.then(sock => sock.destroy()).catch(_ => {});
      }
    },
  });
};
harden(make);
