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
 * adapter tools) are then used directly, so the manager vat is on the path
 * once per turn, not per operation. After a restart every one of them is a
 * tombstone; the manager re-attaches through its restore.
 *
 * Internal to W1a.2 (`designs/m1a-interfaces.md` section 11).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { shapes } from '../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

const { M, makeExo } = /** @type {any} */ (globalThis);

/** The one registration key of the agent-host manager. */
export const SERVICE_KEY = 'agent-host';

/**
 * The ops facet's guard: W1a.2-internal (the manager vat is its only
 * caller). Closed records, as every vat-facing pattern (rule 12.10).
 */
const makeOpsInterface = () =>
  M.interface('AgentHostOps', {
    open: M.call(
      M.splitRecord(
        {
          backend: M.remotable('Backend'),
          spec: shapes.BackendSpec,
          session: M.remotable('Session'),
        },
        {},
        {},
      ),
    ).returns(shapes.TurnPorts),
    liveChannel: M.call(M.remotable('Session')).returns(
      M.remotable('LivePublisher'),
    ),
    live: M.call().returns(M.remotable('Live')),
    composer: M.call().returns(M.remotable('Composer')),
  });

/**
 * @typedef {object} OpsHandlers
 * @property {(request: { backend: any, spec: any, session: any }) => any} open
 *   the backend's TurnPorts for one turn of `session`
 * @property {(session: any) => any} liveChannel the session channel's publisher
 * @property {() => any} live
 * @property {() => any} composer
 */

/**
 * @param {OpsHandlers} handlers
 */
export const makeOps = handlers =>
  makeExo('AgentHostOps', makeOpsInterface(), {
    /** @param {{ backend: any, spec: any, session: any }} request */
    open: request => handlers.open(request),
    /** @param {any} session */
    liveChannel: session => handlers.liveChannel(session),
    live: () => handlers.live(),
    composer: () => handlers.composer(),
  });
harden(makeOps);

/**
 * The `bind`/`unbind` pair `makeAdapter` needs: binding the service key
 * attaches `ops` to the manager and waits for the answer.
 *
 * @param {{ ops: any, incarnation: string }} options
 */
export const makeAttach = ({ ops, incarnation }) => {
  /**
   * @param {unknown} key
   * @param {any} spec
   */
  const bind = async (key, spec) => {
    if (key !== SERVICE_KEY)
      throw Error(`agent host has no registration ${JSON.stringify(key)}`);
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
