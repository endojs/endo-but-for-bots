// @ts-check

import { makeExo } from '@endo/exo';
import { makeWriterPump } from '@endo/exo-stream/writer-pump.js';

import { PassablePublisherInterface } from './type-guards.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Pattern } from '@endo/patterns' */
/** @import { Writer } from '@endo/stream' */
/** @import { PassablePublisher, PublisherFromWriterOptions } from './types.js' */

/**
 * Wrap a local pubsub publisher (a topic's `publisher` Writer) as a remotable
 * `PassablePublisher` exo, passable over CapTP (responder side).
 *
 * A publisher is the producer end of a `@endo/pubsub` topic. On the wire it is
 * an exo-stream Writer: a remote producer's pushed values travel from the
 * initiator to this responder along the synchronization chain, where each
 * received value is published to the topic and fans out to every subscriber.
 * This composes exo-stream's writer pump under a pubsub-named exo identity.
 *
 * @template {Passable} [TValue=Passable]
 * @template {Passable} [TReturn=undefined]
 * @param {Writer<TValue, TReturn>} publisher the topic's `publisher` Writer
 * @param {PublisherFromWriterOptions} [options]
 * @returns {PassablePublisher<TValue, TReturn>}
 */
export const publisherFromWriter = (publisher, options = {}) => {
  const { buffer = 0, writePattern, writeReturnPattern } = options;

  const pump = makeWriterPump(publisher, {
    buffer,
    writePattern,
    writeReturnPattern,
  });

  return /** @type {PassablePublisher<TValue, TReturn>} */ (
    /** @type {unknown} */ (
      makeExo(
        'PassablePublisher',
        PassablePublisherInterface,
        /** @type {any} */ ({
          stream: pump,

          /**
           * Returns the pattern for validating published values.
           * @returns {Pattern | undefined}
           */
          writePattern() {
            return writePattern;
          },

          /**
           * Returns the pattern for validating the terminal value.
           * @returns {Pattern | undefined}
           */
          writeReturnPattern() {
            return writeReturnPattern;
          },
        }),
      )
    )
  );
};
