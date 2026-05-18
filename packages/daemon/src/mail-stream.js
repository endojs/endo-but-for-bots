// @ts-check

import harden from '@endo/harden';
import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { makePromiseKit } from '@endo/promise-kit';

import { AsyncIteratorInterface } from './interfaces.js';

/** @import { StreamEvent, StreamFinalization } from './types.js' */
/** @import { PromiseKit } from '@endo/promise-kit' */

/**
 * Construct a streaming message pair: a sender-side StreamWriter and a
 * recipient-side async iterable of StreamEvent records.  Phase 1 of
 * daemon-message-streaming.  Stream state lives in memory only; the daemon
 * persists the finalised message text on end() (or partial text on abort())
 * via the finalization promise this helper exposes.
 *
 * Events are buffered until the stream terminates so that a recipient who
 * iterates the stream after the sender has already produced events still
 * observes the full sequence.  A new iterator replays any buffered events
 * then waits for fresh ones.
 *
 * @param {object} [options]
 * @param {string} [options.initialPhase] - Initial phase label.
 */
export const makeMailStream = ({ initialPhase } = {}) => {
  /** @type {StreamEvent[]} */
  const buffer = [];

  /** @type {PromiseKit<void>} */
  let next = makePromiseKit();

  let terminated = false;

  let accumulatedText = '';
  let currentPhase = initialPhase;

  /** @type {PromiseKit<StreamFinalization>} */
  const finalizationKit = makePromiseKit();

  /** @param {StreamEvent} event */
  const publish = event => {
    buffer.push(event);
    next.resolve();
    next = makePromiseKit();
  };

  const terminate = () => {
    terminated = true;
    next.resolve();
  };

  const writer = Far('StreamWriter', {
    /**
     * @param {string} text
     */
    append: async text => {
      if (typeof text !== 'string') {
        throw new TypeError('StreamWriter append requires a string');
      }
      if (terminated) {
        throw new Error('Cannot append to a stream that has been closed');
      }
      accumulatedText += text;
      publish(harden({ type: /** @type {const} */ ('append'), text }));
    },
    /**
     * @param {string} phase
     */
    setPhase: async phase => {
      if (typeof phase !== 'string') {
        throw new TypeError('StreamWriter setPhase requires a string');
      }
      if (terminated) {
        throw new Error('Cannot setPhase on a stream that has been closed');
      }
      currentPhase = phase;
      publish(harden({ type: /** @type {const} */ ('phase'), phase }));
    },
    end: async () => {
      if (terminated) {
        return;
      }
      buffer.push(harden({ type: /** @type {const} */ ('end') }));
      terminate();
      finalizationKit.resolve(
        harden({
          status: /** @type {const} */ ('ended'),
          text: accumulatedText,
          phase: currentPhase,
        }),
      );
    },
    /**
     * @param {string} [reason]
     */
    abort: async reason => {
      if (terminated) {
        return;
      }
      const abortReason = typeof reason === 'string' ? reason : 'aborted';
      buffer.push(
        harden({ type: /** @type {const} */ ('abort'), reason: abortReason }),
      );
      terminate();
      finalizationKit.resolve(
        harden({
          status: /** @type {const} */ ('aborted'),
          text: accumulatedText,
          phase: currentPhase,
          reason: abortReason,
        }),
      );
    },
  });

  /**
   * Build a recipient-side async iterator over the stream events.  Each
   * call to makeReaderIterator returns a fresh iterator that replays the
   * buffered events from the start so a late subscriber still observes
   * the full sequence.
   */
  const makeReaderIterator = () => {
    let cursor = 0;
    let cancelled = false;
    return {
      async next() {
        for (;;) {
          if (cancelled) {
            return harden({ done: true, value: undefined });
          }
          if (cursor < buffer.length) {
            const event = buffer[cursor];
            cursor += 1;
            return harden({ done: false, value: event });
          }
          if (terminated) {
            return harden({ done: true, value: undefined });
          }
          // eslint-disable-next-line no-await-in-loop
          await next.promise;
        }
      },
      /** @param {any} value */
      async return(value) {
        cancelled = true;
        return harden({ done: true, value });
      },
      /** @param {any} error */
      async throw(error) {
        cancelled = true;
        throw error;
      },
    };
  };

  // The recipient-side reader is an exo with the AsyncIterator interface
  // shape (next/return/throw) so it can travel cleanly over CapTP.  The
  // recipient wraps it with makeRefIterator (or iterates the methods
  // directly).  The reader is single-consumer: makeReaderIterator is
  // called once and its cursor is shared across every next() invocation
  // on the exo.  A late subscriber that begins iterating after events
  // have been emitted still observes the full sequence because the
  // cursor starts at 0 and the buffer retains every event.
  const reader = makeExo(
    'StreamReader',
    AsyncIteratorInterface,
    makeReaderIterator(),
  );

  /**
   * Exposed alongside the reader exo: a Far getter for the finalisation
   * promise.  Mailboxes call this to know when to persist the durable
   * record.
   */
  const finalizationGetter = Far('StreamFinalization', {
    /** Returns the promise that resolves once end() or abort() runs. */
    get: () => finalizationKit.promise,
  });

  return harden({
    writer,
    reader,
    finalization: finalizationKit.promise,
    finalizationGetter,
  });
};
harden(makeMailStream);
