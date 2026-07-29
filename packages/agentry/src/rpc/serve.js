// @ts-check
/// <reference types="ses"/>
/* eslint-disable no-await-in-loop */

/**
 * Wire the RPC bridge to a byte stream pair.
 *
 * `serveRpc` reads LF-delimited JSON commands from `input`, dispatches
 * them through {@link makeRpcBridge}, and writes LF-delimited JSON events
 * to `output`. Diagnostics go to the separate `errorOutput` so the
 * protocol stream on `output` stays clean, exactly as the design
 * requires (logs on stderr, protocol on stdout).
 */

import { encodeRecord, makeJsonlDecoder } from './framing.js';
import { makeRpcBridge } from './bridge.js';

/** @import { RpcEvent, Session } from './types.js' */

/**
 * @typedef {object} WritableLike
 * @property {(text: string) => unknown} write
 */

/**
 * @param {object} options
 * @param {AsyncIterable<string | Uint8Array>} options.input
 * @param {WritableLike} options.output
 * @param {WritableLike} [options.errorOutput]
 * @param {Session} options.session
 * @returns {Promise<void>}
 */
export const serveRpc = async ({ input, output, errorOutput, session }) => {
  const decoder = makeJsonlDecoder();

  /** @param {RpcEvent} record */
  const write = record => {
    let line;
    try {
      line = encodeRecord(record);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      line = encodeRecord({
        type: 'error',
        message: `failed to encode ${record.type} event: ${message}`,
      });
    }
    output.write(line);
  };

  const bridge = makeRpcBridge({
    session,
    write,
    log: message => {
      if (errorOutput) {
        errorOutput.write(`${message}\n`);
      }
    },
  });

  await null;
  try {
    for await (const chunk of input) {
      for (const line of decoder.push(chunk)) {
        await bridge.handleLine(line);
      }
    }
    for (const line of decoder.flush()) {
      await bridge.handleLine(line);
    }
  } finally {
    bridge.close();
  }
};
harden(serveRpc);
