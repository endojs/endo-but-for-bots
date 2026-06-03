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
import { makeFormulaBackedAppsNameHub } from './src/apps-formula.js';
import { makeGatewayBootstrap } from './src/bootstrap.js';
import { makeGatewayAdmin } from './src/admin.js';
import { makeResourceLedger } from './src/resource-ledger.js';
import { makeOcapnWebSocketHandler } from './src/ocapn-ws.js';
import { makeGitHttpHandler } from './src/git-http.js';

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
  validateWebletFormula,
  makeFormulaBackedAppsNameHub,
} from './src/apps-formula.js';

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

export { RESOURCE_CLASSES, makeResourceLedger } from './src/resource-ledger.js';

export {
  OCAPN_WEBSOCKET_PATH,
  OCAPN_WEBSOCKET_LEGACY_PATH,
  OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH,
  isOcapnWebSocketPath,
  makeOcapnWebSocketHandler,
} from './src/ocapn-ws.js';

export {
  GIT_HTTP_PATH_PREFIX,
  GIT_SERVICES,
  isGitHttpPath,
  parseAuthorizationHeader,
  parseGitHttpPath,
  parseServiceQuery,
  readerFromBuffer,
  makeGitHttpHandler,
} from './src/git-http.js';

export {
  DEFAULT_RELAY_POLICY,
  RELAY_POLICIES,
  checkRelayPolicy,
  isInboundSessionAllowed,
  makeRelayPolicyEntry,
  addCallerPublicKey,
  removeCallerPublicKey,
  listCallerAllowlist,
  setRelayPolicy,
} from './src/relay-policy.js';

export {
  resolveBootstrapSocketPath,
  resolveAdminSocketPath,
  BOOTSTRAP_SOCKET_BASENAME,
  ADMIN_SOCKET_BASENAME,
  SYSTEM_RUNTIME_DIR_LINUX,
  USER_RUNTIME_SUBDIR,
} from './src/sock-paths.js';

export { makeFamiliarPublisher } from './src/familiar-publish.js';

export { makeNodeFamiliarPublishPowers } from './src/node-familiar-publish-powers.js';

/** @import {
 *   GatewayConfig,
 *   FeatureToggles,
 *   BindAddress,
 *   AppsNameHub,
 *   AppsFormulaStore,
 *   FormulaBackedAppsNameHub,
 *   WebletFormula,
 *   WebletBindingRecord,
 *   GatewayBootstrap,
 *   GatewayAdmin,
 *   AdminResourceLedger,
 *   ResourceLedger,
 *   VerifyPaymentProof,
 *   OcapnWebSocketHandler,
 *   GitHttpHandler,
 *   ServeRepo,
 *   CryptoPowers,
 *   ClockPowers,
 *   GatewayPowers,
 *   Gateway,
 *   FamiliarPublisher,
 * } from './src/types.d.ts' */

const GatewayInterface = M.interface('Gateway', {
  start: M.call().returns(M.promise()),
  stop: M.call().returns(M.promise()),
  getBindAddress: M.call().returns(M.promise()),
  getApps: M.call().returns(M.promise()),
  getConfig: M.call().returns(M.promise()),
  getBootstrap: M.call().returns(M.promise()),
  getAdmin: M.call().returns(M.promise()),
  getLedger: M.call().returns(M.promise()),
  getOcapnHandler: M.call().returns(M.promise()),
  getGitHttpHandler: M.call().returns(M.promise()),
});
harden(GatewayInterface);

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
  // Feature 2 hub selection. When the embedder supplies a
  // formula-store power, the gateway uses the formula-backed hub
  // and persists bindings through it; otherwise it falls back to
  // the in-memory phase-1 hub. The two surfaces are
  // exchange-compatible at the AppsNameHub interface; only the
  // formula-backed variant exposes `whenReady`. Per
  // `designs/gateway-package.md` § Feature 2 the daemon's
  // formula-graph wraps the store; the gateway treats the store as
  // opaque persistence.
  const apps =
    powers.appsFormulaStore !== undefined
      ? makeFormulaBackedAppsNameHub({ formulaStore: powers.appsFormulaStore })
      : makeAppsNameHub();

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
  /** @type {GitHttpHandler | undefined} */
  let gitHttpHandler;

  // Feature 1 (Phase 8) ledger selection. The two options are
  // mutually exclusive: pass `resourceLedger` for an externally-
  // owned ledger (admin read-through only, no `getLedger()`), or
  // pass `verifyPaymentProof` for the package's own concrete
  // ledger (admin read-through wired to it, `getLedger()`
  // surfaces it). Both at once is a wiring error; the design's
  // framing is "Gateway OWNS the surface", meaning a given
  // gateway has at most one canonical ledger handle.
  if (
    powers.resourceLedger !== undefined &&
    powers.verifyPaymentProof !== undefined
  ) {
    throw makeError(
      X`makeGateway: powers.resourceLedger and powers.verifyPaymentProof are mutually exclusive`,
    );
  }
  /** @type {ResourceLedger | undefined} */
  let ledger;
  if (powers.verifyPaymentProof !== undefined) {
    ledger = makeResourceLedger({
      verifyPaymentProof: powers.verifyPaymentProof,
    });
  }
  // The admin facet (Phase 3) reads through whichever ledger the
  // embedder wired in, or the package's own when constructed via
  // `verifyPaymentProof`. The admin's `getResourceBalances`
  // surface narrows the admin-facing read to `listBalances`; both
  // the external and the internal ledger satisfy that shape.
  const adminLedger = /** @type {AdminResourceLedger | undefined} */ (
    powers.resourceLedger !== undefined
      ? powers.resourceLedger
      : ledger !== undefined
        ? /** @type {unknown} */ (ledger)
        : undefined
  );
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
            setRelayPolicyByPublicKey:
              bootstrapHandle.setRelayPolicyByPublicKey,
            addRelayCallerByPublicKey:
              bootstrapHandle.addRelayCallerByPublicKey,
            removeRelayCallerByPublicKey:
              bootstrapHandle.removeRelayCallerByPublicKey,
            pendingNonces: bootstrapHandle.pendingNonces,
          }
        : {
            // When the bootstrap is off, the relay-policy admin
            // methods have no registration to act on; the empty
            // backplane returns `undefined` for the "key not found"
            // case, matching the populated backplane's contract.
            listRegisteredPeers: () => harden([]),
            deregisterByPublicKey: () => false,
            setRelayPolicyByPublicKey: () => undefined,
            addRelayCallerByPublicKey: () => undefined,
            removeRelayCallerByPublicKey: () => undefined,
            pendingNonces: () => 0,
          };
    adminFacet = makeGatewayAdmin({
      backplane,
      apps,
      resourceLedger: adminLedger,
    });
  }

  // The Git smart-HTTP handler (Feature 3) is independent of every
  // other gateway feature (the design's Configuration Model
  // explicitly names it as independent). It only needs the
  // embedder-supplied `serveRepo` adapter that resolves the bearer
  // formula identifier to the daemon's one repo capability scoped
  // to that formula's ref. When `gitHttp` is on but no adapter is
  // supplied, the gateway throws at construction time (the design's
  // invariant: a toggle-on but no-adapter configuration would
  // silently 401 every request, which is worse than a startup
  // error).
  if (mergedConfig.enableFeatures.gitHttp) {
    if (powers.serveRepo === undefined) {
      throw makeError(
        X`gitHttp requires powers.serveRepo; supply a ServeRepo adapter or disable the feature toggle`,
      );
    }
    gitHttpHandler = makeGitHttpHandler({
      serveRepo: powers.serveRepo,
    });
  }

  // Feature 5 (Familiar-bundled fallback): when the toggle is on,
  // a publisher must be wired so the gateway can surface its
  // (possibly OS-assigned) bind address to the Familiar's
  // `localhttp://` protocol handler. Fail-closed at construction
  // time per Phase 7's posture: a toggle-on but no-publisher
  // configuration would otherwise let `start()` complete with the
  // Familiar still reading a stale port (or no port), routing
  // weblet traffic into the void. The publisher is independent of
  // every other feature; the Familiar variant may run with
  // `sockBootstrap`, `adminDaemon`, `gitHttp`, `captpRelay` all
  // off (per the design's Feature 5 sample configuration).
  if (mergedConfig.enableFeatures.familiarBundled) {
    if (powers.familiarPublish === undefined) {
      throw makeError(
        X`familiarBundled requires powers.familiarPublish; supply a FamiliarPublisher (see makeFamiliarPublisher) or disable the feature toggle`,
      );
    }
  }

  const exo = makeExo(
    'Gateway',
    GatewayInterface,
    /** @type {any} */ ({
      async start() {
        if (lifecycle === 'started') {
          return;
        }
        if (lifecycle === 'stopped') {
          throw makeError(X`Gateway has been stopped and cannot restart`);
        }
        lifecycle = 'starting';
        // Feature 2: when the embedder supplied a formula-backed
        // apps hub, await its hydration before declaring the
        // gateway started. The hub's exo methods would await on
        // their own anyway, but surfacing a hydration failure at
        // `start()` is the fail-closed posture from
        // `designs/gateway-package.md` § Feature 2: a broken store
        // is a startup error, not a silent degrade to in-memory.
        if (powers.appsFormulaStore !== undefined) {
          await /** @type {FormulaBackedAppsNameHub} */ (apps).whenReady();
        }
        // The phase-1 skeleton has no network surface; later
        // phases attach the HTTP listener, the WebSocket server,
        // the sock bootstrap listener, and the OCapN relay here.
        // Phase 2 lands the semantic core of the bootstrap (the
        // GatewayBootstrap exo, the nonce registry, the
        // registration table); the actual sock listener is a
        // follow-on PR.
        //
        // Feature 5 (Familiar-bundled): publish the *resolved*
        // bind address to the Familiar's local file so its
        // `localhttp://` protocol handler can proxy to it. Today
        // the skeleton's resolved address equals the configured
        // address; once a future phase attaches the HTTP
        // listener, the OS-assigned port (configured `:0`)
        // resolves to a real port before this line runs and the
        // published value carries the real port. The publish call
        // happens after the apps hydration await so a
        // configuration drift (broken apps store) does not leave
        // a phantom port file behind. Fail-closed: a publisher
        // exception propagates through `start`; the caller treats
        // it as a startup error.
        if (mergedConfig.enableFeatures.familiarBundled) {
          // The construction-time check above ensures
          // `familiarPublish` is defined here when the toggle is
          // on; the local re-check satisfies TypeScript without a
          // separate non-null assertion.
          if (powers.familiarPublish !== undefined) {
            await powers.familiarPublish.publish(renderBindAddress());
          }
        }
        lifecycle = 'started';
      },
      async stop() {
        if (lifecycle === 'unstarted' || lifecycle === 'stopped') {
          lifecycle = 'stopped';
          return;
        }
        // Feature 5 (Familiar-bundled): remove the published file
        // so a restarted Familiar does not read a stale port. The
        // publisher tolerates an externally-removed file
        // (`ENOENT` is benign in the Node adapter), so a manual
        // cleanup between runs does not crash the gateway here.
        // The cleanup runs before the lifecycle transitions to
        // `stopped` so a follow-on phase that closes listeners
        // here can interleave its teardown without re-entering
        // the cleanup path.
        if (
          mergedConfig.enableFeatures.familiarBundled &&
          powers.familiarPublish !== undefined
        ) {
          await powers.familiarPublish.cleanup();
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
      async getLedger() {
        // Feature 1 (Phase 8): the concrete ledger is wired in
        // iff the embedder supplied `verifyPaymentProof`. An
        // embedder that supplied an external `resourceLedger`
        // (admin read-through only) does not get a `getLedger()`
        // accessor; the external ledger is the holder's own
        // handle and is not the gateway's to surface. We surface
        // the configuration gap rather than silently returning
        // undefined.
        if (ledger === undefined) {
          if (powers.resourceLedger !== undefined) {
            throw makeError(
              X`Gateway ledger is external (supplied via powers.resourceLedger); the gateway does not own a handle to surface`,
            );
          }
          throw makeError(
            X`Gateway ledger is not wired (supply powers.verifyPaymentProof to construct the package's ResourceLedger)`,
          );
        }
        return ledger;
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
      async getGitHttpHandler() {
        // Symmetric with getOcapnHandler. The git surface is the
        // only Feature 3 surface; the embedder routes `/git/...`
        // requests here. We do not gate on sockBootstrap because the
        // git handler does not read from the registration table;
        // it consults the embedder's `serveRepo` adapter directly.
        if (!mergedConfig.enableFeatures.gitHttp) {
          throw makeError(
            X`Git smart-HTTP handler is disabled (set enableFeatures.gitHttp=true)`,
          );
        }
        if (gitHttpHandler === undefined) {
          throw makeError(X`Git smart-HTTP handler is not wired`);
        }
        return gitHttpHandler;
      },
    }),
  );

  // Hint to the type checker; the makeExo return is `Far`-shaped
  // and matches our local Gateway type.
  return /** @type {Gateway} */ (/** @type {unknown} */ (exo));
};
harden(makeGateway);
