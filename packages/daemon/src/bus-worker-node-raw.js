// @ts-check
/* global process */

// Bus worker entry point for Node.js workers under a Rust/Go supervisor.
//
// Functionally equivalent to bus-worker-node.js. This file exists as
// a distinct entry point so that ENDO_NODE_WORKER_BIN can reference
// it separately from ENDO_WORKER_BIN, allowing the daemon to dispatch
// kind='node' workers to a Node.js process while kind='locked' workers
// go to a native XS binary.
//
// Pipe layout:
//   fd 3: worker writes envelopes to supervisor (child → parent)
//   fd 4: worker reads envelopes from supervisor (parent → child)

// Establish a perimeter:
import '@endo/init';

import fs from 'fs';
import url from 'url';

import { mapWriter, mapReader } from '@endo/stream';
import { makePromiseKit } from '@endo/promise-kit';
import { makeMessageSlots } from '@endo/slots';
import {
  makeMessageCapTP,
  messageToBytes,
  bytesToMessage,
} from './connection.js';
import {
  encodeEnvelope,
  decodeEnvelope,
  readFrameFromStream,
  writeFrameToStream,
} from './envelope.js';
import { makeWorkerFacet } from './worker.js';
import { makePowers } from './bus-worker-node-powers.js';

/** @import { PromiseKit } from '@endo/promise-kit' */

const { promise: cancelled, reject: cancel } =
  /** @type {PromiseKit<never>} */ (makePromiseKit());

process.once('SIGINT', () => cancel(new Error('SIGINT')));

const workerFacet = makeWorkerFacet({ cancel });

const useSlotMachine = process.env.ENDO_USE_SLOT_MACHINE === '1';

let closed;

if (useSlotMachine) {
  // Slot-machine mode: bypass the powers' verb='deliver' wrapper
  // and speak the slot-machine wire protocol directly over the
  // envelope frames.  All four slot verbs are passed through.
  // @ts-ignore fd-based stream construction
  const writeStream = fs.createWriteStream(null, { fd: 3 });
  // @ts-ignore fd-based stream construction
  const readStream = fs.createReadStream(null, { fd: 4 });

  let daemonHandle = 1;

  /* eslint-disable no-await-in-loop -- The frame reader awaits each
     envelope from fd 4 serially; concurrent reads would interleave
     bytes. */
  const inboundFrames = (async function* envelopeFrames() {
    // Consume the init envelope first; the supervisor sends it
    // before any slot traffic.
    const initFrame = await readFrameFromStream(readStream);
    if (initFrame === null) return;
    const initEnv = decodeEnvelope(initFrame);
    if (initEnv.verb !== 'init') {
      throw Error(`bus-worker(slots): expected init, got ${initEnv.verb}`);
    }
    daemonHandle = initEnv.handle;
    for (;;) {
      const frame = await readFrameFromStream(readStream);
      if (frame === null) return;
      const env = decodeEnvelope(frame);
      // Track the latest peer handle for outbound addressing.
      daemonHandle = env.handle;
      yield { verb: env.verb, payload: env.payload };
    }
  })();
  /* eslint-enable no-await-in-loop */

  const envelopeWriter = harden({
    /** @param {{verb: string, payload: Uint8Array}} env */
    async next(env) {
      const bytes = encodeEnvelope({
        handle: daemonHandle,
        verb: env.verb,
        payload: env.payload,
        nonce: 0,
      });
      await writeFrameToStream(writeStream, bytes);
      return harden({ done: false, value: undefined });
    },
    async return() {
      return harden({ done: true, value: undefined });
    },
    async throw() {
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });

  ({ closed } = makeMessageSlots(
    'Endo',
    envelopeWriter,
    inboundFrames,
    cancelled,
    workerFacet,
  ));
} else {
  // CapTP path (default).
  const powers = makePowers({ fs, url });
  const { reader, writer } = powers.connection;
  const messageWriter = mapWriter(writer, messageToBytes);
  const messageReader = mapReader(reader, bytesToMessage);
  ({ closed } = makeMessageCapTP(
    'Endo',
    messageWriter,
    messageReader,
    cancelled,
    workerFacet,
  ));
}

// @ts-ignore Yes, we can assign to exitCode, typedoc.
process.exitCode = 1;
Promise.race([cancelled, closed]).then(
  () => {
    process.exitCode = 0;
  },
  error => {
    console.error(error);
  },
);
