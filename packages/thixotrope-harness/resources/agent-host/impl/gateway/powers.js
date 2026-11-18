// @ts-check
/**
 * The gateway's CapTP bootstrap and the powers a signed-in page receives
 * (M3 W3.2; designs/m3-interfaces.md 3.2, 4.3).
 *
 * `makeBootstrapFactory(options)` answers `({ address, onClose }) ->
 * GatewayBootstrap`, one bootstrap per WebSocket connection. Its one method,
 * `fetch(secret)`, applies the limiter first (an address inside its penalty,
 * or the global ceiling, is refused before any comparison), then compares
 * the secret through the sign-in store (digest, constant time); a failure
 * is recorded and refused with `m3Texts.signInRefused`. A success answers
 * the connection's `GatewayPowers`: the operator (the vat presence, passed
 * through), a per-connection `Live` facade, and the incarnation's
 * `content`, `composer`, `history` and `extras`. A second success on one
 * connection answers the same record.
 *
 * The `Live` facade wraps each subscription it hands out, keeps the open
 * ones, and closes them when the connection closes (`onClose`), so a page
 * that goes away never leaves a channel subscriber behind; a page's own
 * `close()` forgets it at once.
 *
 * Gateway-local objects (the bootstrap, the facade and its subscriptions,
 * content, composer, history, extras services) are marked here; the bridge
 * reads `isGatewayLocal` so calls on them do not count as calls in flight
 * to a vat (m3-interfaces.md 4.4 rule 5; CC-050's workaround: everything
 * else counts as a vat target).
 *
 * The secret never leaves this module's caller: it is not logged, stored or
 * passed on.
 *
 * Node module (agent-host adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { m1bInterfaces } from '../../../../guest/lib/interfaces.js';
import { m3Interfaces, m3Texts } from '../../../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** @type {WeakSet<object>} */
const gatewayLocal = new WeakSet();

/**
 * Mark objects of this adapter process as gateway-local (not vat
 * presences). Idempotent; non-objects are ignored.
 * @param {...unknown} values
 */
export const markGatewayLocal = (...values) => {
  for (const value of values) {
    if (value !== null && typeof value === 'object') gatewayLocal.add(value);
  }
};
harden(markGatewayLocal);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export const isGatewayLocal = value =>
  value !== null && typeof value === 'object' && gatewayLocal.has(value);
harden(isGatewayLocal);

/**
 * @template T
 * @param {T | (() => T)} valueOrGetter
 * @returns {T}
 */
const current = valueOrGetter =>
  typeof valueOrGetter === 'function'
    ? /** @type {() => T} */ (valueOrGetter)()
    : valueOrGetter;

/**
 * A per-connection `Live` facade over the incarnation's `Live`.
 * @param {any} live
 */
const makeLiveFacade = live => {
  /** @type {Set<any>} */
  const open = new Set();
  let closed = false;

  /**
   * @param {string} label
   * @param {any} guard
   * @param {any} inner
   */
  const wrap = (label, guard, inner) => {
    const subscription = makeExo(label, guard, {
      async next() {
        return E(inner).next();
      },
      close() {
        if (open.delete(subscription)) {
          void E(inner)
            .close()
            .catch(() => {});
        }
      },
    });
    markGatewayLocal(subscription);
    if (closed) {
      void E(inner)
        .close()
        .catch(() => {});
    } else {
      open.add(subscription);
    }
    return subscription;
  };

  const facade = makeExo('Live', m1bInterfaces.Live, {
    /**
     * @param {any} session
     * @param {number} [rev]
     */
    async subscribe(session, rev) {
      const inner = await E(live).subscribe(session, rev);
      return wrap('LiveSubscription', m1bInterfaces.LiveSubscription, inner);
    },
    /** @param {number} [rev] */
    async subscribeList(rev) {
      const inner = await E(live).subscribeList(rev);
      return wrap('ListSubscription', m1bInterfaces.ListSubscription, inner);
    },
  });
  markGatewayLocal(facade);

  /** Close every open subscription (each wrapper's close forgets it). */
  const close = () => {
    closed = true;
    for (const subscription of [...open]) subscription.close();
  };
  return harden({ facade, close, openCount: () => open.size });
};

/**
 * @typedef {object} SignInCheck
 * @property {(candidate: string) => boolean} matches
 */

/**
 * @typedef {object} SignInLimiter
 * @property {(address: string) => { ok: true } | { ok: false, text: string }} check
 * @property {(address: string) => void} failed
 * @property {(address: string) => void} succeeded
 */

/**
 * @param {object} options
 * @param {SignInCheck} options.signIn the sign-in store (`signin.js`)
 * @param {SignInLimiter} options.limiter (`limiter.js`)
 * @param {any} options.operator the `Operator` presence, or a function
 *   answering the current one (the registration's config may change)
 * @param {any} options.live the incarnation's `Live`
 * @param {any} options.content
 * @param {any} options.composer
 * @param {any} options.history the `History`, or a function answering it
 * @param {{ label: string, service: any }[] | (() => { label: string, service: any }[])} [options.extras]
 * @param {(event: Record<string, unknown>) => void} [options.log]
 * @returns {(connection: { address: string, onClose: (callback: () => void) => void }) => any}
 */
export const makeBootstrapFactory = ({
  signIn,
  limiter,
  operator,
  live,
  content,
  composer,
  history,
  extras = [],
  log = () => {},
}) => {
  markGatewayLocal(content, composer);
  if (typeof history !== 'function') markGatewayLocal(history);

  return ({ address, onClose }) => {
    /** @type {any} */
    let powers;
    /** @type {ReturnType<typeof makeLiveFacade> | undefined} */
    let liveFacade;
    let closed = false;
    onClose(() => {
      closed = true;
      liveFacade?.close();
    });

    const bootstrap = makeExo('GatewayBootstrap', m3Interfaces.GatewayBootstrap, {
      /** @param {string} secret */
      async fetch(secret) {
        const allowed = limiter.check(address);
        if (!allowed.ok) throw Error(allowed.text);
        if (!signIn.matches(secret)) {
          limiter.failed(address);
          log({ event: 'gateway-signin-failed', address });
          throw Error(m3Texts.signInRefused);
        }
        limiter.succeeded(address);
        if (powers !== undefined) return powers;
        if (closed) throw Error(m3Texts.signInRefused);
        liveFacade = makeLiveFacade(live);
        const extraList = harden(
          current(extras).map(({ label, service }) => {
            markGatewayLocal(service);
            return harden({ label, service });
          }),
        );
        const historyNow = current(history);
        markGatewayLocal(historyNow);
        powers = harden({
          operator: current(operator),
          live: liveFacade.facade,
          content,
          composer,
          history: historyNow,
          extras: extraList,
        });
        return powers;
      },
    });
    markGatewayLocal(bootstrap);
    return bootstrap;
  };
};
harden(makeBootstrapFactory);
