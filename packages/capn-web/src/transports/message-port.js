// MessagePort transport for Cap'n Web.  One postMessage per RPC message.
//
// Works with browser MessageChannel ports, Web Workers, and node
// worker_threads ports.
//
// Wire encoding: cloudflare/capnweb's MessagePort transport uses the
// "structuredClonable" encoding level (capnweb >= 0.9.0) — it posts the live
// devalued message *object* (relying on structured clone to carry bigint,
// Date, undefined and Uint8Array natively) rather than a JSON string.  To
// interoperate, this transport does the same:
//
//   * send: the session hands us a JSON string; we post its parsed object.
//     capnweb's evaluator accepts our tuple forms (base64 `["bytes", …]`,
//     `["date", ms]`, `["bigint", str]`, `["undefined"]`, `["nan"]`, …) at
//     every encoding level, so no per-value re-encoding is needed here.
//   * receive: a structured-clonable peer may hand us native bigint / Date /
//     undefined / non-finite numbers and `["bytes", <Uint8Array>]`.  We fold
//     those leaves back into the port's JSON tuple grammar before handing the
//     stringified message to the session's evaluator.
//
// A received `null` is the peer's end-of-stream signal (capnweb posts it on
// abort); we treat it as a transport close.

import harden from '@endo/harden';

import { bytesToBase64 } from '../special-values.js';

/**
 * Fold a structured-clonable value from a capnweb peer back into the JSON
 * tuple grammar the session's evaluator expects.  Only the leaf types that
 * capnweb's `structuredClonable` level leaves native are rewritten; tuple and
 * record structure is preserved by recursion, so a peer that already speaks
 * the JSON tuple forms round-trips unchanged.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
const nativeToTuple = v => {
  if (v === undefined) return ['undefined'];
  if (v === null) return null;
  const t = typeof v;
  if (t === 'bigint') return ['bigint', String(v)];
  if (t === 'number') {
    if (Number.isNaN(v)) return ['nan'];
    if (v === Infinity) return ['inf'];
    if (v === -Infinity) return ['-inf'];
    return v;
  }
  if (t !== 'object') return v; // string, boolean
  if (v instanceof Date) {
    const ms = v.getTime();
    return ['date', Number.isNaN(ms) ? null : ms];
  }
  if (v instanceof Uint8Array) return ['bytes', bytesToBase64(v)];
  if (Array.isArray(v)) {
    // capnweb encodes a byte array as ["bytes", <Uint8Array>]; convert the
    // payload here so the generic recursion below can't double-wrap it.
    if (v.length === 2 && v[0] === 'bytes' && v[1] instanceof Uint8Array) {
      return ['bytes', bytesToBase64(v[1])];
    }
    return v.map(nativeToTuple);
  }
  // Plain record: rewrite each value.
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(/** @type {object} */ (v))) {
    out[k] = nativeToTuple(/** @type {any} */ (v)[k]);
  }
  return out;
};

/**
 * Normalise an incoming `postMessage` payload to the JSON string the session
 * consumes.  Strings pass through (a peer already speaking JSON); objects are
 * folded through {@link nativeToTuple} and stringified.
 *
 * @param {unknown} data
 * @returns {string}
 */
const incomingToJson = data =>
  typeof data === 'string' ? data : JSON.stringify(nativeToTuple(data));

/**
 * @param {any} port
 * @returns {import('../types.js').RpcTransport}
 */
export const makeMessagePortTransport = port => {
  /** @type {string[]} */
  const buffer = [];
  /** @type {Array<(s: string | null) => void>} */
  const waiters = [];
  let closed = false;

  const closeAndWake = () => {
    if (closed) return;
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  };

  const handler = ev => {
    const raw = ev?.data;
    // A null payload is the peer's end-of-stream (capnweb posts it on abort).
    if (raw === null) {
      closeAndWake();
      return;
    }
    const data = incomingToJson(raw);
    const w = waiters.shift();
    if (w) {
      w(data);
      return;
    }
    buffer.push(data);
  };

  if (typeof port.addEventListener === 'function') {
    // Browser-style MessagePort / Web Worker.
    port.addEventListener('message', handler);
    port.addEventListener('messageerror', closeAndWake);
    port.addEventListener('close', closeAndWake);
    if (typeof port.start === 'function') port.start();
  } else if (typeof port.on === 'function') {
    // Node worker_threads MessagePort.
    port.on('message', data => handler({ data }));
    port.on('messageerror', closeAndWake);
    port.on('close', closeAndWake);
  }

  return harden({
    send: m => {
      if (closed) return;
      // The session hands us a JSON string; post the parsed object so a
      // structured-clonable peer (capnweb >= 0.9.0) receives a message
      // object rather than a string.  postMessage may throw synchronously
      // if the port is closed; treat any failure as a transport close so
      // the session can recover.
      try {
        port.postMessage(typeof m === 'string' ? JSON.parse(m) : m);
      } catch (_e) {
        closeAndWake();
      }
    },
    receive: () => {
      if (buffer.length > 0) return Promise.resolve(buffer.shift() ?? null);
      if (closed) return Promise.resolve(null);
      return new Promise(resolve => waiters.push(resolve));
    },
    abort: () => {
      closeAndWake();
      try {
        if (typeof port.close === 'function') port.close();
      } catch (_e) {
        /* ignore */
      }
    },
  });
};
harden(makeMessagePortTransport);
