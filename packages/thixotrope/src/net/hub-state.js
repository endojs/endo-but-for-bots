// @ts-check
import harden from '@endo/harden';

import { assertRecordVersion } from '../store/versioned-record.js';

const STATE_VERSION = 2;
const QUEUED_FRAME_PATTERN = /^(?:[0-9a-f]{2})*$/;

/** @param {string} message */
const raise = message => {
  throw Error(message);
};

/**
 * The hub's tables as one plain record for the store, and back: reference
 * rows, sessions, publications, gifts and gift waiters, with every bigint
 * written as a decimal string and every map as a record.
 *
 * @param {object} tables
 * @param {Map<string, any>} tables.refs
 * @param {Map<string, any>} tables.sessions
 * @param {Map<string, string>} tables.publications
 * @param {Map<string, string>} tables.gifts
 * @param {Map<string, Array<string>>} tables.giftWaiters
 */
export const serializeHubState = ({
  refs,
  sessions,
  publications,
  gifts,
  giftWaiters,
}) => {
  /** @type {any} */
  const state = {
    version: STATE_VERSION,
    refs: {},
    sessions: {},
    publications: {},
  };
  for (const [refId, row] of refs.entries()) {
    state.refs[refId] = {
      origin: row.origin,
      epoch: row.epoch,
      position: row.position,
      backing: row.backing,
      flavor: row.flavor,
      resolver: row.resolver,
      dead: row.dead,
      mentionsIn: row.mentionsIn,
      listeners: [...row.listeners],
      refcounts: Object.fromEntries(row.refcounts),
    };
  }
  for (const [sessionKey, session] of sessions.entries()) {
    state.sessions[sessionKey] = {
      epoch: session.epoch,
      ourExports: Object.fromEntries(session.ourExports),
      nextExport: String(session.nextExport),
      nextAnswer: String(session.nextAnswer),
      answersOwed: Object.fromEntries(session.answersOwed),
      processedUpTo: String(session.processedUpTo),
      durable: session.durable,
      retired: session.retired,
      queue: [...session.queue],
      queueSequences: [...session.queueSequences],
      nextDelivery: String(session.nextDelivery),
      identity: session.identity,
      usedGiftHandoffs: [...session.usedGiftHandoffs],
      pendingWithdraws: session.pendingWithdraws.map(pending => ({
        ...pending,
      })),
      nextHandoffCount: String(session.nextHandoffCount),
      dialLocation: session.dialLocation,
    };
  }
  state.publications = Object.fromEntries(publications);
  state.gifts = Object.fromEntries(gifts);
  state.giftWaiters = Object.fromEntries(
    [...giftWaiters.entries()].map(([key, list]) => [key, [...list]]),
  );
  return state;
};
harden(serializeHubState);

/**
 * Fill the hub's tables from a record `serializeHubState` wrote, refusing one
 * from another version or with a damaged queued frame.
 *
 * @param {any} state
 * @param {object} tables
 * @param {Map<string, any>} tables.refs
 * @param {(sessionKey: string) => any} tables.provideSessionState
 * @param {Map<string, string>} tables.publications
 * @param {Map<string, string>} tables.gifts
 * @param {Map<string, Array<string>>} tables.giftWaiters
 */
export const restoreHubState = (
  state,
  { refs, provideSessionState, publications, gifts, giftWaiters },
) => {
  assertRecordVersion('hub state', state.version, STATE_VERSION);
  for (const [refId, row] of Object.entries(state.refs ?? {})) {
    const r = /** @type {any} */ (row);
    refs.set(refId, {
      refId,
      origin: r.origin,
      epoch: Number(r.epoch ?? 0),
      position: r.position,
      backing: r.backing === 'answer' ? 'answer' : 'export',
      flavor: r.flavor,
      resolver: Boolean(r.resolver),
      dead: Boolean(r.dead),
      mentionsIn: Number(r.mentionsIn ?? 0),
      listeners: [...(r.listeners ?? [])],
      facing: new Map(),
      refcounts: new Map(
        Object.entries(r.refcounts ?? {}).map(([k, v]) => [k, Number(v)]),
      ),
    });
  }
  for (const [sessionKey, s] of Object.entries(state.sessions ?? {})) {
    const sd = /** @type {any} */ (s);
    const session = provideSessionState(sessionKey);
    session.epoch = Number(sd.epoch ?? 0);
    session.ourExports = new Map(Object.entries(sd.ourExports ?? {}));
    session.nextExport = BigInt(sd.nextExport ?? '1');
    session.nextAnswer = BigInt(sd.nextAnswer ?? '1');
    session.answersOwed = new Map(Object.entries(sd.answersOwed ?? {}));
    session.processedUpTo = BigInt(sd.processedUpTo ?? 0);
    session.retired = sd.retired ?? false;
    session.durable = Boolean(sd.durable);
    session.queue = [...(sd.queue ?? [])];
    // The hub wrote every queued frame as hex; one that is not is a
    // damaged state file, refused here rather than at the next send.
    session.queue.every(
      hex => typeof hex === 'string' && QUEUED_FRAME_PATTERN.test(hex),
    ) || raise(`ocapn hub: malformed queued frame for session ${sessionKey}`);
    session.queueSequences = sd.queueSequences
      ? [...sd.queueSequences]
      : session.queue.map((_, index) => String(BigInt(index) + 1n));
    session.nextDelivery = BigInt(sd.nextDelivery ?? session.queue.length);
    session.identity = sd.identity;
    session.usedGiftHandoffs = [...(sd.usedGiftHandoffs ?? [])];
    session.pendingWithdraws = (sd.pendingWithdraws ?? []).map(
      (/** @type {any} */ pending) => ({ ...pending }),
    );
    session.nextHandoffCount = BigInt(sd.nextHandoffCount ?? '1');
    session.dialLocation = sd.dialLocation;
    for (const [position, refId] of session.ourExports.entries()) {
      const row = refs.get(refId);
      if (row !== undefined) {
        row.facing.set(sessionKey, position);
      }
    }
  }
  for (const [swissnum, refId] of Object.entries(state.publications ?? {})) {
    publications.set(swissnum, /** @type {string} */ (refId));
  }
  for (const [giftKey, refId] of Object.entries(state.gifts ?? {})) {
    gifts.set(giftKey, /** @type {string} */ (refId));
  }
  for (const [giftKey, list] of Object.entries(state.giftWaiters ?? {})) {
    giftWaiters.set(giftKey, [.../** @type {Array<string>} */ (list)]);
  }
};
harden(restoreHubState);
