// @ts-check
// Fakes for the post office and the operator's mail (designs/m9-interfaces.md
// 3.1): a real row table and start count, an AgentHostAdmin and
// RelayWriters from their real guards, and session rows whose
// SessionInternal is an exo of the real `deliverMail`/`cancelMail` guards
// with a minimal inbox (seq duplicates answered from a ring, a bound). AVA
// skips files starting with an underscore.
import './_m1a-prelude.js';

/* eslint-disable import/no-relative-packages */
import {
  interfaces as relayInterfaces,
  interfaces,
  methodNames,
} from '../../guest/lib/interfaces.js';
import { shapes as mailShapes } from '../../guest/lib/guards/session.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { makeStartCount } from '../../guest/factory/starts.js';
import { makePostOffice } from '../../guest/factory/post-office.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, M, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

export const settle = async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** @param {string} [name] */
export const blob = (name = 'b') => Far('Blob', { name: () => name });

/**
 * A StagedText of `bytes` bytes.
 * @param {number} bytes
 * @param {string} [preview]
 */
export const stagedText = (bytes, preview = 'preview of a long text') =>
  harden({ blob: blob(), preview, bytes });

/**
 * The post office's world: rows, starts, an admin whose relay copies are
 * counted, and session rows with a fake inbox.
 * @param {{ inboxLimit?: number }} [options]
 */
export const makeMailWorld = ({ inboxLimit = 256 } = {}) => {
  const rows = makeRowTable();
  const starts = makeStartCount();
  /** @type {any[]} */
  const copies = [];
  /** @type {any[]} */
  const released = [];
  const failures = { copy: 0, writersFor: 0 };
  let relays = 0;
  /** @type {{ promise?: Promise<unknown>, resolve?: (value: unknown) => void }} */
  const copyGate = {};
  const makeRelay = () =>
    makeExo('RelayWriters', relayInterfaces.RelayWriters, {
      open: async () => Far('BlobWriter', {}),
      /**
       * @param {any} source
       * @param {any} options
       */
      copy: async (source, options) => {
        if (copyGate.promise !== undefined) await copyGate.promise;
        if (failures.copy > 0) {
          failures.copy -= 1;
          throw Error(HUB_RETIRED_MESSAGE);
        }
        const copied = harden({
          blob: blob('copy'),
          preview: 'copy',
          bytes: 9,
          digest: 'a'.repeat(64),
        });
        copies.push({ source, options, copied });
        return copied;
      },
    });
  /** @type {Record<string, (...args: any[]) => any>} */
  const adminMethods = {};
  for (const name of methodNames.AgentHostAdmin) {
    adminMethods[name] = () => undefined;
  }
  adminMethods.writersFor = () => {
    relays += 1;
    return makeRelay();
  };
  adminMethods.releaseBlobs = (/** @type {any[]} */ blobs) => {
    released.push(...blobs);
  };
  const admin = makeExo(
    'AgentHostAdmin',
    interfaces.AgentHostAdmin,
    /** @type {any} */ (adminMethods),
  );
  let at = 1_700_000_000_000;
  const postOffice = makePostOffice({
    admin,
    rows,
    starts,
    lastKnownTime: () => at,
  });

  const internalGuard = M.interface('SessionInternal', {
    deliverMail: M.call(mailShapes.Envelope).returns(mailShapes.MailDelivery),
    cancelMail: M.call(M.and(M.number(), M.gte(0))).returns(M.undefined()),
  });

  /**
   * A session row with a fake inbox. `gate` stalls deliveries: each call
   * waits for `release()` (a forwarding stand-in in front of the real-guard
   * exo, since a guarded `M.call` method cannot answer a promise).
   * @param {string} title
   */
  const addSession = title => {
    const row = rows.add({
      title,
      backendTitle: 'Fake',
      modelId: 'm',
      userInitiated: true,
    });
    /** @type {any[]} */
    const envelopes = [];
    /** @type {number[]} */
    const cancelled = [];
    /** @type {Map<number, any>} */
    const outcomes = new Map();
    const state = {
      lastSeq: 0,
      calls: 0,
      retired: false,
      loseAnswers: false,
      /** @type {ReturnType<typeof makePromiseKit> | undefined} */
      gate: undefined,
    };
    const exo = makeExo('SessionInternal', internalGuard, {
      /** @param {any} envelope */
      deliverMail: envelope => {
        if (Number(envelope.seq) <= state.lastSeq) {
          return harden({ ...outcomes.get(envelope.seq), duplicate: true });
        }
        state.lastSeq = envelope.seq;
        const outcome =
          envelopes.length >= inboxLimit
            ? harden({ refused: `inbox of ${title} is full` })
            : harden({ number: envelopes.push(envelope) });
        outcomes.set(envelope.seq, outcome);
        return outcome;
      },
      /** @param {number} postmark */
      cancelMail: postmark => {
        cancelled.push(postmark);
        return undefined;
      },
    });
    const internal = Far('SessionInternalGate', {
      /** @param {any} envelope */
      deliverMail: async envelope => {
        state.calls += 1;
        if (state.retired) throw Error(HUB_RETIRED_MESSAGE);
        if (state.gate !== undefined) await state.gate.promise;
        const delivery = E(exo).deliverMail(envelope);
        // The answer is lost (a kill after the recipient's crank).
        if (state.loseAnswers) return makePromiseKit().promise;
        return delivery;
      },
      /** @param {number} postmark */
      cancelMail: postmark => E(exo).cancelMail(postmark),
    });
    const session = Far('Session', {});
    rows.ready(row, { session, internal });
    return {
      row,
      session,
      envelopes,
      cancelled,
      state,
      outbox: postOffice.outboxFor(row),
      address: postOffice.addressFor(row),
      stall: () => {
        state.gate = makePromiseKit();
      },
      /** The inbox forgets its delivery outcomes (an outcome ring miss). */
      forgetOutcomes: () => outcomes.clear(),
      release: () => {
        const { gate } = state;
        state.gate = undefined;
        gate?.resolve(undefined);
      },
    };
  };

  return {
    rows,
    starts,
    admin,
    postOffice,
    copies,
    released,
    failures,
    relays: () => relays,
    /** Copies wait until `releaseCopies()`. */
    stallCopies: () => {
      const kit = makePromiseKit();
      copyGate.promise = kit.promise;
      copyGate.resolve = kit.resolve;
    },
    releaseCopies: () => {
      const { resolve } = copyGate;
      copyGate.promise = undefined;
      resolve?.(undefined);
    },
    addSession,
    /** @param {number} time */
    setTime: time => {
      at = time;
    },
  };
};
