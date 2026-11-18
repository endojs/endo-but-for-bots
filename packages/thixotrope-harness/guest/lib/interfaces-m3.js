// @ts-check
/**
 * The M3 interface contract (milestones.md M3 W3.0; `designs/m3-interfaces.md`
 * says who calls each method, in which crank, answered or sendOnly, the
 * largest message and what a retired break from it means).
 *
 * M3 adds the chat gateway. Only a few of its objects cross a vat boundary:
 * the gateway's durable registration in the agent-host manager vat
 * (`GatewayAdmin`, reached from `AgentHostAdmin.gateway()`), the sink the
 * adapter attaches to it (`GatewaySink`) and the adapter facet the manager
 * calls (`GatewayOps`). The browser-facing bootstrap (`GatewayBootstrap`)
 * and its answer (`GatewayPowers`) never enter a vat; their guards are here
 * so the gateway (Node) and tests share them. Every other object a browser
 * holds is an M1a/M1b/M2 object passed through unchanged (m3-interfaces.md
 * section 3): M3 adds no method to any session, factory or turn object.
 *
 * This module imports only `limits.js`. `interfaces.js` does NOT import it
 * (it would put manager-only code into the session and exec bundles): the
 * manager's facet guard is extended in `durable.js` with
 * `withGatewayAdmin(m2Interfaces.AgentHostAdmin)` (m3-interfaces.md 11,
 * hotspot H2), so only the manager bundle carries this file. It builds its
 * guards lazily, as `interfaces.js` does.
 *
 * Gateway key vocabulary (m3-interfaces.md 4.4, 6.3): the gateway loads
 * every `guest/lib/interfaces-m*.js` file and walks the patterns its
 * `vocabularyShapes()` export answers (shapes and interface guards, whose
 * method argument patterns are walked too); a file without the export is
 * logged and skipped.
 *
 * Runs in vats (the manager vat bundles it through `durable-gateway.js`
 * and `durable.js`) and in Node (prelude installed first, as for
 * `interfaces.js`).
 */
import { limits } from './limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);
if (M === undefined) {
  throw TypeError(
    'guest/lib/interfaces-m3.js needs the guest prelude on globalThis; in Node call installGuestPrelude() from scripts/guest-prelude.js before importing it',
  );
}

// ---------------------------------------------------------------- helpers

/** @param {number} units */
const text = units => M.string({ stringLengthLimit: units });
/**
 * @param {any} shape
 * @param {number} length
 */
const list = (shape, length) => M.arrayOf(shape, { arrayLengthLimit: length });
/**
 * A closed record (rule 12.10): these keys and no others.
 * @param {Record<string, any>} required
 * @param {Record<string, any>} [optional]
 */
const record = (required, optional = {}) =>
  M.splitRecord(required, optional, {});
const count = M.and(M.number(), M.gte(0));
const done = M.undefined();
/** @param {string} label */
const R = label => M.remotable(label);

/**
 * A hardened record whose properties are built on first read and kept (as
 * `interfaces.js` `lazyTable`).
 * @template {Record<string, () => any>} T
 * @param {T} builders
 * @returns {{ readonly [K in keyof T]: ReturnType<T[K]> }}
 */
const lazyTable = builders => {
  /** @type {Map<string, any>} */
  const built = new Map();
  /** @type {any} */
  const table = {};
  for (const [name, build] of Object.entries(builders)) {
    // The names are this module's own table keys, fixed in its source.
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    Object.defineProperty(table, name, {
      enumerable: true,
      get: () => {
        if (!built.has(name)) built.set(name, build());
        return built.get(name);
      },
    });
  }
  return harden(table);
};

// ---------------------------------------------------------------- constants

/**
 * The manager-kit registration key of the gateway (m3-interfaces.md 3.1):
 * a second key of the agent-host native resource, beside `agent-host`. A
 * reference leaving the object system (F.2 c: the kit's key).
 */
export const GATEWAY_KEY = 'gateway';

/**
 * M3 settings that bound what crosses a vat boundary. Adapter-only settings
 * (connections, WebSocket sizes, the limiter) are in
 * `resources/agent-host/impl/gateway/contract-m3.js` `gatewayLimits`.
 */
export const m3Limits = harden({
  /** `GatewayConfig.trustedProxies`: at most this many addresses. */
  trustedProxies: 16,
  /** One trusted proxy address (IPv4 or IPv6 text, no port). */
  proxyAddressUnits: 64,
  /** `GatewayConfig.publicOrigin` and `GatewayStatus.origin`. */
  originUnits: limits.urlUnits,
  /** TCP port (0: an ephemeral port, for tests). */
  maxPort: 65_535,
  /**
   * The sign-in secret a browser presents to `GatewayBootstrap.fetch`: 64
   * lowercase hex digits (32 random bytes). The guard admits up to 256 units
   * so a wrong secret is refused by comparison (and penalised), not by the
   * guard; longer text is refused by the guard before any comparison.
   */
  signInUnits: 256,
  /** Gateway-local extension services in `GatewayPowers.extras`. */
  extras: 32,
  /** `GatewayConfig.signInFailuresPerMinute` upper bound. */
  maxSignInFailuresPerMinute: 10_000,
});

// ---------------------------------------------------------------- texts

/** Fixed texts of the objects in this module (m3-interfaces.md 14). */
export const m3Texts = harden({
  /** `GatewayAdmin.status()` before any `serve` or after `stop`. */
  gatewayNotServing: 'The gateway is not serving',
  /** `GatewayAdmin.rotateSignIn()` while no adapter incarnation serves it. */
  gatewayNotAttached: 'The gateway is not attached to an agent host yet',
  /** `GatewayBootstrap.fetch` with a wrong secret (after the penalty). */
  signInRefused: 'Sign-in refused',
  /** The global ceiling of failed sign-ins (architecture 7, W-8). */
  signInCeiling: 'Too many failed sign-ins; try again in a minute',
});

/** Fixed texts with an argument (m3-interfaces.md 14). */
export const m3TextOf = harden({
  /**
   * R7-49 word for word: an attempt during the penalty.
   * @param {number} ms
   */
  rateLimited: ms => `Rate limit exceeded, try in ${Math.ceil(ms)}ms`,
  /**
   * `GatewayStatus.error` when the listener could not bind.
   * @param {string} message
   */
  gatewayFailed: message => `The gateway could not serve: ${message}`,
});

// ---------------------------------------------------------------- shapes

const m3ShapeBuilders = {
  /** Where the gateway's registration stands (m3-interfaces.md 3.1). */
  GatewayState: () => M.or('starting', 'serving', 'failed', 'stopped'),
  /**
   * `GatewayAdmin.serve` argument. `operator` is the one object a signed-in
   * browser receives (F.1 #10, W-1); `port` 0 binds an ephemeral port
   * (tests); the gateway always binds 127.0.0.1 (D-12). `publicOrigin`
   * (`https://host` or `http://127.0.0.1:port`, no path) is the only Origin
   * a WebSocket upgrade may carry; absent: `http://127.0.0.1:<port>` and
   * `http://localhost:<port>`. `trustedProxies`: socket peers whose
   * right-most untrusted `X-Forwarded-For` entry names the client (W-8).
   */
  GatewayConfig: () =>
    record(
      {
        operator: R('Operator'),
        port: M.and(count, M.lte(m3Limits.maxPort)),
      },
      {
        publicOrigin: text(m3Limits.originUnits),
        trustedProxies: list(
          text(m3Limits.proxyAddressUnits),
          m3Limits.trustedProxies,
        ),
        signInFailuresPerMinute: M.and(
          count,
          M.gte(1),
          M.lte(m3Limits.maxSignInFailuresPerMinute),
        ),
      },
    ),
  /**
   * The manager-kit spec under `GATEWAY_KEY` (manager -> adapter `bind`):
   * the manager's sink and the operator's configuration. Spike S7 (J-0162):
   * a spec may carry a consumer vat's remotable (the operator) across clean
   * and SIGKILL restarts.
   */
  GatewaySpec: () =>
    record({ sink: R('GatewaySink'), config: m3Shapes.GatewayConfig }),
  /**
   * What `GatewayAdmin.serve` / `status` answer. `port` and `origin` once
   * bound; `since` is when the serving incarnation bound (ms, adapter
   * clock); `error` a fixed text plus the listener's message, never a
   * secret.
   */
  GatewayStatus: () =>
    record(
      { state: m3Shapes.GatewayState },
      {
        port: M.and(count, M.lte(m3Limits.maxPort)),
        origin: text(m3Limits.originUnits),
        connections: count,
        since: count,
        error: text(limits.reasonUnits),
      },
    ),
  /** One gateway-local extension service (m3-interfaces.md 6.1). */
  GatewayExtra: () =>
    record({ label: text(limits.labelUnits), service: M.remotable() }),
  /**
   * `GatewayBootstrap.fetch` answer (browser only; never enters a vat).
   * `operator` is the factory vat's Operator presence, passed through;
   * the rest are gateway-local objects of this adapter incarnation.
   */
  GatewayPowers: () =>
    record({
      operator: R('Operator'),
      live: R('Live'),
      content: R('Content'),
      composer: R('Composer'),
      history: R('History'),
      extras: list(m3Shapes.GatewayExtra, m3Limits.extras),
    }),
};

/** M3's shapes, built on first use. */
export const m3Shapes = lazyTable(m3ShapeBuilders);

// ---------------------------------------------------------------- interfaces

const m3InterfaceBuilders = {
  /**
   * Manager vat (durable; `resources/agent-host/durable-gateway.js`): the
   * gateway's registration. Held by whoever holds `AgentHostAdmin` (the
   * factory and the operator; provisioning and tests reach it through the
   * operator's inventory). Never reaches a session or exec vat.
   */
  GatewayAdmin: () =>
    M.interface('GatewayAdmin', {
      serve: M.callWhen(m3Shapes.GatewayConfig).returns(m3Shapes.GatewayStatus),
      status: M.callWhen().returns(m3Shapes.GatewayStatus),
      rotateSignIn: M.callWhen().returns(done),
      stop: M.callWhen().returns(done),
    }),
  /**
   * Manager vat: carried in `GatewaySpec.sink`; the adapter's `bind` of
   * `GATEWAY_KEY` calls `attach` once per incarnation, after it listens.
   */
  GatewaySink: () =>
    M.interface('GatewaySink', {
      attach: M.call(R('GatewayOps'), m3Shapes.GatewayStatus).returns(count),
    }),
  /** Adapter (transient): what the manager forwards to. */
  GatewayOps: () =>
    M.interface('GatewayOps', {
      status: M.call().returns(m3Shapes.GatewayStatus),
      rotateSignIn: M.callWhen().returns(done),
    }),
  /**
   * Adapter, browser-facing (never in a vat): the CapTP bootstrap of every
   * WebSocket connection. One method (R6-75); the secret is compared in
   * constant time and a failure is penalised (R7-49, W-8).
   */
  GatewayBootstrap: () =>
    M.interface('GatewayBootstrap', {
      fetch: M.callWhen(text(m3Limits.signInUnits)).returns(
        m3Shapes.GatewayPowers,
      ),
    }),
};

/** M3's interface guards, built on first use. */
export const m3Interfaces = lazyTable(m3InterfaceBuilders);

/** Method names per M3 interface, in declaration order. */
export const m3MethodNames = harden({
  GatewayAdmin: ['serve', 'status', 'rotateSignIn', 'stop'],
  GatewaySink: ['attach'],
  GatewayOps: ['status', 'rotateSignIn'],
  GatewayBootstrap: ['fetch'],
});

// ---------------------------------------------------------------- seams

/**
 * The method M3 adds to `AgentHostAdmin` (m3-interfaces.md 11, hotspot H2).
 * `interfaces.js` and `m2MethodNames` are not edited: the full name list of
 * the manager's facet is `[...m2MethodNames.AgentHostAdmin,
 * ...m3AgentHostAdminMethodNames]` (checked by `m3-interfaces.test.js`).
 */
export const m3AgentHostAdminMethods = () =>
  harden({ gateway: M.call().returns(R('GatewayAdmin')) });
export const m3AgentHostAdminMethodNames = harden(['gateway']);

/**
 * `base` (the `AgentHostAdmin` guard `durable.js`'s facet uses:
 * `m2Interfaces.AgentHostAdmin`, after the W2.9 fold
 * `interfaces.AgentHostAdmin`) plus `gateway()`, as one interface guard of
 * the same name. Reads `base.payload.methodGuards` (an internal shape of
 * `@endo/patterns`, the technique of M5's D-M5-5, pinned by
 * `m3-interfaces.test.js`; core request CC-072 asks for
 * `getInterfaceGuardPayload` in the prelude instead). If a later lane also
 * extends `AgentHostAdmin` this way, the calls nest:
 * `withGatewayAdmin(withX(base))`.
 * @param {any} base an `M.interface` guard named `AgentHostAdmin`
 */
export const withGatewayAdmin = base =>
  M.interface('AgentHostAdmin', {
    ...base.payload.methodGuards,
    ...m3AgentHostAdminMethods(),
  });
harden(withGatewayAdmin);

/**
 * Patterns whose record keys a browser may send through the gateway
 * (m3-interfaces.md 4.4, 6.3): every shape and interface guard of this file
 * (an interface's method argument patterns are walked). Each
 * `interfaces-m*.js` file that has browser-reachable records exports one; a
 * file without it is logged and skipped by the gateway.
 */
export const vocabularyShapes = () =>
  harden([...Object.values(m3Shapes), ...Object.values(m3Interfaces)]);
