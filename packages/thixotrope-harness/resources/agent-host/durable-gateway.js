// @ts-check
/**
 * The gateway's durable registration in the agent-host manager vat (M3
 * W3.3; `designs/m3-interfaces.md` 3.1, D-M3-3).
 *
 * `AgentHostAdmin.gateway()` answers the one `GatewayAdmin` this module
 * makes. The listener's configuration (its `Operator` included) is kept here
 * and registered with the manager kit under `GATEWAY_KEY`, a second key of
 * the agent-host native resource beside `agent-host`; the kit restores it at
 * every new adapter incarnation, whose `bind` listens and then calls
 * `GatewaySink.attach(ops, status)`. The manager forwards `status` and
 * `rotateSignIn` to that ops facet; it never sees the sign-in secret, a
 * connection or a browser object (architecture 12.7).
 *
 * Retained state is one registration: its handle, its config, the last ops
 * facet and the status it attached with (a tombstone after a restart,
 * replaced by the next attach). Nothing grows.
 *
 * Runs in a vat: prelude globals only (architecture 12).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  GATEWAY_KEY,
  m3Interfaces,
  m3Texts,
  m3TextOf,
} from '../../guest/lib/interfaces-m3.js';
import { limits } from '../../guest/lib/limits.js';
import { isRetiredBreak } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */

const { E, makeExo } = /** @type {any} */ (globalThis);

/**
 * Room left in `GatewayStatus.error` for the kit's message after the fixed
 * text of `m3TextOf.gatewayFailed`.
 */
const FAILURE_MESSAGE_UNITS = limits.reasonUnits - 128;

/** @param {unknown} message */
const failedStatus = message =>
  harden({
    state: 'failed',
    error: m3TextOf.gatewayFailed(
      String(message).slice(0, FAILURE_MESSAGE_UNITS),
    ),
  });

/** @param {unknown} error */
const messageOf = error =>
  typeof error === 'object' && error !== null && 'message' in error
    ? /** @type {any} */ (error).message
    : error;

/**
 * @param {object} powers
 * @param {{ register: (key: unknown, spec: any) => Promise<{ handle: any, status: any }> }} powers.manager
 *   the agent-host manager kit (`durable.js`'s `makeManager` result)
 */
export const makeGatewayManager = ({ manager }) => {
  /** The kit's handle of the gateway registration, while one is desired. */
  let handle;
  /** The `GatewayConfig` last served (its `Operator` included). */
  let config;
  /** The `GatewayOps` facet of the incarnation that attached last. */
  let ops;
  /** The status that incarnation attached with. */
  let attachedStatus;
  /** The failed status of the last `serve`, until an incarnation attaches. */
  let failure;
  let attaches = 0;

  /**
   * One admin operation at a time: a `serve` closes and registers in
   * several cranks, and a `status` or `stop` between them would see half of
   * it. One promise is retained.
   */
  let tail = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const serial = fn => {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const sink = makeExo('GatewaySink', m3Interfaces.GatewaySink, {
    /**
     * Once per adapter incarnation, from its `bind` of `GATEWAY_KEY`,
     * after it listens.
     * @param {any} opsFacet
     * @param {any} status
     */
    attach: (opsFacet, status) => {
      attaches += 1;
      // A late attach after `stop` (none is expected: the kit serialises
      // bind and close) is counted but not kept.
      if (config !== undefined) {
        ops = opsFacet;
        attachedStatus = status;
        failure = undefined;
      }
      return attaches;
    },
  });

  /** Close the registration if there is one, then forget everything. */
  const closeRegistration = async () => {
    if (handle !== undefined) {
      // Closed first and forgotten after, so a crash in between leaves a
      // handle a later `stop` or `serve` closes (a closed one answers false).
      await E(handle).close();
    }
    handle = undefined;
    config = undefined;
    ops = undefined;
    attachedStatus = undefined;
    failure = undefined;
  };

  const admin = makeExo('GatewayAdmin', m3Interfaces.GatewayAdmin, {
    /** @param {any} wanted a `GatewayConfig` (checked by the guard) */
    serve: wanted =>
      serial(async () => {
        await closeRegistration();
        // Kept before registering, in the crank that registers, so an
        // attach from the bind (or from a restore after a crash here,
        // m3-interfaces.md 7 K1) finds it.
        config = wanted;
        let registered;
        try {
          registered = await manager.register(
            GATEWAY_KEY,
            harden({ sink, config: wanted }),
          );
        } catch (error) {
          config = undefined;
          return failedStatus(messageOf(error));
        }
        handle = registered.handle;
        const { status } = registered;
        if (status.status !== 'bound') {
          // The kit keeps the registration desired; `stop` closes it.
          failure = failedStatus(status.error ?? status.status);
          return failure;
        }
        return attachedStatus ?? harden({ state: 'starting' });
      }),
    status: () =>
      serial(async () => {
        if (handle === undefined) return harden({ state: 'stopped' });
        if (ops === undefined) return failure ?? harden({ state: 'starting' });
        try {
          return await E(ops).status();
        } catch (error) {
          // The adapter restarted and the restore has not attached yet.
          if (isRetiredBreak(error)) return harden({ state: 'starting' });
          throw error;
        }
      }),
    rotateSignIn: () =>
      serial(async () => {
        if (handle === undefined || ops === undefined)
          throw Error(m3Texts.gatewayNotAttached);
        try {
          await E(ops).rotateSignIn();
          return undefined;
        } catch (error) {
          if (!isRetiredBreak(error)) throw error;
        }
        // The ops facet is a tombstone: reconcile the registration once (the
        // kit builds an incarnation, whose restore attaches) and try again.
        const before = ops;
        await E(handle).status();
        if (ops === before) throw Error(m3Texts.gatewayNotAttached);
        try {
          await E(ops).rotateSignIn();
        } catch (error) {
          if (isRetiredBreak(error)) throw Error(m3Texts.gatewayNotAttached);
          throw error;
        }
        return undefined;
      }),
    stop: () =>
      serial(async () => {
        await closeRegistration();
        return undefined;
      }),
  });

  return harden({ admin });
};
harden(makeGatewayManager);
