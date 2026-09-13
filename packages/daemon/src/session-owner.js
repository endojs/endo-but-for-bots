// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeResourceRegistry } from './resource-registry.js';
import { makeSessionRecordStore } from './session-record-store.js';
import { assertCopyData, wrapSessionReader } from './session-protocol.js';

/** @import { SessionRecordDirectory } from './session-record-store.js' */

const OwnerInterface = M.interface('SessionOwner', {
  create: M.callWhen(
    M.string(),
    M.string(),
    M.recordOf(M.string(), M.string()),
  ).returns(M.any()),
  inspect: M.callWhen(M.string()).returns(M.any()),
  revise: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  client: M.callWhen(M.string()).returns(M.any()),
  stop: M.callWhen(M.string()).returns(M.undefined()),
  remove: M.callWhen(M.string()).returns(M.undefined()),
  help: M.call().returns(M.string()),
});

const ClientInterface = M.interface('SessionClient', {
  send: M.callWhen(M.string()).optional(M.record()).returns(M.any()),
  interrupt: M.callWhen().returns(M.undefined()),
  status: M.callWhen().returns(M.any()),
  help: M.call().returns(M.string()),
});

/**
 * Administrative record and lifecycle ownership inside the daemon.
 * Disposable formula capabilities never leave this boundary. In particular,
 * releasing their last graph edges must not kill a worker hosting sibling
 * sessions just because that worker received a temporary directory or client.
 * The returned exos are ephemeral forwarding facets, not formula identities.
 * Re-provide the owner from the host after a daemon restart.
 *
 * The `client` role implements terminate/destroy and the session protocol.
 * Optional `storage` implements remove(planText), using the recorded plan.
 * Native construction and acquisition ownership are separate: callers may
 * create an initial record here, but must not treat a failed native constructor
 * as proof that it acquired nothing. This owner retains failed cleanup.
 *
 * @param {object} powers
 * @param {SessionRecordDirectory} powers.directory
 * @param {(identifier: string) => Promise<any>} powers.provide
 * @param {(identifier: string, reason: Error) => Promise<void>} powers.cancel
 * @param {() => void} [powers.assertActive] - Parent host-incarnation fence.
 */
export const makeSessionOwner = ({
  directory,
  provide,
  cancel,
  assertActive = () => {},
}) => {
  const records = makeSessionRecordStore(directory);
  const operations = makeResourceRegistry();
  /** @type {Map<string, {identifier: string, closed: boolean, facet: any}>} */
  const incarnations = new Map();
  const stopped = new Set();
  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} operation
   */
  const inOrder = (name, operation) => {
    assertActive();
    return operations.inOrder(name, () => {
      assertActive();
      return operation();
    });
  };

  /** @param {string} name */
  const recordDirectory = name =>
    /** @type {Promise<SessionRecordDirectory>} */ (E(directory).lookup(name));

  /** @param {string} name */
  const inspect = async name => {
    const record = await records.inspect(name);
    if (!record) return undefined;
    const entry = await recordDirectory(name);
    const phase = (await E(entry).maybeReadText('lifecycle')) ?? 'ready';
    ['ready', 'stopping', 'stopped', 'removing'].includes(phase) ||
      Fail`Unknown session lifecycle phase`;
    return harden({
      ...record,
      phase,
    });
  };

  /** @param {string} name */
  const fence = name => {
    stopped.add(name);
    const incarnation = incarnations.get(name);
    if (incarnation) incarnation.closed = true;
  };

  /** @param {string} name */
  const stop = async name => {
    fence(name);
    const record = await inspect(name);
    if (!record) {
      incarnations.delete(name);
      stopped.delete(name);
      return;
    }
    const entry = await recordDirectory(name);
    const identifier = record.references.client;
    if (identifier === undefined) {
      if (record.phase === 'stopping') {
        await E(entry).writeText('lifecycle', 'stopped');
      }
      incarnations.delete(name);
      stopped.delete(name);
      return;
    }
    if (record.phase !== 'removing') {
      // A failed stop must fence a reconstructed owner too. Publish intent
      // before invoking native cleanup or revoking its formula.
      await E(entry).writeText('lifecycle', 'stopping');
    }
    await records.release(name, { client: identifier }, async () => {
      const client = await provide(identifier);
      await E(client).terminate();
      // Cancellation follows direct containment proof and uses the original
      // identifier, never a public name that could have been rebound.
      await cancel(identifier, Error(`Session ${name} stopped`));
    });
    if (record.phase !== 'removing') {
      await E(entry).writeText('lifecycle', 'stopped');
    }
    incarnations.delete(name);
    stopped.delete(name);
  };

  /** @param {string} name */
  const client = async name => {
    !stopped.has(name) || Fail`Session incarnation is stopped`;
    const record = await inspect(name);
    !stopped.has(name) || Fail`Session incarnation is stopped`;
    if (!record) return undefined;
    record.phase !== 'removing' ||
      Fail`Session removal must finish before reuse`;
    record.phase !== 'stopping' || Fail`Session stop must finish before reuse`;
    record.plan !== undefined || Fail`Session record is incomplete`;
    const identifier = record.references.client;
    if (identifier === undefined) return undefined;
    record.phase === 'ready' || Fail`Session incarnation is stopped`;
    const existing = incarnations.get(name);
    if (existing?.identifier === identifier) {
      !existing.closed || Fail`Session incarnation is stopped`;
      return existing.facet;
    }
    if (existing) existing.closed = true;
    /** @type {{identifier: string, closed: boolean, facet: any}} */
    const incarnation = { identifier, closed: false, facet: undefined };
    const assertOpen = () => {
      assertActive();
      !incarnation.closed || Fail`Session incarnation is stopped`;
    };
    // Resolve only for an intentional session operation. The reference remains
    // in the daemon; no raw client capability is exported to the caller.
    const target = async () => {
      assertOpen();
      const value = await provide(identifier);
      assertOpen();
      return value;
    };
    const facet = makeExo('SessionClient', ClientInterface, {
      send: async (text, options = {}) => {
        const value = await target();
        assertOpen();
        const reader = await E(value).send(text, options);
        return wrapSessionReader(reader, assertOpen);
      },
      interrupt: async () => {
        const value = await target();
        assertOpen();
        return E(value).interrupt();
      },
      status: async () => {
        const value = await target();
        assertOpen();
        const status = await E(value).status();
        assertOpen();
        assertCopyData(status);
        return status;
      },
      help: () =>
        'A session incarnation. Stopped handles cannot access a successor.',
    });
    incarnation.facet = facet;
    incarnations.set(name, incarnation);
    return facet;
  };

  return makeExo('SessionOwner', OwnerInterface, {
    create: (name, plan, references) =>
      inOrder(name, async () => {
        await records.create(name, plan, references);
        stopped.delete(name);
        return inspect(name);
      }),
    inspect: name => inOrder(name, () => inspect(name)),
    revise: (name, plan) =>
      inOrder(name, async () => {
        const record = await inspect(name);
        if (!record) throw Fail`Missing session record`;
        record.plan !== undefined || Fail`Session record is incomplete`;
        record.phase !== 'removing' ||
          Fail`Session removal must finish before reuse`;
        record.phase !== 'stopping' ||
          Fail`Session stop must finish before reuse`;
        record.references.client === undefined ||
          Fail`Stop the client before revising its plan`;
        await E(await recordDirectory(name)).writeText('plan', plan);
      }),
    client: name => inOrder(name, () => client(name)),
    stop: name => {
      // Fence a previously returned handle synchronously, even if another
      // administrative operation is currently using the session's queue.
      fence(name);
      return inOrder(name, () => stop(name));
    },
    remove: name => {
      fence(name);
      return inOrder(name, async () => {
        await records.remove(name, async record => {
          // create() may be retaining an already constructed client's ID.
          // A missing plan therefore cannot prove that nothing was acquired,
          // or supply the original storage cleanup instructions.
          record.plan !== undefined ||
            Fail`Incomplete session record requires its original cleanup plan`;
          const entry = await recordDirectory(name);
          await E(entry).writeText('lifecycle', 'removing');
          const clientId = record.references.client;
          if (clientId !== undefined) {
            const target = await provide(clientId);
            await E(target).destroy();
          }
          const storageId = record.references.storage;
          if (storageId !== undefined) {
            const storage = await provide(storageId);
            await E(storage).remove(record.plan);
          }
        });
        incarnations.delete(name);
        stopped.delete(name);
      });
    },
    help: () =>
      'Host-only session records and lifecycle ownership. Inspection is passive; stop releases the client after containment; removal retains failed cleanup and its deletion intent.',
  });
};
harden(makeSessionOwner);
