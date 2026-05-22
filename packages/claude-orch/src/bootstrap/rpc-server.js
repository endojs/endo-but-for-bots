// @ts-check
/* global setTimeout, clearTimeout */
/**
 * @import {
 *   BootConfigMessage,
 *   HelloMessage,
 * } from '../../protocol.types.js'
 */

import net from 'node:net';
import { unlinkSync } from 'node:fs';

import { makePromiseKit } from '@endo/promise-kit';

/**
 * Best-effort `unlink(path)`. Used to clear stale UDS files left
 * behind by a prior boot attempt that crashed before its `close()`
 * could unlink the socket itself. Swallows ENOENT (no stale file)
 * and any other error — if the path is unreachable we'll surface
 * that on the subsequent `listen()` call instead.
 *
 * @param {string} path
 */
const tryUnlink = path => {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
};

/**
 * Bootstrap RPC server. Listens on the per-session ctl.sock UDS that the
 * QEMU chardev opens to expose virtserialport `orchestrator` to the guest
 * bootstrap init. Receives one Hello message, validates the boot nonce
 * via the supplied consumer, sends BootConfig, then closes the connection.
 *
 * Returns synchronously with two promises:
 *   - `ready` resolves when the UDS is actually bound (so callers can
 *     safely start the VM, knowing the guest will find an endpoint).
 *   - `hello` resolves with the HelloMessage when the handshake completes.
 *
 * @param {{
 *   ctlSocketPath: string,
 *   sessionId: string,
 *   consumeNonce: (sessionId: string, nonce: string) => Promise<boolean>,
 *   buildBootConfig: () => Promise<BootConfigMessage>,
 *   deadlineMs: number,
 * }} opts
 * @returns {{ ready: Promise<void>, hello: Promise<HelloMessage> }}
 */
export const awaitHello = ({
  ctlSocketPath,
  sessionId,
  consumeNonce,
  buildBootConfig,
  deadlineMs,
}) => {
  const helloKit = makePromiseKit();
  const readyKit = makePromiseKit();
  let settled = false;

  const server = net.createServer({ allowHalfOpen: true });

  /** @type {NodeJS.Timeout} */
  const timer = setTimeout(() => {
    cleanup(
      new Error(
        `Boot deadline (${deadlineMs}ms) exceeded for session ${sessionId}.`,
      ),
    );
  }, deadlineMs);

  /** @param {Error | null} err */
  const cleanup = err => {
    if (settled) return; // single-fire: don't reject after a successful Hello
    settled = true;
    clearTimeout(timer);
    server.close(() => {
      // Unlink the UDS file on close so a subsequent retry can rebind
      // cleanly. Without this, a session that times out on the first
      // boot attempt leaves a stale `ctl.sock` and the next attempt
      // hits EADDRINUSE on `listen()`.
      tryUnlink(ctlSocketPath);
    });
    if (err) {
      helloKit.reject(err);
      readyKit.reject(err);
    }
  };

  server.once('error', cleanup);

  server.once('connection', conn => {
    conn.on('error', () => {
      // The peer (guest) may RST the connection on teardown; suppress.
    });
    let buf = '';
    conn.on('data', async chunk => {
      buf += chunk.toString('utf8');
      const newline = buf.indexOf('\n');
      if (newline < 0) return;

      const line = buf.slice(0, newline);
      buf = buf.slice(newline + 1);

      try {
        const msg = /** @type {HelloMessage} */ (JSON.parse(line));
        if (msg.type !== 'hello') {
          throw new Error(`Expected hello, got ${msg.type}`);
        }
        if (msg.sessionId !== sessionId) {
          throw new Error(
            `Hello sessionId mismatch: ${msg.sessionId} != ${sessionId}`,
          );
        }
        // `consumeNonce` returns Promise<boolean> — it awaits a
        // disk flush so the consumed-nonce flag is durable before
        // we hand back a BootConfig.
        if (!(await consumeNonce(sessionId, msg.bootNonce))) {
          throw new Error(`Invalid or replayed boot nonce for ${sessionId}`);
        }
        const bootConfig = await buildBootConfig();
        conn.write(`${JSON.stringify(bootConfig)}\n`, () => {
          conn.end();
        });
        clearTimeout(timer);
        server.close();
        settled = true;
        helloKit.resolve(msg);
      } catch (e) {
        conn.destroy();
        cleanup(/** @type {Error} */ (e));
      }
    });
    conn.once('close', () => {
      // If hello hasn't resolved by now, treat as a boot failure.
      cleanup(
        new Error(
          `Bootstrap connection closed before Hello for session ${sessionId}.`,
        ),
      );
    });
  });

  // Clear any stale UDS left over from a prior boot attempt that
  // crashed before cleanup could unlink it.
  tryUnlink(ctlSocketPath);
  server.listen(ctlSocketPath, () => readyKit.resolve(undefined));
  return harden({
    ready: /** @type {Promise<void>} */ (readyKit.promise),
    hello: /** @type {Promise<HelloMessage>} */ (helloKit.promise),
  });
};
harden(awaitHello);
