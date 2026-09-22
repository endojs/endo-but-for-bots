// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeResourceRegistry as makeSessionRegistry } from './resource-registry.js';

/**
 * The host-private directory authority used by this store.
 * Keeping this structural avoids coupling session storage to a daemon worker.
 * @typedef {object} SessionRecordDirectory
 * @property {(name: string) => Promise<string | undefined>} identify
 * @property {(name: string) => Promise<unknown>} lookup
 * @property {(name: string) => Promise<SessionRecordDirectory>} makeDirectory
 * @property {(name: string, identifier: string) => Promise<void>} storeIdentifier
 * @property {() => Promise<string[]>} list
 * @property {(name: string) => Promise<string | undefined>} maybeReadText
 * @property {(name: string, text: string) => Promise<void>} writeText
 * @property {(name: string) => Promise<void>} remove
 */

/**
 * A passive snapshot, containing no capability whose revival could start work.
 * An absent plan means creation did not finish; retain this record for cleanup.
 * A staged revision (see `revise`) is shown as already applied, and said so,
 * since the store finishes it before any other mutation of the record.
 * @typedef {object} SessionRecord
 * @property {string} identifier
 * @property {string | undefined} plan
 * @property {Record<string, string>} references
 * @property {true} [revising] A revision's intent is durable but its edges
 *   and plan are not all published yet.
 */

/** The record entry under which a revision is staged before it is published. */
const REVISION = 'revision';

/**
 * Retain each session's approved plan and exact dependency identities through
 * failed construction, restart, and cleanup. The plan is opaque text encoded
 * by the supervisor, not a marshal record containing eagerly revived powers.
 * Reference entries retain formula graph edges; IDs in the plan alone do not.
 *
 * One supervisor owns this directory and this store. Mutations and snapshots
 * are serialized per session here; other writers and duplicate store owners
 * must not mutate the same directory. In particular, makeDirectory replaces
 * existing names, so a create must never be used to adopt an existing record.
 * Keep the directory outside guest powers.
 *
 * This is ownership storage, not runtime admission or emergency revocation.
 * The supervisor resolves the recorded IDs for intentional operations and owns
 * startup/stop ordering. It must not start work before create succeeds.
 *
 * @param {SessionRecordDirectory} directory
 */
export const makeSessionRecordStore = directory => {
  const registry = makeSessionRegistry();

  /** @param {string} name */
  const load = async name => {
    const identifier = await E(directory).identify(name);
    if (identifier === undefined) return undefined;
    // These entries are directories constructed by this store, not guest data.
    const record = /** @type {SessionRecordDirectory} */ (
      await E(directory).lookup(name)
    );
    return harden({ identifier, record });
  };

  /**
   * The dependency edges a directory retains under `references`, read
   * without reviving any.
   * @param {SessionRecordDirectory} container
   * @returns {Promise<Record<string, string>>}
   */
  const readReferences = async container => {
    /** @type {Record<string, string>} */
    const references = {};
    const retained = await E(container).identify('references');
    if (retained === undefined) return references;
    const entries = /** @type {SessionRecordDirectory} */ (
      await E(container).lookup('references')
    );
    for (const name of await E(entries).list()) {
      // Serialize reads with this session's mutations; no entry is revived.
      // eslint-disable-next-line no-await-in-loop
      const id = await E(entries).identify(name);
      id !== undefined || Fail`Missing retained session reference ${name}`;
      Object.defineProperty(references, name, {
        value: id,
        enumerable: true,
      });
    }
    return references;
  };

  /**
   * A revision is staged whole under `revision` (its rebound edges, then its
   * plan) before any published edge or the plan changes, so a record is never
   * observed between an old and a new binding. A staging without a plan never
   * became intent and is discarded; one with a plan is intent: snapshots show
   * it applied, and the next mutation finishes it by re-applying every staged
   * write, each idempotent, and then dropping the staging.
   * @param {SessionRecordDirectory} record
   * @returns {Promise<{ plan: string, references: Record<string, string> } | { aborted: true } | undefined>}
   */
  const readStaged = async record => {
    const stagedId = await E(record).identify(REVISION);
    if (stagedId === undefined) return undefined;
    const staging = /** @type {SessionRecordDirectory} */ (
      await E(record).lookup(REVISION)
    );
    const plan = await E(staging).maybeReadText('plan');
    if (plan === undefined) return harden({ aborted: true });
    return harden({ plan, references: await readReferences(staging) });
  };

  /**
   * Finish a staged revision, or discard a staging that never became intent.
   * Every mutation of a record does this first, so no published edge is
   * replaced, released or removed around an unfinished revision.
   * @param {SessionRecordDirectory} record
   */
  const settleRecord = async record => {
    const staged = await readStaged(record);
    if (staged === undefined) return;
    if (!('aborted' in staged)) {
      const entries = /** @type {SessionRecordDirectory} */ (
        await E(record).lookup('references')
      );
      for (const [reference, identifier] of Object.entries(staged.references)) {
        // eslint-disable-next-line no-await-in-loop
        await E(entries).storeIdentifier(reference, identifier);
      }
      await E(record).writeText('plan', staged.plan);
    }
    await E(record).remove(REVISION);
  };

  /**
   * @param {string} identifier
   * @param {SessionRecordDirectory} record
   * @returns {Promise<SessionRecord>}
   */
  const snapshot = async (identifier, record) => {
    const plan = await E(record).maybeReadText('plan');
    const references = await readReferences(record);
    const staged = await readStaged(record);
    if (staged === undefined || 'aborted' in staged) {
      return harden({ identifier, plan, references });
    }
    return harden({
      identifier,
      plan: staged.plan,
      references: { ...references, ...staged.references },
      revising: true,
    });
  };

  /**
   * @param {string} name
   * @param {string} plan
   * @param {Record<string, string>} references
   */
  const create = (name, plan, references) => {
    // Capture the approved identities before asynchronous directory operations
    // allow the caller to reuse or mutate its input record.
    const initialReferences = Object.entries(references);
    return registry.inOrder(name, async () => {
      const existing = await E(directory).identify(name);
      existing === undefined || Fail`Session record ${name} already exists`;
      const record = await E(directory).makeDirectory(name);
      const entries = await E(record).makeDirectory('references');
      for (const [reference, identifier] of initialReferences) {
        // Preserve partial records and every reference already retained if a
        // later write fails. Nothing may acquire guest resources at this stage.
        // eslint-disable-next-line no-await-in-loop
        await E(entries).storeIdentifier(reference, identifier);
      }
      // Publish the approved plan only after its dependency edges are durable.
      await E(record).writeText('plan', plan);
    });
  };

  /** @param {string} name */
  const inspect = name =>
    registry.inOrder(name, async () => {
      const found = await load(name);
      return found && snapshot(found.identifier, found.record);
    });

  /**
   * Add a newly constructed resource without replacing an existing owner.
   * The supervisor retains construction names until this write succeeds.
   * @param {string} name
   * @param {string} reference
   * @param {string} identifier
   */
  const retain = (name, reference, identifier) =>
    registry.inOrder(name, async () => {
      const found = await load(name);
      if (!found) throw Fail`Missing session record ${name}`;
      await settleRecord(found.record);
      (await E(found.record).maybeReadText('plan')) !== undefined ||
        Fail`Session record ${name} is incomplete`;
      const entries = /** @type {SessionRecordDirectory} */ (
        await E(found.record).lookup('references')
      );
      (await E(entries).identify(reference)) === undefined ||
        Fail`Session reference ${reference} already exists`;
      await E(entries).storeIdentifier(reference, identifier);
    });

  /**
   * Replace the plan and the identities of a record's stable dependencies as
   * one transition, after a proven stop, for a later incarnation under other
   * services: an execution incarnation's own `client` and `worker` are never
   * rebound here, and the record's plan must be complete. A role the record
   * was created without is added, since a backend's dependencies may grow; a
   * role named with the identity it already holds keeps it, and a role not
   * named keeps its edge. A revision that rebinds is staged whole before any
   * published write (see `readStaged`): a failure or crash before its plan is
   * staged leaves the previous record, and one after leaves a durable intent
   * that snapshots show applied and the next mutation, or `settle`, finishes.
   * A plan alone is one entry write, already one transition, and is not
   * staged: each staging leaves directory formulas behind when collection is
   * off.
   *
   * @param {string} name
   * @param {string} plan
   * @param {Record<string, string>} references
   */
  const revise = (name, plan, references) => {
    const replacements = Object.entries(references);
    return registry.inOrder(name, async () => {
      const found = await load(name);
      if (!found) throw Fail`Missing session record ${name}`;
      await settleRecord(found.record);
      (await E(found.record).maybeReadText('plan')) !== undefined ||
        Fail`Session record ${name} is incomplete`;
      for (const [reference] of replacements) {
        !['client', 'worker'].includes(reference) ||
          Fail`Session reference ${reference} is an incarnation's own, not a dependency to rebind`;
      }
      if (replacements.length === 0) {
        await E(found.record).writeText('plan', plan);
        return;
      }
      const staging = await E(found.record).makeDirectory(REVISION);
      const entries = await E(staging).makeDirectory('references');
      for (const [reference, identifier] of replacements) {
        // Each new identity is retained by an edge before it is intent.
        // eslint-disable-next-line no-await-in-loop
        await E(entries).storeIdentifier(reference, identifier);
      }
      // The revision is intent from this write on.
      await E(staging).writeText('plan', plan);
      await settleRecord(found.record);
    });
  };

  /**
   * Finish a staged revision, or discard a staging that never became intent,
   * so an activation reads a record that is not between two bindings.
   * @param {string} name
   */
  const settle = name =>
    registry.inOrder(name, async () => {
      const found = await load(name);
      if (found) await settleRecord(found.record);
    });

  /**
   * Release selected incarnation references after proven cleanup, retaining
   * the logical plan and every other dependency. Missing references count as
   * already released, including a partially completed prior removal. If all
   * are absent (or the record/expected set is absent/empty), do not run cleanup.
   * Every present expected reference must match before cleanup and deletion.
   *
   * Cleanup must be idempotent and must not reenter this store for this name.
   * Its passive snapshot reflects the current remaining references; a caller
   * needing all original IDs on retry must capture them in its cleanup closure.
   * Partial deletion failure retains the remaining edges for the next attempt.
   * External-rebind checks are observations, not an atomic compare-and-delete;
   * the exclusive-owner requirement remains essential.
   *
   * @param {string} name
   * @param {Record<string, string>} expectedReferences
   * @param {(record: SessionRecord) => Promise<void>} cleanup
   */
  const release = (name, expectedReferences, cleanup) => {
    const expected = Object.entries(expectedReferences);
    return registry.inOrder(name, async () => {
      if (expected.length === 0) return;
      const found = await load(name);
      if (!found) return;
      await settleRecord(found.record);
      const before = await snapshot(found.identifier, found.record);
      let remaining = false;
      for (const [reference, identifier] of expected) {
        if (Object.hasOwn(before.references, reference)) {
          before.references[reference] === identifier ||
            Fail`Session reference ${reference} changed before cleanup`;
          remaining = true;
        }
      }
      if (!remaining) return;
      const entriesId = await E(found.record).identify('references');
      const entries = /** @type {SessionRecordDirectory} */ (
        await E(found.record).lookup('references')
      );
      const assertIdentity = async () => {
        const currentRecordId = await E(directory).identify(name);
        currentRecordId === found.identifier ||
          Fail`Session record ${name} changed during cleanup`;
        const currentEntriesId = await E(found.record).identify('references');
        currentEntriesId === entriesId ||
          Fail`Session references for ${name} changed during cleanup`;
      };
      await cleanup(before);
      await assertIdentity();
      // Validate the entire set before deleting any member, so a stale
      // callback cannot release still-matching siblings of a rebound ref.
      for (const [reference, identifier] of expected) {
        // eslint-disable-next-line no-await-in-loop
        const current = await E(entries).identify(reference);
        current === undefined ||
          current === identifier ||
          Fail`Session reference ${reference} changed during cleanup`;
      }
      for (const [reference, identifier] of expected) {
        // Recheck after earlier asynchronous removals. Other writers are
        // unsupported; refuse a detected successor rather than delete it.
        // eslint-disable-next-line no-await-in-loop
        await assertIdentity();
        // eslint-disable-next-line no-await-in-loop
        const current = await E(entries).identify(reference);
        if (current !== undefined) {
          current === identifier ||
            Fail`Session reference ${reference} changed during cleanup`;
          // eslint-disable-next-line no-await-in-loop
          await E(entries).remove(reference);
        }
      }
    });
  };

  /**
   * Remove only after the supervisor proves stop and required cleanup complete.
   * A failed callback leaves the record and all retained references available
   * for retry. The callback must tolerate repetition: directory removal can
   * fail after cleanup succeeds. It gets a passive snapshot and must not
   * reenter this store for the same name while holding its serialization slot.
   * @param {string} name
   * @param {(record: SessionRecord) => Promise<void>} cleanup
   */
  const remove = (name, cleanup) =>
    registry.inOrder(name, async () => {
      const found = await load(name);
      if (!found) return;
      await settleRecord(found.record);
      await cleanup(await snapshot(found.identifier, found.record));
      // Detect a prior external rebind. This is not atomic compare-and-delete;
      // exclusive directory ownership remains the guarantee against replacement.
      (await E(directory).identify(name)) === found.identifier ||
        Fail`Session record ${name} changed during cleanup`;
      await E(directory).remove(name);
    });

  return harden({ create, inspect, retain, revise, settle, release, remove });
};
harden(makeSessionRecordStore);
