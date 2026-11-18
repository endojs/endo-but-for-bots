// @ts-check
/**
 * A Node CapTP client over any message transport (M3 W3.2;
 * designs/m3-interfaces.md 17): what a page's controller does, for adapter
 * and integration tests. Frames are binary UTF-8 JSON, one CapTP message
 * each (R2-14); imports are collected (`gcImports`), so a dropped presence
 * sends `CTP_DROP` as a browser does.
 *
 * `makeClient({ send, onClose? })` answers `{ receive(bytes), bootstrap(),
 * close(), sendRaw(message), captp }`: `receive` takes one frame from the
 * gateway, `bootstrap()` the gateway's `GatewayBootstrap` presence,
 * `close()` disconnects and calls `onClose`; `sendRaw` sends a hand-made
 * message (protocol tests) and `captp` is the client's connection.
 * `answers()` is `{ held, peak }`: the questions this client has asked and
 * not yet dropped (`CTP_CALL`/`CTP_BOOTSTRAP` sent, minus `CTP_DROP` of a
 * `q-` slot), now and at most since `resetAnswersPeak()`. The gateway's
 * answer table holds at most these (the bridge's `answersPerConnection`
 * bound is measured against `peak`).
 */
import { makeCapTP } from '@endo/captp';

/**
 * @param {object} options
 * @param {(bytes: Uint8Array) => void} options.send one frame to the gateway
 * @param {() => void} [options.onClose]
 */
export const makeClient = ({ send, onClose = () => {} }) => {
  let closed = false;
  /** @type {Set<string>} */
  const held = new Set();
  let peak = 0;
  /** @param {Record<string, any>} message */
  const count = message => {
    const { type } = message;
    if (type === 'CTP_CALL' || type === 'CTP_BOOTSTRAP') {
      held.add(message.questionID);
      if (held.size > peak) peak = held.size;
    } else if (
      type === 'CTP_DROP' &&
      typeof message.slotID === 'string' &&
      message.slotID.startsWith('q-')
    ) {
      // The client names its own question `q-n` in a drop as well.
      held.delete(message.slotID);
    }
  };
  const captp = makeCapTP(
    'client',
    /** @param {Record<string, unknown>} message */
    message => {
      if (closed) return;
      count(message);
      send(Buffer.from(JSON.stringify(message), 'utf8'));
    },
    undefined,
    { gcImports: true, onReject: () => {} },
  );
  return harden({
    /** @param {Uint8Array} bytes */
    receive(bytes) {
      if (closed) return;
      captp.dispatch(JSON.parse(Buffer.from(bytes).toString('utf8')));
    },
    bootstrap: () => captp.getBootstrap(),
    close() {
      if (closed) return;
      closed = true;
      captp.shutdown(Error('client closed'));
      onClose();
    },
    /** @param {Record<string, unknown>} message */
    sendRaw(message) {
      send(Buffer.from(JSON.stringify(message), 'utf8'));
    },
    captp,
    answers: () => harden({ held: held.size, peak }),
    resetAnswersPeak: () => {
      peak = held.size;
    },
  });
};
harden(makeClient);
