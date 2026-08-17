// @ts-check

/**
 * @file `@endo/gateway` package entrypoint.
 *
 * Exposes the `makeGateway({ powers, config })` factory the
 * design's Package Shape section names. The phase-1 skeleton
 * returns a hardened gateway exo whose `start` / `stop` are
 * lifecycle no-ops and whose `getApps` returns an in-memory
 * `AppsNameHub`; the network surface and the feature subsystems
 * land in follow-on PRs.
 *
 * The factory is named `makeGateway` rather than `make` so that
 * downstream consumers (`@endo/daemon`, the Familiar shell, the
 * future `@endo/gateway-daemon` wrapper) can import it under a
 * descriptive name without renaming at the call site.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, X } from '@endo/errors';

import {
  mergeGatewayConfig,
  parseBindAddress,
  bindAddressFromEnv,
} from './src/config.js';
import { makeAppsNameHub } from './src/vhost.js';
import { makeGatewayBootstrap } from './src/bootstrap.js';
import { makeGatewayAdmin } from './src/admin.js';
import { makeOcapnWebSocketHandler } from './src/ocapn-ws.js';

export {
  DEFAULT_BIND_ADDRESS,
  defaultFeatureToggles,
  defaultGatewayConfig,
  parseBindAddress,
  mergeGatewayConfig,
  bindAddressFromEnv,
} from './src/config.js';

export { normalizeVirtualHostName, makeAppsNameHub } from './src/vhost.js';

export {
  NONCE_DOMAIN_SEPARATION_PREFIX,
  NONCE_BYTE_LENGTH,
  DEFAULT_NONCE_TTL_MS,
  hashNonceForSigning,
  constantTimeEqual,
  makeNonceRegistry,
} from './src/proof-of-possession.js';

export {
  ED25519_PUBLIC_KEY_LENGTH,
  ED25519_SIGNATURE_LENGTH,
  makeGatewayBootstrap,
} from './src/bootstrap.js';

export { makeGatewayAdmin } from './src/admin.js';

export {
  OCAPN_WEBSOCKET_PATH,
  OCAPN_WEBSOCKET_LEGACY_PATH,
  OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH,
  isOcapnWebSocketPath,
  makeOcapnWebSocketHandler,
} from './src/ocapn-ws.js';

export {
  resolveBootstrapSocketPath,
  resolveAdminSocketPath,
  BOOTSTRAP_SOCKET_BASENAME,
  ADMIN_SOCKET_BASENAME,
  SYSTEM_RUNTIME_DIR_LINUX,
  USER_RUNTIME_SUBDIR,
} from './src/sock-paths.js';

/** @import { GatewayConfig, BindAddress, GatewayPowers, Gateway } from './src/types.js' */
/** @import { GatewayAdmin } from './src/admin.js' */
/** @import { OcapnWebSocketHandler } from './src/ocapn-ws.js' */

const GatewayInterface = M.interface('Gateway', {
  start: M.call().returns(M.promise()),
  stop: M.call().returns(M.promise()),
  getBindAddress: M.call().returns(M.promise()),
  getApps: M.call().returns(M.promise()),
  getConfig: M.call().returns(M.promise()),
  getBootstrap: M.call().returns(M.promise()),
  getAdmin: M.call().returns(M.promise()),
  getOcapnHandler: M.call().returns(M.promise()),
});

/**
 * Create a hardened gateway exo. See `designs/gateway-package.md`
 * § Package Shape for the long-form contract.
 *
 * @param {object} args
 * @param {GatewayPowers} [args.powers]
 * @param {Partial<GatewayConfig>} [args.config]
 * @returns {Gateway}
 */
export const makeGateway = ({ powers = {}, config: configIn = {} } = {}) => {
  const env = powers.env ?? {};
  // Environment beats config for the bind address, per the
  // design's three-layer Configuration Model.
  const mergedConfig = mergeGatewayConfig(
    harden({
      ...configIn,
      bindAddress: bindAddressFromEnv(env, configIn.bindAddress),
    }),
  );

  /** @type {'unstarted' | 'starting' | 'started' | 'stopped'} */
  let lifecycle = 'unstarted';
  /** @type {BindAddress} */
  const resolvedBind = parseBindAddress(mergedConfig.bindAddress);
  const apps = makeAppsNameHub();

  const renderBindAddress = () =>
    `${resolvedBind.kind === 'ipv6' ? `[${resolvedBind.host}]` : resolvedBind.host}:${resolvedBind.port}`;

  // The bootstrap registrar (Feature 4) is wired in iff the
  // sockBootstrap feature toggle is on AND the caller supplied
  // crypto + clock powers. The toggle gates the policy; the powers
  // are the platform-bound primitives. A toggle-on but no-powers
  // configuration is treated as a startup error because it would
  // otherwise silently behave like toggle-off.
  //
  // The admin facet (Feature 7) is wired in iff the adminDaemon
  // toggle is on. The admin facet uses the bootstrap's
  // registration table as its read source, so when both toggles
  // are on it shares the bootstrap's in-process backplane; when
  // only `adminDaemon` is on (`sockBootstrap` off), the admin
  // facet wires against a self-contained empty backplane and
  // serves the in-process accessor with a documented empty
  // registration view. The admin's access channel is its own sock
  // (`admin.sock`), not the bootstrap sock; the two have
  // independent toggles so that a deployment can offer
  // administrator access without exposing the bootstrap sock and
  // vice versa.
  /** @type {ReturnType<typeof makeGatewayBootstrap> | undefined} */
  let bootstrapHandle;
  /** @type {GatewayAdmin | undefined} */
  let adminFacet;
  /** @type {OcapnWebSocketHandler | undefined} */
  let ocapnHandler;
  if (mergedConfig.enableFeatures.sockBootstrap) {
    if (powers.crypto === undefined) {
      throw makeError(
        X`sockBootstrap requires powers.crypto; supply a CryptoPowers adapter or disable the feature toggle`,
      );
    }
    if (powers.clock === undefined) {
      throw makeError(
        X`sockBootstrap requires powers.clock; supply a ClockPowers adapter or disable the feature toggle`,
      );
    }
    bootstrapHandle = makeGatewayBootstrap({
      crypto: powers.crypto,
      clock: powers.clock,
      apps,
      getBindAddress: renderBindAddress,
    });
    // The OCapN-WS handler (Feature 8) reads from the same
    // registration table the bootstrap owns. The config validator
    // already rejects `ocapnWebSocket=true` with
    // `sockBootstrap=false`, so we only reach this branch with both
    // toggles on. The handler is total over the lookup function;
    // wiring is just plumbing.
    if (mergedConfig.enableFeatures.ocapnWebSocket) {
      ocapnHandler = makeOcapnWebSocketHandler({
        lookupRegistrationByPublicKey:
          bootstrapHandle.lookupRegistrationByPublicKey,
      });
    }
  }
  if (mergedConfig.enableFeatures.adminDaemon) {
    // When the bootstrap is also on, the admin reads the same
    // registration table. When the bootstrap is off, the admin
    // facet still exists but sees an empty table; that path is
    // useful for an embedder that wants admin reads of virtual
    // hosts and the resource ledger without exposing the
    // registration channel at all.
    const backplane =
      bootstrapHandle !== undefined
        ? {
            listRegisteredPeers: bootstrapHandle.listRegisteredPeers,
            deregisterByPublicKey: bootstrapHandle.deregisterByPublicKey,
            pendingNonces: bootstrapHandle.pendingNonces,
          }
        : {
            listRegisteredPeers: () => harden([]),
            deregisterByPublicKey: () => false,
            pendingNonces: () => 0,
          };
    adminFacet = makeGatewayAdmin({
      backplane,
      apps,
      resourceLedger: powers.resourceLedger,
    });
  }

  const exo = makeExo(
    'Gateway',
    GatewayInterface,
    /** @type {Gateway} */ ({
      async start() {
        if (lifecycle === 'started') {
          return;
        }
        if (lifecycle === 'stopped') {
          throw makeError(X`Gateway has been stopped and cannot restart`);
        }
        lifecycle = 'starting';
        // The phase-1 skeleton has no network surface; later
        // phases attach the HTTP listener, the WebSocket server,
        // the sock bootstrap listener, and the OCapN relay here.
        // Phase 2 lands the semantic core of the bootstrap (the
        // GatewayBootstrap exo, the nonce registry, the
        // registration table); the actual sock listener is a
        // follow-on PR.
        lifecycle = 'started';
      },
      async stop() {
        if (lifecycle === 'unstarted' || lifecycle === 'stopped') {
          lifecycle = 'stopped';
          return;
        }
        // Later phases close listeners and pending connections
        // here.
        lifecycle = 'stopped';
      },
      async getBindAddress() {
        return renderBindAddress();
      },
      async getApps() {
        return apps;
      },
      async getConfig() {
        return mergedConfig;
      },
      async getBootstrap() {
        if (bootstrapHandle === undefined) {
          throw makeError(
            X`Gateway bootstrap is disabled (set enableFeatures.sockBootstrap=true)`,
          );
        }
        return bootstrapHandle.bootstrap;
      },
      async getAdmin() {
        // Per Feature 7: admin authority is reachable in-process
        // and over the admin sock, never over the network and
        // never through the bootstrap sock. The disabled error
        // below preserves that contract by refusing to hand out
        // the facet when the toggle is off; a refactor that
        // quietly relaxed this would put admin authority on the
        // public surface.
        if (!mergedConfig.enableFeatures.adminDaemon) {
          throw makeError(
            X`Gateway admin is disabled (set enableFeatures.adminDaemon=true)`,
          );
        }
        if (adminFacet === undefined) {
          // Unreachable in normal use; the toggle is on yet
          // construction did not produce a facet. We surface the
          // wiring bug loudly rather than returning undefined.
          throw makeError(X`Gateway admin facet is not wired`);
        }
        return adminFacet;
      },
      async getOcapnHandler() {
        // Symmetric with getAdmin: the handler is reachable only
        // when both toggles are on. Either off is a clear error
        // (rather than a silent no-op) so an embedder wiring up an
        // HTTP server discovers the configuration gap immediately.
        if (!mergedConfig.enableFeatures.ocapnWebSocket) {
          throw makeError(
            X`OCapN WebSocket handler is disabled (set enableFeatures.ocapnWebSocket=true)`,
          );
        }
        if (!mergedConfig.enableFeatures.sockBootstrap) {
          // The config validator rejects this combination; the
          // local check is defense-in-depth.
          throw makeError(
            X`OCapN WebSocket handler requires sockBootstrap; set enableFeatures.sockBootstrap=true`,
          );
        }
        if (ocapnHandler === undefined) {
          throw makeError(X`OCapN WebSocket handler is not wired`);
        }
        return ocapnHandler;
      },
    }),
  );

  // Hint to the type checker; the makeExo return is `Far`-shaped
  // and matches our local Gateway type.
  return /** @type {Gateway} */ (/** @type {unknown} */ (exo));
};
harden(makeGateway);
