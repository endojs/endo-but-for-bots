// @ts-check
/**
 * The gateway's CapTP bridge (M3 W3.2; designs/m3-interfaces.md D-M3-1,
 * D-M3-2, 4.2, 4.4, 4.5).
 *
 * One `@endo/captp` connection per WebSocket, with the connection's
 * `GatewayBootstrap` as the answer of `CTP_BOOTSTRAP`. Pass-through: every
 * object a call answers (a vat presence or a gateway-local exo) is exported
 * to the browser as it is, and a browser call on it is forwarded to it
 * unchanged; there is no per-interface method table.
 *
 * Every message is parsed here and every `CTP_CALL` is checked on its
 * encoded form (`guard.js`) **before** captp decodes it; a refused call is
 * answered with a `CTP_RETURN` exception carrying the text, nothing reaches
 * the target, and the connection stays open. Before `fetch` has answered
 * powers only `CTP_BOOTSTRAP` and a `fetch` call on the bootstrap are
 * dispatched; a connection that has not signed in within
 * `signInDeadlineMs` is closed (`closeCodes.signInDeadline`). A frame that
 * is not CapTP JSON (a text frame, bad UTF-8, bad JSON, an unknown or
 * malformed message) closes the connection (`closeCodes.protocol`).
 *
 * The bridge keeps captp's export table through captp's
 * `makeCapTPImportExportTables` hook (the default tables, observed), so it
 * knows exactly which value each live export slot is (rule 1, the frame
 * guard's `LargeCall` identity) and how many there are: more than
 * `exportsPerConnection` closes the connection
 * (`closeCodes.tooManyObjects`; nothing more is sent on it).
 *
 * Answers are bounded too (`answersPerConnection`): the bridge mirrors
 * captp's answer table (one entry per page question, until the page drops
 * it with `CTP_DROP`; a page's captp does so when the question's promise is
 * collected). When a new question would exceed the bound, the oldest
 * settled answer is forgotten on both sides: the bridge dispatches the same
 * `CTP_DROP` the page would have sent, so captp releases the answer and its
 * payload. A page that pipelines on a forgotten answer gets the unknown
 * target refusal; a well-behaved page holds far fewer live questions than
 * the bound and is never closed for it. Only a connection whose kept
 * answers are all unsettled when the bound is reached is closed
 * (`closeCodes.tooManyObjects`). When a
 * connection closes, captp is shut down, every `onClose` callback the
 * bootstrap registered runs (the `Live` facade closes its subscriptions),
 * and its tables are dropped. Nothing is cancelled in any vat.
 *
 * Logs: connection open and close (address, code), refusals (rule, the
 * target's interface label, byte count). Never a message body, a secret
 * or a fragment.
 *
 * Node module (agent-host adapter); the guest prelude is on `globalThis`.
 */
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';

import { makeCapTP, makeDefaultCapTPImportExportTables } from '@endo/captp';

import { closeCodes, gatewayLimits, gatewayTexts } from './contract-m3.js';
import { defaultGuardLimits, inspectCall } from './guard.js';
import { isGatewayLocal } from './powers.js';

/**
 * @typedef {object} GatewaySocket what W3.1's server hands `onSocket`
 * @property {string} address the client address (limiter key)
 * @property {(bytes: Uint8Array) => void} send
 * @property {(code: number, reason: string) => void} close
 * @property {(handler: (bytes: Uint8Array | string) => void) => void} onMessage
 * @property {(handler: () => void) => void} onClose
 */

/**
 * @typedef {object} BridgeLimits
 * @property {number} frameBytes
 * @property {number} argumentDepth
 * @property {number} callsInFlight
 * @property {number} exportsPerConnection
 * @property {number} answersPerConnection
 * @property {number} signInDeadlineMs
 * @property {number} wsMessageBytes
 */

/** @type {BridgeLimits} */
export const defaultBridgeLimits = harden({
  ...defaultGuardLimits,
  exportsPerConnection: gatewayLimits.exportsPerConnection,
  answersPerConnection: gatewayLimits.answersPerConnection,
  signInDeadlineMs: gatewayLimits.signInDeadlineMs,
  wsMessageBytes: gatewayLimits.wsMessageBytes,
});

/** Message types a browser may send (the others close the connection). */
const browserTypes = new Set([
  'CTP_BOOTSTRAP',
  'CTP_CALL',
  'CTP_DROP',
  'CTP_DISCONNECT',
  'CTP_RETURN',
  'CTP_RESOLVE',
]);

/** Normal closure (a page's own `CTP_DISCONNECT`). */
const normalClose = 1000;

/**
 * @param {string} slot
 * @returns {string}
 */
const reverseSlot = slot =>
  `${slot[0]}${slot[1] === '+' ? '-' : '+'}${slot.slice(2)}`;

/**
 * The alleged interface of a value, for refusal logs only.
 * @param {unknown} value
 * @returns {string | undefined}
 */
const labelOf = value => {
  if (value === null || typeof value !== 'object') return undefined;
  const tag = /** @type {any} */ (value)[Symbol.toStringTag];
  return typeof tag === 'string' ? tag.slice(0, 80) : undefined;
};

/**
 * @param {object} options
 * @param {(connection: { address: string, onClose: (callback: () => void) => void }) => any} options.makeBootstrap
 *   one `GatewayBootstrap` per connection (`powers.js` `makeBootstrapFactory`)
 * @param {Set<string>} options.vocabulary record keys a page may send
 *   (`vocabulary.js` `harnessVocabulary`)
 * @param {Set<string>} options.methods method names a page may name toward
 *   a vat (`vocabulary.js` `harnessNames`; guard.js rule 4a)
 * @param {(target: unknown, method: string) => boolean} options.isLargeCall
 *   whether `method` of the gateway-local `target` may exceed `frameBytes`
 * @param {Partial<BridgeLimits>} [options.limits]
 * @param {(event: Record<string, unknown>) => void} options.log
 * @param {(value: unknown) => boolean} [options.isLocal] gateway-local
 *   objects (default `powers.js` `isGatewayLocal`)
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 */
export const makeBridge = ({
  makeBootstrap,
  vocabulary,
  methods,
  isLargeCall,
  limits = {},
  log,
  isLocal = isGatewayLocal,
  timers = { setTimeout, clearTimeout },
}) => {
  /** @type {BridgeLimits} */
  const settings = harden({ ...defaultBridgeLimits, ...limits });
  /** @type {Set<{ close(code: number, reason: string): void }>} */
  const open = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  /** @param {GatewaySocket} socket */
  const connect = socket => {
    const { address } = socket;
    let closed = false;
    /** No more sends: the connection is closing (over its object cap). */
    let muted = false;
    let signedIn = false;
    let refused = 0;
    /** @type {(() => void)[]} */
    const closeCallbacks = [];
    /** Export slots (gateway naming, `o+n`/`p+n`) to the value exported. */
    const exportsBySlot = new Map();
    /** The page's question ids the gateway answered, to what they target. */
    /** @type {Map<string, { value: unknown, local: boolean }>} */
    const answers = new Map();
    /** Answered question ids, oldest answer first (eviction order). */
    /** @type {Set<string>} */
    const settled = new Set();
    let answersPeak = 0;
    let answersEvicted = 0;
    /** Forwarded calls to vat targets not yet answered (question ids). */
    const inFlight = new Set();
    /** `fetch` calls not yet answered. */
    const fetches = new Set();

    const bootstrap = makeBootstrap({
      address,
      onClose: callback => {
        closeCallbacks.push(callback);
      },
    });

    /** @param {unknown} value */
    const localValue = value => value === bootstrap || isLocal(value);

    /**
     * @param {string} id a page-side target or slot id
     * @returns {{ value: unknown, local: boolean } | undefined}
     */
    const targetOf = id => {
      if (id.startsWith('q-')) return answers.get(id);
      const slot = reverseSlot(id);
      if (!exportsBySlot.has(slot)) return undefined;
      const value = exportsBySlot.get(slot);
      return { value, local: localValue(value) };
    };

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;

    /**
     * @param {number} code
     * @param {string} reason
     * @param {boolean} fromPeer
     */
    const finish = (code, reason, fromPeer) => {
      if (closed) return;
      closed = true;
      if (deadline !== undefined) timers.clearTimeout(deadline);
      try {
        captp.shutdown(Error(reason));
      } catch {
        // already disconnected
      }
      for (const callback of closeCallbacks.splice(0)) {
        try {
          callback();
        } catch (error) {
          log({
            event: 'gateway-close-callback-failed',
            address,
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
      exportsBySlot.clear();
      answers.clear();
      settled.clear();
      inFlight.clear();
      fetches.clear();
      open.delete(handle);
      if (!fromPeer) {
        try {
          socket.close(code, reason);
        } catch {
          // the socket is gone already
        }
      }
      log({
        event: 'gateway-connection-closed',
        address,
        code,
        answersPeak,
        answersEvicted,
      });
    };

    /**
     * @param {number} code
     * @param {string} reason
     */
    const close = (code, reason) => finish(code, reason, false);

    /** @param {Record<string, any>} message */
    const rawSend = message => {
      if (closed || muted) return;
      if (message.type === 'CTP_RETURN') {
        const { answerID } = message;
        inFlight.delete(answerID);
        if (answers.has(answerID)) settled.add(answerID);
        if (fetches.delete(answerID) && 'result' in message && !signedIn) {
          signedIn = true;
          if (deadline !== undefined) timers.clearTimeout(deadline);
          deadline = undefined;
        }
      }
      const bytes = Buffer.from(JSON.stringify(message), 'utf8');
      try {
        socket.send(bytes);
      } catch {
        close(closeCodes.protocol, 'send failed');
      }
    };

    /** @param {any} options */
    const makeTables = options => {
      const base = makeDefaultCapTPImportExportTables(options);
      return {
        ...base,
        /**
         * @param {string} slot
         * @param {unknown} value
         */
        markAsExported(slot, value) {
          base.markAsExported(slot, value);
          exportsBySlot.set(slot, value);
          if (exportsBySlot.size > settings.exportsPerConnection && !muted) {
            muted = true;
            void Promise.resolve().then(() =>
              close(closeCodes.tooManyObjects, 'too many objects'),
            );
          }
        },
        /** @param {string} slot */
        deleteExport(slot) {
          base.deleteExport(slot);
          exportsBySlot.delete(slot);
        },
      };
    };

    const captp = makeCapTP('gateway', rawSend, bootstrap, {
      makeCapTPImportExportTables: makeTables,
      // marshal's default prints every error it sends; a refusal is logged
      // above as a rule, and a vat's error text is not the adapter's log.
      marshalSaveError: () => {},
      onReject: (/** @type {unknown} */ error, /** @type {any} */ context) => {
        if (closed) return;
        log({
          event: 'gateway-captp-error',
          address,
          kind: context?.kind,
          error: error instanceof Error ? error.name : typeof error,
        });
      },
    });

    /**
     * Keep a new answer within `answersPerConnection` (see the header):
     * forget the oldest settled answers, as the page's own `CTP_DROP`
     * would; with none settled, close. Answers false when closed.
     * @param {string} questionID
     * @param {{ value: unknown, local: boolean }} entry
     * @returns {boolean}
     */
    const keepAnswer = (questionID, entry) => {
      while (answers.size >= settings.answersPerConnection) {
        const oldest = settled.values().next();
        if (oldest.done) {
          muted = true;
          close(closeCodes.tooManyObjects, 'too many answers');
          return false;
        }
        settled.delete(oldest.value);
        answers.delete(oldest.value);
        answersEvicted += 1;
        captp.dispatch({
          type: 'CTP_DROP',
          epoch: 0,
          slotID: oldest.value,
          decRefs: 0,
        });
      }
      answers.set(questionID, entry);
      if (answers.size > answersPeak) answersPeak = answers.size;
      return true;
    };

    /**
     * Answer a page's question with an exception; nothing is dispatched.
     * @param {string} questionID
     * @param {string} text
     */
    const answerRefusal = (questionID, text) => {
      rawSend({
        type: 'CTP_RETURN',
        epoch: 0,
        answerID: questionID,
        exception: captp.serialize(harden(Error(text))),
      });
    };

    /**
     * @param {any} message a parsed CTP_CALL
     */
    const onCall = message => {
      const { questionID } = message;
      if (
        typeof questionID !== 'string' ||
        !questionID.startsWith('q-') ||
        answers.has(questionID) ||
        inFlight.has(questionID)
      ) {
        close(closeCodes.protocol, 'bad question id');
        return;
      }
      const held =
        typeof message.target === 'string' && message.target[1] === '-'
          ? targetOf(message.target)
          : undefined;
      const refusal = inspectCall({
        message,
        targetOf,
        vocabulary,
        methods,
        isLargeCall,
        inFlight: inFlight.size,
        limits: settings,
      });
      /** @type {string | undefined} */
      let text = refusal?.text;
      let rule = refusal?.rule;
      if (refusal?.rule === 'protocol') {
        close(closeCodes.protocol, 'malformed call');
        return;
      }
      let isFetch = false;
      if (text === undefined && held?.value === bootstrap) {
        const [name] = JSON.parse(message.method.body);
        isFetch = name === 'fetch';
      }
      if (text === undefined && !signedIn && !isFetch) {
        text = gatewayTexts.notSignedIn;
        rule = 'target';
      }
      if (text !== undefined) {
        refused += 1;
        log({
          event: 'gateway-refused',
          address,
          rule,
          target: labelOf(held?.value),
          bytes: Buffer.byteLength(message.method?.body ?? '', 'utf8'),
        });
        answerRefusal(questionID, text);
        return;
      }
      const local = held?.local === true;
      if (!keepAnswer(questionID, { value: undefined, local: false })) return;
      if (!local) inFlight.add(questionID);
      if (isFetch) fetches.add(questionID);
      captp.dispatch(message);
    };

    /** @param {Uint8Array | string} bytes */
    const onMessage = bytes => {
      if (closed) return;
      if (typeof bytes === 'string') {
        close(closeCodes.protocol, 'text frame');
        return;
      }
      if (bytes.byteLength > settings.wsMessageBytes) {
        close(closeCodes.protocol, 'message too large');
        return;
      }
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(decoder.decode(bytes));
      } catch {
        close(closeCodes.protocol, 'not CapTP JSON');
        return;
      }
      if (
        message === null ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        !browserTypes.has(message.type)
      ) {
        close(closeCodes.protocol, 'not a CapTP message');
        return;
      }
      switch (message.type) {
        case 'CTP_BOOTSTRAP': {
          const { questionID } = message;
          if (
            typeof questionID !== 'string' ||
            !questionID.startsWith('q-') ||
            answers.has(questionID)
          ) {
            close(closeCodes.protocol, 'bad question id');
            return;
          }
          if (!keepAnswer(questionID, { value: bootstrap, local: true })) {
            return;
          }
          captp.dispatch(message);
          return;
        }
        case 'CTP_CALL':
          onCall(message);
          return;
        case 'CTP_DROP': {
          const { slotID } = message;
          if (typeof slotID !== 'string' || slotID[1] !== '-') {
            close(closeCodes.protocol, 'bad drop');
            return;
          }
          if (slotID.startsWith('q-')) {
            answers.delete(slotID);
            settled.delete(slotID);
          }
          captp.dispatch(message);
          return;
        }
        case 'CTP_DISCONNECT':
          close(normalClose, 'disconnected');
          break;
        default:
          // CTP_RETURN, CTP_RESOLVE: the gateway asks a page nothing and
          // imports nothing from it, so there is nothing to settle.
          break;
      }
    };

    const handle = harden({
      close,
      stats: () =>
        harden({
          exports: exportsBySlot.size,
          inFlight: inFlight.size,
          refused,
          answers: answers.size,
          answersPeak,
          answersEvicted,
        }),
    });
    open.add(handle);
    socket.onMessage(onMessage);
    socket.onClose(() => finish(normalClose, 'closed by peer', true));
    deadline = timers.setTimeout(() => {
      if (!signedIn) close(closeCodes.signInDeadline, 'sign-in deadline');
    }, settings.signInDeadlineMs);
    /** @type {any} */ (deadline)?.unref?.();
    log({ event: 'gateway-connection-open', address });
    return handle;
  };

  return harden({
    connect,
    /**
     * Close every open connection (rotation, stop).
     * @param {number} code
     * @param {string} reason
     */
    closeAll: (code, reason) => {
      for (const handle of [...open]) handle.close(code, reason);
    },
    /** Open connections. */
    connections: () => open.size,
  });
};
harden(makeBridge);
