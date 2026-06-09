// @ts-check
/* eslint-disable no-await-in-loop */

import { E } from '@endo/eventual-send';

// ============================================================================
// Durable transcript persistence (cross-restart conversation continuity)
// ============================================================================
//
// A lal worker's PiAgent keeps its rolling conversation in
// `state.messages`, which lives only for the worker process's lifetime. To
// survive a daemon restart, each completed inbound-message turn persists its
// transcript *delta* to the guest's petstore under the pet name
// `pi-turn-<inboxNumber>`; on spawn, the rehydrator concatenates those deltas
// back into `initialState.messages`. The worker loop in `agent.js` calls
// `persistTurnDelta` per turn and `loadPersistedTranscript` once on spawn.

/**
 * Pet-name prefix for the per-turn transcript deltas a worker persists so a
 * fresh PiAgent (spawned after a daemon restart) can rehydrate its
 * conversation context. One entry is written per inbound-message turn under
 * the name `pi-turn-<inboxNumber>`; the spawn-time rehydrator lists this
 * prefix, sorts by inbox number, and concatenates the deltas back into
 * `initialState.messages`. See `loadPersistedTranscript` / `persistTurnDelta`.
 */
const PI_TURN_PREFIX = 'pi-turn-';

/**
 * The only schema version `loadPersistedTranscript` accepts. Entries carrying
 * any other value are dropped (and logged) rather than migrated: the policy
 * for #290's continuity fix is current-only, never forward-migration.
 */
const PI_TURN_SCHEMA_VERSION = 1;

/**
 * Durable per-turn transcript delta, stored in the guest's petstore under the
 * pet name `pi-turn-<inboxNumber>`.
 *
 * One entry is written per inbound-message turn, at the
 * no-in-flight-tool-calls boundary (the end of `runOneRound`), so a restart
 * never replays a half-finished tool round. The entry holds only the
 * `PiAgent.state.messages` *delta* appended during that turn — not the whole
 * growing transcript — which keeps each write O(1) in conversation length.
 *
 * Restore semantics: on spawn, `loadPersistedTranscript` lists the
 * `pi-turn-*` pet names, sorts them by `inboxNumber`, and concatenates the
 * `messages` arrays in order to reconstruct `initialState.messages`.
 *
 * Schema is current-only: an entry whose `schemaVersion` is not
 * {@link PI_TURN_SCHEMA_VERSION} is dropped + logged on read, never migrated.
 * Corrupt, unreadable, or missing state never throws — the worker spawns with
 * `messages: []` plus a structured warning. Pruning of old turns is left as a
 * future affordance (the per-entry granularity makes it possible later);
 * pre-existing `transcript-<id>` orphans from the pre-#290 harness are *not*
 * migrated, so pre-upgrade threads stay lost.
 *
 * @typedef {object} PiTurnEntry
 * @property {1} schemaVersion - Durable schema discriminator; current-only.
 * @property {bigint} inboxNumber - The inbound message number this turn
 *   answered; used as the cross-restart sort key.
 * @property {Array<any>} messages - The `PiAgent.state.messages` delta
 *   appended during this turn (the new tail past the prior high-water mark).
 */

/**
 * Persist the transcript delta for one completed inbound-message turn.
 *
 * Called at the no-in-flight-tool-calls boundary (after `runOneRound`
 * returns, when the PiAgent has finished the round including every tool
 * round), so a restart resumes on a clean message boundary rather than mid
 * tool call. Writes only the `delta` tail, never the full transcript.
 *
 * A persistence failure is logged but never propagated: losing durability for
 * one turn must not crash the live worker loop.
 *
 * @param {any} powers - Guest powers exposing `storeValue`.
 * @param {bigint} inboxNumber - The inbound message number this turn answered.
 * @param {Array<any>} delta - The `state.messages` entries appended this turn.
 * @returns {Promise<void>}
 */
export const persistTurnDelta = async (powers, inboxNumber, delta) => {
  if (delta.length === 0) {
    // A turn that appended nothing (e.g. an inbound from self that the loop
    // skipped, or an LLM round that produced no message) leaves no delta to
    // persist; writing an empty entry would only add read cost on spawn.
    return;
  }
  /** @type {PiTurnEntry} */
  const entry = harden({
    schemaVersion: PI_TURN_SCHEMA_VERSION,
    inboxNumber,
    messages: delta.map(message => harden(message)),
  });
  try {
    await E(powers).storeValue(entry, `${PI_TURN_PREFIX}${inboxNumber}`);
  } catch (error) {
    console.error(
      `[memory] failed to persist transcript turn ${inboxNumber}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};
harden(persistTurnDelta);

/**
 * Rehydrate a worker's rolling transcript from the per-turn deltas persisted
 * by {@link persistTurnDelta}, for seeding `initialState.messages` on spawn.
 *
 * Walks the guest's own pet names, keeps the `pi-turn-*` entries, sorts them
 * by `inboxNumber`, drops any whose `schemaVersion` is not current (logging
 * each drop), and concatenates the surviving `messages` arrays in inbox
 * order. The result is one flat rolling transcript per worker, matching the
 * post-#290 one-PiAgent-per-worker shape (not per-conversation chains).
 *
 * This never throws: a missing prefix (fresh worker), an unreadable entry, a
 * malformed `messages` field, or a schema mismatch all degrade to skipping
 * that entry (or returning `[]`) with a structured warning, so a corrupt
 * petstore can never prevent the worker from spawning.
 *
 * @param {any} powers - Guest powers exposing `list` and `lookup`.
 * @returns {Promise<Array<any>>} The reconstructed `messages` array (possibly
 *   empty).
 */
export const loadPersistedTranscript = async powers => {
  /** @type {Array<string>} */
  let names;
  try {
    names = await E(powers).list();
  } catch (error) {
    console.error(
      '[memory] failed to list petstore for transcript rehydration; ' +
        'starting with empty context:',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }

  /** @type {Array<{ inboxNumber: bigint, name: string }>} */
  const turnNames = [];
  for (const name of names) {
    if (name.startsWith(PI_TURN_PREFIX)) {
      const suffix = name.slice(PI_TURN_PREFIX.length);
      /** @type {bigint | undefined} */
      let inboxNumber;
      try {
        inboxNumber = BigInt(suffix);
      } catch {
        console.error(
          `[memory] skipping transcript entry with non-numeric suffix: ${name}`,
        );
      }
      if (inboxNumber !== undefined) {
        turnNames.push({ inboxNumber, name });
      }
    }
  }

  // Sort by inbox number so the concatenated transcript is in conversation
  // order regardless of the petstore's listing order.
  turnNames.sort((a, b) =>
    a.inboxNumber < b.inboxNumber ? -1 : a.inboxNumber > b.inboxNumber ? 1 : 0,
  );

  /** @type {Array<any>} */
  const messages = [];
  for (const { name } of turnNames) {
    /** @type {any} */
    let entry;
    try {
      entry = await E(powers).lookup(name);
    } catch (error) {
      console.error(
        `[memory] dropping unreadable transcript entry ${name}:`,
        error instanceof Error ? error.message : String(error),
      );
      entry = undefined;
    }
    if (
      entry &&
      typeof entry === 'object' &&
      entry.schemaVersion === PI_TURN_SCHEMA_VERSION
    ) {
      if (Array.isArray(entry.messages)) {
        for (const message of entry.messages) {
          messages.push(message);
        }
      } else {
        console.error(
          `[memory] dropping transcript entry ${name} with malformed messages`,
        );
      }
    } else if (entry !== undefined) {
      // entry resolved but is not a current-schema record; drop + log.
      // (An unreadable lookup already logged above and left entry undefined.)
      console.error(
        `[memory] dropping transcript entry ${name} with unknown ` +
          `schemaVersion ${entry && entry.schemaVersion}`,
      );
    }
  }
  return messages;
};
harden(loadPersistedTranscript);
