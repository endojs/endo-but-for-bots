// @ts-check

/**
 * XS bootstrap entry for an OCapN-native thixotrope worker (protocol
 * unification phase 2): the module bundled by
 * `scripts/bundle-xs-worker.mjs` into `dist-xs/worker-peer.js` and
 * evaluated inside the XS machine by the `thixotrope-xs-worker` binary,
 * after the lockdown boot script.
 *
 * The duct to the host carries ASCII JSON envelopes over the binary's
 * existing deliver/outbound protocol:
 * - `{ t: 'init', workerId, debugLabel? }` — first message; boots the
 *   worker peer (the OCapN client cannot exist before the worker id is
 *   known, since pipe identity derives from it).
 * - `{ t: 'f', b64 }` — one binary OCapN frame, base64-encoded (the
 *   duct is ASCII-only so CESU-8/UTF-8/C strings coincide).
 *
 * Outbound frames use the same `{ t: 'f', b64 }` envelope through
 * `thixotropeSend`. Everything reachable from here lives in the XS heap
 * and is captured by the engine snapshot; this module runs only on
 * first boot, never on restore.
 */
import '@endo/eventual-send/shim.js';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import harden from '@endo/harden';

import { makeLogPowers } from '../platform/logging.js';
import { makeWorkerPeer } from './worker-peer.js';

const send = /** @type {(json: string) => void} */ (
  /** @type {any} */ (globalThis).thixotropeSend
);
if (typeof send !== 'function') {
  throw Error(
    'thixotrope-xs-worker must register thixotropeSend before bootstrap',
  );
}

const nativeTrace = /** @type {any} */ (globalThis).thixotropeTrace;
// The bootstrap alone obtains engine-provided entropy and diagnostics.
const cryptoPower = globalThis.crypto;
/** @param {...unknown} args */
const trace = (...args) => {
  if (typeof nativeTrace === 'function') {
    nativeTrace(args.map(String).join(' '));
  }
};
/** @param {number} length */
const randomBytes = length =>
  cryptoPower.getRandomValues(new Uint8Array(length));
/**
 * The last error the peer logged, kept for the fatal report below.
 * @type {string | undefined}
 */
let lastError;
/** @param {...unknown} args */
const traceError = (...args) => {
  lastError = args
    .map(arg =>
      arg instanceof Error && arg.cause !== undefined
        ? `${arg} (cause: ${arg.cause})`
        : String(arg),
    )
    .join(' ');
  trace(...args);
};
const powers = harden({
  random: harden({ randomBytes }),
  logging: makeLogPowers({ log: trace, info: trace, error: traceError }),
});

/**
 * Set when the OCapN session toward the host ends inside this worker, for
 * example when its frame pump fails to decode a frame (a record whose keys
 * exhaust the vat's property-key table throws a RangeError there, after the
 * duct delivery that carried it has returned). The worker can then answer
 * nothing more, so the crank that ended the session must not complete: the
 * outbound read below throws, the crank halts, and the host records the
 * failure and retires the session, breaking every pending answer, instead
 * of a vat that is awake but silent.
 * @type {Error | undefined}
 */
let sessionEnded;
const onSessionEnd = () => {
  sessionEnded = Error(
    `thixotrope worker peer: the OCapN session to the host ended${
      lastError === undefined ? '' : ` after: ${lastError}`
    }`,
  );
};
const takeOutbound = /** @type {any} */ (globalThis).thixotropeTakeOutbound;
if (typeof takeOutbound === 'function') {
  /** @type {any} */ (globalThis).thixotropeTakeOutbound = () => {
    if (sessionEnded !== undefined) throw sessionEnded;
    return takeOutbound();
  };
}

/** @type {{ deliver: (bytes: Uint8Array) => void } | undefined} */
let peer;
/** @type {Array<Uint8Array>} */
const pendingFrames = [];

/** @param {string} json */
const dispatch = json => {
  const message = JSON.parse(json);
  if (message.t === 'init') {
    if (peer !== undefined) {
      throw Error('thixotrope worker peer: duplicate init');
    }
    makeWorkerPeer(powers, {
      workerId: message.workerId,
      debugLabel: message.debugLabel,
      send: frame => send(JSON.stringify({ t: 'f', b64: encodeBase64(frame) })),
      onSessionEnd,
    }).then(readyPeer => {
      peer = readyPeer;
      for (const frame of pendingFrames) {
        peer.deliver(frame);
      }
      pendingFrames.length = 0;
    });
    return;
  }
  if (message.t === 'f') {
    if (sessionEnded !== undefined) throw sessionEnded;
    const frame = decodeBase64(message.b64);
    if (peer === undefined) {
      // Frames can land while the async peer boot settles; they drain
      // in order the moment it does.
      pendingFrames.push(frame);
    } else {
      peer.deliver(frame);
    }
    return;
  }
  throw Error(`thixotrope worker peer: unknown duct message ${message.t}`);
};

/** @type {any} */ (globalThis).thixotropeDispatch = dispatch;
