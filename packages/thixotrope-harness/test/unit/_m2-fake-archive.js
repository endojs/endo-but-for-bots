// @ts-check
// An in-memory fake of the agent host's record archive (W2.8) for the
// session vat's unit tests (W2.5): an `ArchivePort` whose `seal` does what
// the real one does (designs/m2-interfaces.md 4.4) except the files: it
// pages the range from the request's ContextSource (`p<from>` on, never
// below `from`), puts it in the segment order (log order, tool results in
// call order), checks the vat's fingerprint with the real check, chains
// the digest exactly as a segment file would (`formatSegment`), keeps the
// segment and answers its `SegmentEntry`; `previous` must name the head or
// any segment it holds (later ones are replaced, as orphans are). Controls
// let a test reject, break (the retired text) or hold the next seal, and
// read what was sealed. Import after the guest prelude.
//
//   const archive = makeFakeArchive();
//   ports.archive = archive.port;
//   ... archive.rejectNext('disk full'); archive.breakNext();
//   const held = archive.holdNext(); ... held.answer(); / held.fail(error);
//   archive.segments(); archive.recordsOf(1); archive.acknowledge(state);
/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import { inCallOrder } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import {
  encodeRecord,
  formatSegment,
} from '../../resources/agent-host/impl/archive/segment.js';
import { checkFingerprint } from '../../resources/agent-host/impl/archive/store.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} FakeSegment
 * @property {number} ordinal
 * @property {any} entry the SegmentEntry answered
 * @property {string} previous
 * @property {any[]} records keyed records (`{ $staged: { key, ... } }`)
 * @property {boolean} acknowledged
 */

/**
 * @param {object} [options]
 * @param {(blob: any) => string} [options.keyOf] a blob handle's file key
 *   (default: `b<n>` in order of first sight)
 */
export const makeFakeArchive = ({ keyOf } = {}) => {
  /** @type {WeakMap<any, string>} */
  const keys = new WeakMap();
  let serial = 0;
  const keyFor =
    keyOf ??
    (blob => {
      let key = keys.get(blob);
      if (key === undefined) {
        serial += 1;
        key = `b${serial}`;
        keys.set(blob, key);
      }
      return key;
    });
  /** @type {FakeSegment[]} */
  let held = [];
  /** @type {Array<{ kind: 'reject', message: string } | { kind: 'break' } | { kind: 'hold', kit: any }>} */
  const plans = [];
  /** @type {any[]} every SealRequest received (context removed) */
  const requests = [];
  const counts = { seals: 0, answered: 0, rejected: 0, broken: 0, pages: 0 };

  /** @param {string} message */
  const failed = message => Error(textOf.archiveFailed(message));

  /**
   * The range from the vat, as the real port pulls what its mirror lacks.
   * @param {any} req
   */
  const rangeOf = async req => {
    /** @type {any[]} */
    const records = [];
    /** @type {number} */
    let at = req.from;
    const to = Number(req.to);
    while (at < to) {
      /** @type {any} */
      let page;
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await E(req.context).page(`p${at}`);
      } catch (error) {
        throw failed(
          `context page failed: ${/** @type {Error} */ (error).message}`,
        );
      }
      counts.pages += 1;
      if (page.from !== at) throw failed('the context page is not contiguous');
      const take = page.records.slice(0, to - at);
      if (take.length === 0) throw failed('the session has fewer records');
      records.push(...take);
      at += take.length;
    }
    return records;
  };

  /** @param {any} req */
  const sealNow = async req => {
    let ordinal = 1;
    if (req.previous !== '') {
      const previous = held.find(s => s.entry.digest === req.previous);
      if (previous === undefined)
        throw failed('the previous segment is not here');
      if (previous.entry.to !== req.from) {
        throw failed('the range does not follow the previous segment');
      }
      ordinal = previous.ordinal + 1;
    } else if (req.from !== 0) {
      throw failed('the first segment must start at record 0');
    }
    const keyed = inCallOrder(
      (await rangeOf(req)).map(record => encodeRecord(record, keyFor)),
    );
    checkFingerprint(keyed, req);
    const { digest } = formatSegment(
      {
        ordinal,
        from: req.from,
        to: req.to,
        firstTurn: req.firstTurn,
        turns: req.turns,
        bytes: req.bytes,
        epoch: req.epoch,
      },
      keyed,
      req.previous,
    );
    const entry = harden({
      from: req.from,
      to: req.to,
      firstTurn: req.firstTurn,
      turns: req.turns,
      records: keyed.length,
      bytes: req.bytes,
      digest,
    });
    held = [
      ...held.filter(s => s.ordinal < ordinal),
      {
        ordinal,
        entry,
        previous: req.previous,
        records: keyed,
        acknowledged: false,
      },
    ];
    counts.answered += 1;
    return entry;
  };

  const port = Far('ArchivePort', {
    /** @param {any} req */
    seal: async req => {
      counts.seals += 1;
      const { context: _context, ...plain } = req;
      requests.push(harden(plain));
      const plan = plans.shift();
      if (plan?.kind === 'reject') {
        counts.rejected += 1;
        throw failed(plan.message);
      }
      if (plan?.kind === 'break') {
        counts.broken += 1;
        throw Error(HUB_RETIRED_MESSAGE);
      }
      if (plan?.kind === 'hold') {
        const decision = await plan.kit.promise;
        if (decision.error !== undefined) throw decision.error;
      }
      return sealNow(req);
    },
  });

  return harden({
    /** The ArchivePort to put in TurnPorts.archive. */
    port,
    /** The next seal rejects with `textOf.archiveFailed(message)`. @param {string} message */
    rejectNext: message => {
      plans.push({ kind: 'reject', message });
    },
    /** The next seal breaks with the hub's retired text (an adapter restart). */
    breakNext: () => {
      plans.push({ kind: 'break' });
    },
    /**
     * The next seal waits: `answer()` seals and answers it, `fail(error)`
     * rejects it (a test can deliver other cranks meanwhile).
     */
    holdNext: () => {
      const kit = makePromiseKit();
      plans.push({ kind: 'hold', kit });
      return harden({
        answer: () => kit.resolve({}),
        /** @param {Error} error */
        fail: error => kit.resolve({ error }),
      });
    },
    /** Every SegmentEntry answered and still held, by ordinal. */
    segments: () => harden(held.map(s => s.entry)),
    /** The keyed records of segment `ordinal` (1-based). @param {number} ordinal */
    recordsOf: ordinal => held.find(s => s.ordinal === ordinal)?.records,
    /**
     * What the real store does when a vat state arrives: segments the
     * state names are acknowledged, the rest (orphans) dropped. Throws
     * `textOf.archiveFailed('segment <n> is missing')` when the state names
     * a segment the fake does not hold.
     * @param {{ segments: number, digest: string } | undefined} state
     */
    acknowledge: state => {
      const segments = state?.segments ?? 0;
      const chain = held.filter(s => s.ordinal <= segments);
      if (
        chain.length !== segments ||
        (segments > 0 && chain[segments - 1].entry.digest !== state?.digest)
      ) {
        throw failed(`segment ${chain.length + 1} is missing`);
      }
      held = chain.map(s => ({ ...s, acknowledged: true }));
    },
    requests: () => harden([...requests]),
    counts: () => harden({ ...counts }),
  });
};
harden(makeFakeArchive);
