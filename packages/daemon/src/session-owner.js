// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeResourceRegistry } from './resource-registry.js';
import { makeSessionRecordStore } from './session-record-store.js';
import { assertCopyData, wrapSessionReader } from './session-protocol.js';

/** @import { SessionRecordDirectory, SessionRecord } from './session-record-store.js' */

/**
 * Host-private native construction powers. Publication precedes worker and
 * controller acquisition; cancel retains the original control and never revives
 * an unpublished or already cancelled formula.
 * @typedef {object} NativeSessionConstruction
 * @property {(name: string, publish: (worker: string, client: string) => Promise<void>) => { value: Promise<any>, cancel(): Promise<void> }} construct
 * @property {(identifier: string, reason: Error) => Promise<void>} cancel
 * @property {(identifier: string) => Promise<any>} provideClient
 */

/**
 * @typedef {object} NativeActivation
 * @property {string} identifier
 * @property {any} value
 * @property {boolean} active
 * @property {boolean} activating
 * @property {boolean} constructing
 * @property {{ value: Promise<any>, cancel(): Promise<void> } | undefined} construction
 * @property {() => Promise<void>} closeDependencies
 * @property {(() => Promise<void>) | undefined} closeNative
 */

const OwnerInterface = M.interface('SessionOwner', {
  create: M.callWhen(
    M.string(),
    M.string(),
    M.recordOf(M.string(), M.string()),
  ).returns(M.any()),
  inspect: M.callWhen(M.string()).returns(M.any()),
  revise: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  start: M.callWhen(M.string()).returns(M.any()),
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
 * @param {NativeSessionConstruction} [powers.native]
 * @param {() => void} [powers.assertActive] - Parent host-incarnation fence.
 */
export const makeSessionOwner = ({
  directory,
  provide,
  cancel,
  native,
  assertActive = () => {},
}) => {
  const records = makeSessionRecordStore(directory);
  const operations = makeResourceRegistry();
  /** @type {Map<string, {identifier: string, closed: boolean, facet: any}>} */
  const incarnations = new Map();
  const stopped = new Set();
  const stopVersions = new Map();
  /** @type {Map<string, NativeActivation>} */
  const started = new Map();
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
    const phase =
      (await E(entry).maybeReadText('lifecycle')) ??
      (native ? 'planned' : 'ready');
    [
      'planned',
      'constructing',
      'starting',
      'ready',
      'aborting',
      'stopping',
      'stopped',
      'removing',
      'removing-unstarted',
    ].includes(phase) || Fail`Unknown session lifecycle phase`;
    return harden({
      ...record,
      phase,
    });
  };

  /** @param {string} name */
  const fence = name => {
    stopVersions.set(name, harden({}));
    stopped.add(name);
    const incarnation = incarnations.get(name);
    if (incarnation) incarnation.closed = true;
    const active = started.get(name);
    if (active) {
      active.active = false;
      void active.closeDependencies().catch(() => {});
      if (active.constructing) {
        void active.construction?.cancel().catch(() => {});
      }
      if (active.activating) {
        // Starting is already persisted. Reach cancellation-dependent startup
        // without waiting behind its queue; that queue still owns the drain.
        void active.closeNative?.().catch(() => {});
      }
    }
  };

  /**
   * This ephemeral resolver crosses only into the dedicated native controller.
   * It avoids eagerly reviving credentials or infrastructure during cleanup.
   * @param {SessionRecord} record
   * @param {() => void} check
   */
  const dependencies = (record, check) => {
    let open = true;
    /** @type {Set<Promise<any>>} */
    const pending = new Set();
    const facet = makeExo(
      'SessionDependencies',
      M.interface('SessionDependencies', {
        get: M.callWhen(M.string()).returns(M.any()),
      }),
      {
        get: role => {
          check();
          open || Fail`Session dependency admission is closed`;
          !['client', 'worker', 'storage'].includes(role) ||
            Fail`Administrative session role is not a runtime dependency`;
          const id = record.references[role];
          id !== undefined || Fail`Unknown session dependency ${role}`;
          // Own the entire revival before it starts, including detached get
          // requests whose caller does not await or retain the returned promise.
          const operation = Promise.resolve().then(async () => {
            const value = await provide(id);
            check();
            open || Fail`Session dependency admission is closed`;
            return value;
          });
          pending.add(operation);
          void operation.then(
            () => pending.delete(operation),
            () => pending.delete(operation),
          );
          return operation;
        },
      },
    );
    const close = async () => {
      open = false;
      await Promise.allSettled([...pending]);
    };
    return harden({ facet, close });
  };

  /**
   * @param {SessionRecord} record
   * @param {any} target
   * @param {() => Promise<void>} closeDependencies
   */
  const makeNativeClose = (record, target, closeDependencies) => {
    let closed = false;
    /** @type {Promise<void> | undefined} */
    let pending;
    return () => {
      if (closed) return Promise.resolve();
      if (pending) return pending;
      let usingDependencies = true;
      const resolver = dependencies(record, () => {
        assertActive();
        usingDependencies || Fail`Session cleanup operation has ended`;
      });
      pending = (async () => {
        try {
          await Promise.all([
            E(target).terminate(record.plan, resolver.facet),
            closeDependencies(),
          ]);
        } finally {
          usingDependencies = false;
          await resolver.close();
        }
        closed = true;
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    };
  };

  /**
   * @param {string} name
   * @param {SessionRecord & {phase: string}} record
   * @param {boolean} removing
   */
  const cleanupNative = async (name, record, removing) => {
    if (!native) throw Fail`Native session construction is not configured`;
    const unstarted = [
      'planned',
      'constructing',
      'aborting',
      'stopped',
      'removing-unstarted',
    ].includes(record.phase);
    const entry = await recordDirectory(name);
    await E(entry).writeText(
      'lifecycle',
      removing
        ? unstarted
          ? 'removing-unstarted'
          : 'removing'
        : unstarted
          ? 'aborting'
          : 'stopping',
    );
    const clientId = record.references.client;
    const closed = (await E(entry).maybeReadText('native-closed')) === 'yes';
    if (!closed && unstarted) {
      await started.get(name)?.construction?.cancel();
    }
    if (!closed && !unstarted && clientId !== undefined) {
      const retained = started.get(name);
      const target =
        retained?.identifier === clientId
          ? retained.value
          : await native.provideClient(clientId);
      const close =
        retained?.closeNative ??
        makeNativeClose(record, target, async () => {});
      await close();
    }
    // Persist the native cleanup acknowledgement before cancelling the
    // controller worker. A failed reference deletion must not call a dead
    // controller on retry. Persistent storage removal has its own owner.
    if (!closed) await E(entry).writeText('native-closed', 'yes');
    // These controls refer to original contexts. Cancellation is never a
    // substitute for the controller's native cleanup acknowledgement above.
    if (clientId !== undefined) {
      await native.cancel(clientId, Error(`Session ${name} stopped`));
    }
    const workerId = record.references.worker;
    if (workerId !== undefined) {
      await native.cancel(workerId, Error(`Session ${name} worker stopped`));
    }
  };

  /**
   * @param {string} name
   * @param {() => void} checkAdmission
   */
  const start = async (name, checkAdmission) => {
    checkAdmission();
    if (!native) throw Fail`Native session construction is not configured`;
    const record = await inspect(name);
    if (!record || record.plan === undefined)
      throw Fail`Session record is incomplete`;
    const existing = started.get(name);
    if (existing?.active && record.phase === 'ready') return client(name);
    ['planned', 'stopped', 'ready'].includes(record.phase) ||
      Fail`Interrupted session startup or cleanup must finish before reuse`;
    // A new explicit start can follow a completed stop. Any later stop fences
    // this particular activation permanently, including its dependency facet.
    stopped.delete(name);
    /** @type {NativeActivation} */
    const activation = {
      identifier: '',
      value: undefined,
      active: true,
      activating: false,
      constructing: false,
      construction: undefined,
      closeDependencies: async () => {},
      closeNative: undefined,
    };
    started.set(name, activation);
    const check = () => {
      checkAdmission();
      assertActive();
      activation.active || Fail`Session incarnation is stopped`;
    };
    const entry = await recordDirectory(name);
    let identifier = record.references.client;
    if (identifier === undefined) {
      record.references.worker === undefined ||
        Fail`Session worker cleanup is incomplete`;
      await E(entry).writeText('native-closed', '');
      await E(entry).writeText('lifecycle', 'constructing');
      check();
      activation.construction = native.construct(
        name,
        async (workerId, clientId) => {
          check();
          await records.retain(name, 'worker', workerId);
          check();
          await records.retain(name, 'client', clientId);
          identifier = clientId;
          check();
        },
      );
      activation.constructing = true;
      try {
        activation.value = await activation.construction.value;
      } finally {
        activation.constructing = false;
      }
    } else {
      activation.value = await native.provideClient(identifier);
    }
    check();
    identifier !== undefined ||
      Fail`Native constructor did not publish its identity`;
    activation.identifier = identifier;
    await E(entry).writeText('lifecycle', 'starting');
    check();
    activation.construction = undefined;
    const resolver = dependencies(record, check);
    activation.closeDependencies = resolver.close;
    activation.closeNative = makeNativeClose(
      record,
      activation.value,
      resolver.close,
    );
    activation.activating = true;
    try {
      await E(activation.value).activate(record.plan, resolver.facet);
    } finally {
      activation.activating = false;
    }
    check();
    await E(entry).writeText('lifecycle', 'ready');
    check();
    return client(name);
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
    if (native) {
      !['removing', 'removing-unstarted'].includes(record.phase) ||
        Fail`Session removal must finish before reuse`;
      await cleanupNative(name, record, false);
      const owned = Object.fromEntries(
        Object.entries(record.references).filter(
          ([role]) => role === 'client' || role === 'worker',
        ),
      );
      await records.release(name, owned, async () => {});
      await E(entry).writeText('lifecycle', 'stopped');
      started.delete(name);
      incarnations.delete(name);
      stopped.delete(name);
      return;
    }
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
    if (native) {
      const running = started.get(name);
      (running?.active && running.identifier === identifier) ||
        Fail`Explicit session start is required in this daemon incarnation`;
    }
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
      const value = native
        ? started.get(name)?.value
        : await provide(identifier);
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
        if (native) {
          (references.client === undefined &&
            references.worker === undefined) ||
            Fail`Native session identities must be constructed by their owner`;
        }
        await records.create(name, plan, references);
        stopped.delete(name);
        return inspect(name);
      }),
    inspect: name => inOrder(name, () => inspect(name)),
    start: name => {
      const version = stopVersions.get(name);
      return inOrder(name, () =>
        start(name, () => {
          stopVersions.get(name) === version ||
            Fail`Session startup was interrupted`;
        }),
      );
    },
    revise: (name, plan) =>
      inOrder(name, async () => {
        const record = await inspect(name);
        if (!record) throw Fail`Missing session record`;
        record.plan !== undefined || Fail`Session record is incomplete`;
        record.phase !== 'removing' ||
          Fail`Session removal must finish before reuse`;
        record.phase !== 'stopping' ||
          Fail`Session stop must finish before reuse`;
        (record.references.client === undefined &&
          record.references.worker === undefined) ||
          Fail`Stop the client before revising its plan`;
        !native ||
          ['planned', 'stopped'].includes(record.phase) ||
          Fail`Session cleanup must finish before revising its plan`;
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
        if (native) {
          const record = await inspect(name);
          if (!record) return;
          record.plan !== undefined ||
            Fail`Incomplete session record requires its original cleanup plan`;
          await cleanupNative(name, record, true);
          await records.remove(name, async current => {
            const storageId = current.references.storage;
            if (storageId !== undefined) {
              const storage = await provide(storageId);
              await E(storage).remove(current.plan);
            }
          });
          started.delete(name);
          incarnations.delete(name);
          stopped.delete(name);
          stopVersions.delete(name);
          return;
        }
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
        stopVersions.delete(name);
      });
    },
    help: () =>
      'Host-only session records and lifecycle ownership. Inspection is passive; stop releases the client after containment; removal retains failed cleanup and its deletion intent.',
  });
};
harden(makeSessionOwner);
