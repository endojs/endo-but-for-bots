// @ts-check
/**
 * The adapter half of the attach pattern (M1a W1a.2; architecture D-7,
 * proven by spike S2 with `test/spikes/fixtures/attach/`).
 *
 * The manager vat registers one service key whose spec carries its
 * `AgentHostSink`. `bind` awaits `E(spec.sink).attach(ops, incarnation)`,
 * so when the manager's reconcile returns, the manager holds this
 * incarnation's ops facet. The manager forwards `open()`-style calls to the
 * ops facet; the objects they return (Endpoint, publishers, Live, Composer,
 * adapter tools) are then used directly: a session opens its `TurnPorts`
 * once per adapter incarnation and holds them across turns (contract 6.1,
 * J-9151), so the manager vat is on the path once per incarnation, not per
 * turn. After a restart every one of them is a tombstone; the manager
 * re-attaches through its restore.
 *
 * Every `TurnPorts` this incarnation hands out carries `since`, when the
 * incarnation (this ops facet) was made, by this process's clock: a session
 * compares it with a turn's claim time to tell a turn in flight at a restart
 * from one claimed on ports that were already dead (contract section 7).
 *
 * Internal to W1a.2 (`designs/m1a-interfaces.md` section 11).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { shapes, textOf } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

const { M, makeExo } = /** @type {any} */ (globalThis);

/** The one registration key of the agent-host manager. */
export const SERVICE_KEY = 'agent-host';

/**
 * The ops facet's guard: W1a.2-internal (the manager vat is its only
 * caller). Closed records, as every vat-facing pattern (rule 12.10).
 */
const makeOpsInterface = () => {
  const key = shapes.Id;
  const done = M.undefined();
  // Counts cross as numbers (the store's generations, sizes and audit
  // limits); M.nat() is a bigint guard and refused every value (W2.9).
  const count = M.and(M.number(), M.gte(0));
  const backendRequest = (/** @type {Record<string, any>} */ optional) =>
    M.splitRecord(
      { backend: M.remotable('Backend'), spec: shapes.BackendSpec },
      optional,
      {},
    );
  return M.interface('AgentHostOps', {
    // M2 (W2.8): `archiveKey`, the archive key (`h<n>`) the manager keeps
    // for the session's host facet; the ports then carry `archive`.
    open: M.call(
      M.splitRecord(
        {
          backend: M.remotable('Backend'),
          spec: shapes.BackendSpec,
          session: M.remotable('Session'),
        },
        { archiveKey: key },
        {},
      ),
    ).returns(shapes.TurnPorts),
    liveChannel: M.call(M.remotable('Session')).returns(
      M.remotable('LivePublisher'),
    ),
    live: M.call().returns(M.remotable('Live')),
    composer: M.call().returns(M.remotable('Composer')),
    // M1b W1b.1
    content: M.call().returns(M.remotable('Content')),
    listPublisher: M.call().returns(M.remotable('ListPublisher')),
    // ---- M2 (m2-interfaces.md 3.4); each forwards to its handler or
    // throws textOf.notBuilt while the handler is absent.
    history: M.call().returns(M.remotable('History')),
    releaseBlobs: M.callWhen(
      M.arrayOf(key, { arrayLengthLimit: limits.blobResolveBatch }),
    ).returns(done),
    releaseArchive: M.callWhen(key).returns(done),
    writersFor: M.call()
      .optional(M.remotable('Session'))
      .returns(M.remotable('BlobWriters')),
    listModels: M.callWhen(
      backendRequest({ request: shapes.ModelRequest }),
    ).returns(shapes.ModelPage),
    resolveModel: M.callWhen(
      backendRequest({ modelId: shapes.ModelId }),
    ).returns(shapes.ResolvedModel),
    secretCreate: M.callWhen(
      M.splitRecord(
        {
          key,
          label: shapes.Label,
          description: M.string({
            stringLengthLimit: limits.secretDescriptionUnits,
          }),
        },
        {},
        {},
      ),
    ).returns(done),
    secretDescribe: M.callWhen(key).returns(
      M.splitRecord(
        {
          generation: count,
          state: M.or('active', 'revoked'),
          bytes: count,
        },
        {},
        {},
      ),
    ),
    secretRevoke: M.callWhen(key).returns(done),
    secretDelete: M.callWhen(key).returns(done),
    secretAudit: M.callWhen(
      M.splitRecord({ limit: count }, { key }, {}),
    ).returns(shapes.AuditPage),
    secretWriter: M.callWhen().returns(M.remotable('SecretWriter')),
  });
};

/** M2 ops methods that forward to an optional handler (m2-interfaces.md 3.4). */
const M2_FORWARDS = harden([
  'history',
  'writersFor',
  'listModels',
  'resolveModel',
  'secretDescribe',
  'secretAudit',
  'secretWriter',
]);
/** M2 ops methods whose answer is only "done". */
const M2_DONE = harden([
  'releaseBlobs',
  'releaseArchive',
  'secretCreate',
  'secretRevoke',
  'secretDelete',
]);

/**
 * @typedef {object} OpsHandlers
 * @property {(request: { backend: any, spec: any, session: any, archiveKey?: string }) => any} open
 *   the backend's TurnPorts for `session` (endpoint, publisher, tools; the
 *   ops facet adds `since`), held by the session for this incarnation
 * @property {(session: any) => any} liveChannel the session channel's publisher
 * @property {() => any} live
 * @property {() => any} composer
 * @property {() => any} content M1b: this incarnation's Content
 * @property {() => any} [listPublisher] M1b: the list channel's publisher
 *   (W1b.5's `AH/list-channel.js`); refused without one
 * @property {() => any} [history] M2 (W2.8): the `History` exo
 * @property {(keys: string[]) => Promise<unknown>} [releaseBlobs] M2: delete
 *   the blob files the manager's keys name (M1b 4.8)
 * @property {(key: string) => Promise<unknown>} [releaseArchive] M2: delete
 *   a session's archive (4.11)
 * @property {(session?: any) => any} [writersFor] M2: BlobWriters for a
 *   session, or for none yet
 * @property {(request: any) => Promise<any>} [listModels] M2 (W2.2)
 * @property {(request: any) => Promise<any>} [resolveModel] M2 (W2.2)
 * @property {(request: any) => Promise<unknown>} [secretCreate] M2 (W2.3)
 * @property {(key: string) => Promise<any>} [secretDescribe] M2 (W2.3)
 * @property {(key: string) => Promise<unknown>} [secretRevoke] M2 (W2.3)
 * @property {(key: string) => Promise<unknown>} [secretDelete] M2 (W2.3)
 * @property {(request: any) => Promise<any>} [secretAudit] M2 (W2.3)
 * @property {() => Promise<any>} [secretWriter] M2 (W2.3)
 */

/**
 * @param {OpsHandlers} handlers `open` answers the ports without `since`
 * @param {() => number} [now]
 */
export const makeOps = (handlers, now = () => Date.now()) => {
  const since = now();
  return makeExo('AgentHostOps', makeOpsInterface(), {
    /** @param {{ backend: any, spec: any, session: any, archiveKey?: string }} request */
    open: request => harden({ ...handlers.open(request), since }),
    /** @param {any} session */
    liveChannel: session => handlers.liveChannel(session),
    live: () => handlers.live(),
    composer: () => handlers.composer(),
    content: () => handlers.content(),
    listPublisher: () => {
      if (handlers.listPublisher === undefined)
        throw Error('this agent host has no session list feed yet');
      return handlers.listPublisher();
    },
    ...Object.fromEntries(
      M2_FORWARDS.map(name => [
        name,
        /** @param {any[]} args */
        (...args) => {
          const handler = /** @type {any} */ (handlers)[name];
          if (handler === undefined) throw Error(textOf.notBuilt(name));
          return handler(...args);
        },
      ]),
    ),
    ...Object.fromEntries(
      M2_DONE.map(name => [
        name,
        /** @param {any[]} args */
        async (...args) => {
          const handler = /** @type {any} */ (handlers)[name];
          if (handler === undefined) throw Error(textOf.notBuilt(name));
          await handler(...args);
          return undefined;
        },
      ]),
    ),
  });
};
harden(makeOps);

/**
 * The `bind`/`unbind` pair `makeAdapter` needs: binding the service key
 * attaches `ops` to the manager and waits for the answer.
 *
 * @param {object} options
 * @param {any} options.ops
 * @param {string} options.incarnation
 * @param {(sink: any) => Promise<void> | void} [options.onSink] M1b: told
 *   the manager's sink before attaching (the blob store mints and resolves
 *   handles through it; its `*.part` sweep runs here)
 */
export const makeAttach = ({ ops, incarnation, onSink = () => {} }) => {
  /**
   * @param {unknown} key
   * @param {any} spec
   */
  const bind = async (key, spec) => {
    if (key !== SERVICE_KEY)
      throw Error(`agent host has no registration ${JSON.stringify(key)}`);
    await onSink(spec.sink);
    await E(spec.sink).attach(ops, incarnation);
    return harden({ key });
  };
  /**
   * Nothing to release: the ops facet dies with this process.
   * @param {unknown} _binding
   * @param {unknown} _key
   */
  const unbind = (_binding, _key) => undefined;
  return harden({ bind, unbind });
};
harden(makeAttach);
