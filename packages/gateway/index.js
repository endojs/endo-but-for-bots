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
  resolveBootstrapSocketPath,
  BOOTSTRAP_SOCKET_BASENAME,
  SYSTEM_RUNTIME_DIR_LINUX,
  USER_RUNTIME_SUBDIR,
} from './src/sock-paths.js';

/** @import { GatewayConfig, BindAddress, GatewayPowers, Gateway } from './src/types.js' */
/** @import { GatewayAdmin } from './src/admin.js' */

const GatewayInterface = M.interface('Gateway', {
  start: M.call().returns(M.promise()),
  stop: M.call().returns(M.promise()),
  getBindAddress: M.call().returns(M.promise()),
  getApps: M.call().returns(M.promise()),
  getConfig: M.call().returns(M.promise()),
  getBootstrap: M.call().returns(M.promise()),
  getAdmin: M.call().returns(M.promise()),
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
  /** @type {ReturnType<typeof makeGatewayBootstrap> | undefined} */
  let bootstrapHandle;
  /** @type {GatewayAdmin | undefined} */
  let adminFacet;
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
    // The admin facet (Feature 7) is wired in iff both the
    // sockBootstrap and adminDaemon toggles are on; the config
    // validator already rejects `adminDaemon=true` with
    // `sockBootstrap=false`, so the only path here that creates an
    // admin facet is the both-on path. We pass a forward-reference
    // `getAdmin` thunk to the bootstrap because the bootstrap is
    // the holder for the in-process admin backplane (the second
    // return value); the admin facet itself is constructed below
    // with that backplane in hand.
    bootstrapHandle = makeGatewayBootstrap({
      crypto: powers.crypto,
      clock: powers.clock,
      apps,
      getBindAddress: renderBindAddress,
      getAdmin: mergedConfig.enableFeatures.adminDaemon
        ? () => {
            // adminFacet is assigned immediately below; the thunk
            // is only ever invoked after `makeGateway` returns.
            if (adminFacet === undefined) {
              throw makeError(X`Admin facet was not constructed`);
            }
            return adminFacet;
          }
        : undefined,
    });
    if (mergedConfig.enableFeatures.adminDaemon) {
      adminFacet = makeGatewayAdmin({
        backplane: {
          listRegisteredPeers: bootstrapHandle.listRegisteredPeers,
          deregisterByPublicKey: bootstrapHandle.deregisterByPublicKey,
          pendingNonces: bootstrapHandle.pendingNonces,
        },
        apps,
        resourceLedger: powers.resourceLedger,
      });
    }
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
        // and over the sock bootstrap, never over the network. The
        // two `disabled` errors below preserve that contract by
        // refusing to hand out the facet when either toggle is
        // off; a refactor that quietly relaxed this would put
        // admin authority on the public surface.
        if (!mergedConfig.enableFeatures.adminDaemon) {
          throw makeError(
            X`Gateway admin is disabled (set enableFeatures.adminDaemon=true)`,
          );
        }
        if (!mergedConfig.enableFeatures.sockBootstrap) {
          // The config validator rejects this combination, so
          // reaching this branch implies a refactor that loosened
          // the validator. We keep the local check as
          // defense-in-depth.
          throw makeError(
            X`Gateway admin requires sockBootstrap; set enableFeatures.sockBootstrap=true`,
          );
        }
        if (adminFacet === undefined) {
          // Unreachable in normal use; both toggles are on yet
          // construction did not produce a facet. We surface the
          // wiring bug loudly rather than returning undefined.
          throw makeError(X`Gateway admin facet is not wired`);
        }
        return adminFacet;
      },
    }),
  );

  // Hint to the type checker; the makeExo return is `Far`-shaped
  // and matches our local Gateway type.
  return /** @type {Gateway} */ (/** @type {unknown} */ (exo));
};
harden(makeGateway);
