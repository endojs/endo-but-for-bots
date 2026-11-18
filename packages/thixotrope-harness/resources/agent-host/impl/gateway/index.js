// @ts-check
/**
 * The gateway's composition in one agent-host adapter incarnation (M3 W3.7;
 * designs/m3-interfaces.md 2, 3.2, 6.1, 7, 17; hotspot H4 wires it into
 * `AH/index.js`).
 *
 * `makeGatewayService(options)` answers `{ binding, attached, close }`:
 *
 * - `binding` is what `makeAttach` hands the manager kit's `GATEWAY_KEY`
 *   binds to. `bind(GatewaySpec)` reads the sign-in secret (minting it at
 *   the first bind, `signin.js`), listens (`server.js`), attaches this
 *   incarnation's `GatewayOps` to `spec.sink` with the serving status, and
 *   only then answers, so `GatewayAdmin.serve` answers a bound gateway. A
 *   bind on a listening gateway (a re-serve without an unbind) closes the
 *   old listener first. `unbind()` closes every connection with
 *   `closeCodes.gatewayStopped` and the listener.
 * - `attached()` is called once the agent host is attached (`onSink`):
 *   `GatewayContext.whenAttached` callbacks run then, and
 *   `GatewayContext.secretWriter()` works from then on (before, it rejects).
 * - `close()` is `unbind()` for the adapter's own shutdown.
 *
 * What is made once per incarnation, on the first bind: the extension list
 * (`extensions.js`, loaded at construction), their services (the
 * `GatewayPowers.extras`), the large-call exemptions (the Composer's
 * `submit` and `edit`, plus each extension's target after attach) and the
 * key vocabulary and the method-name set (`vocabulary.js`). What is made per bind: the sign-in
 * store and limiter (the config's `signInFailuresPerMinute`), the bridge and
 * the server. The operator a signed-in page receives is read from the spec
 * of the current bind at each `fetch`.
 *
 * `GatewayOps.rotateSignIn()` writes the new secret (temp, fsync, rename),
 * then closes every open connection with `closeCodes.signInRotated`; the
 * manager never sees the value (D-6). `GatewayOps.status()` answers
 * `{ state: 'serving', port, origin, connections, since }`.
 *
 * Logs (`log`, default one JSON line on stderr): bind, unbind, rotation and
 * whatever the server, the bridge and the extensions log. Never a secret, a
 * body, a query string or a fragment.
 *
 * Node module (agent-host adapter); the guest prelude is on `globalThis`.
 */
import { dirname } from 'node:path';
import { env as processEnv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { m3Interfaces } from '../../../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import { findBlobDir } from '../blobs.js';
import { makeBridge } from './bridge.js';
import { closeCodes, gatewayTexts } from './contract-m3.js';
import { cspHeader } from './csp.js';
import {
  extensionCsp,
  extensionRoutes,
  loadGatewayExtensions,
  makeExtensionServices,
  makeLargeCalls,
} from './extensions.js';
import { makeSignInLimiter } from './limiter.js';
import { makeBootstrapFactory, markGatewayLocal } from './powers.js';
import { makeGatewayServer } from './server.js';
import { makeSignInStore } from './signin.js';
import { makeStaticHandler } from './static.js';
import { harnessNames } from './vocabulary.js';

/** @import { GatewayContext, GatewayExtension } from './contract-m3.js' */

const { E, makeExo } = /** @type {any} */ (globalThis);

/** `GW/assets/`, W3.4's build output (git ignored). */
export const defaultAssetsDir = fileURLToPath(
  new URL('./assets/', import.meta.url),
);

/** What `GatewayContext.secretWriter()` rejects with before the attach. */
export const notAttachedText =
  'the agent host is not attached yet; call secretWriter after whenAttached';

/** @param {Record<string, unknown>} event */
const stderrLog = event => {
  stderr.write(
    `${JSON.stringify({ gateway: true, at: Date.now(), ...event })}\n`,
  );
};

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/**
 * @param {object} options
 * @param {any} options.live the incarnation's `Live`
 * @param {any} options.composer the incarnation's `Composer`
 * @param {any} options.content the incarnation's `Content`
 * @param {() => any} options.history answers the incarnation's `History`
 * @param {any} [options.blobs] the blob store (kept for later extensions;
 *   M3 reads nothing from it)
 * @param {any} [options.timers] the adapter timers (as `blobs`)
 * @param {() => Promise<any>} options.secretWriter the incarnation's one
 *   `SecretWriter` (M2 `secrets/manager.js`); called only after `attached()`
 * @param {string | (() => string)} [options.stateDir] default: the blob
 *   directory's grandparent (`<state>/agent-host/blobs`), found from argv at
 *   the first bind
 * @param {(event: Record<string, unknown>) => void} [options.log]
 * @param {Record<string, string | undefined>} [options.env] where the
 *   wrapping key is (`THIX_HARNESS_SECRETS_KEY`; default the process's)
 * @param {string} [options.extensionsDir] default `GW/extensions/`
 * @param {string} [options.assetsDir] default `GW/assets/`
 * @param {string} [options.guestLibDir] the vocabulary's `interfaces-m*.js`
 *   directory (default `guest/lib/`)
 * @param {() => number} [options.now]
 * @param {Record<string, number>} [options.serverLimits] tests only
 */
export const makeGatewayService = ({
  live,
  composer,
  content,
  history,
  blobs: _blobs = undefined,
  timers: _timers = undefined,
  secretWriter,
  stateDir = () => dirname(dirname(findBlobDir())),
  log = stderrLog,
  env = processEnv,
  extensionsDir = undefined,
  assetsDir = defaultAssetsDir,
  guestLibDir = undefined,
  now = () => Date.now(),
  serverLimits = undefined,
}) => {
  /** @type {string | undefined} */
  let stateDirMade;
  const stateDirNow = () => {
    stateDirMade ??= typeof stateDir === 'function' ? stateDir() : stateDir;
    return stateDirMade;
  };

  let isAttached = false;
  /** @type {(() => void)[]} */
  let waiting = [];

  /** @type {GatewayContext} */
  const context = harden({
    live,
    composer,
    content,
    history: () => history(),
    whenAttached: callback => {
      if (isAttached) {
        void Promise.resolve().then(callback);
      } else {
        waiting.push(callback);
      }
    },
    secretWriter: async () => {
      if (!isAttached) throw Error(notAttachedText);
      return secretWriter();
    },
    get stateDir() {
      return stateDirNow();
    },
    log,
  });

  /** @type {GatewayExtension[]} */
  const extensions = loadGatewayExtensions({
    ...(extensionsDir === undefined ? {} : { dir: extensionsDir }),
    log,
  });

  /**
   * Made at the first bind (an adapter that never serves loads no
   * vocabulary and makes no services).
   * @type {{ extras: { label: string, service: any }[], isLargeCall: (target: unknown, method: string) => boolean, vocabulary: Set<string>, methods: Set<string>, csp: string, routes: any[] } | undefined}
   */
  let incarnation;
  const incarnationParts = () => {
    if (incarnation === undefined) {
      const extras = makeExtensionServices({ extensions, context, log });
      const { isLargeCall } = makeLargeCalls({
        extensions,
        context,
        builtIn: [{ target: composer, methods: ['submit', 'edit'] }],
        log,
      });
      const names = harnessNames({
        ...(guestLibDir === undefined ? {} : { guestLibDir }),
        log,
      });
      incarnation = harden({
        extras,
        isLargeCall,
        vocabulary: names.keys,
        methods: names.methods,
        csp: cspHeader(extensionCsp(extensions)),
        routes: extensionRoutes(extensions),
      });
    }
    return incarnation;
  };

  /**
   * The listener of the current bind.
   * @type {{ server: any, bridge: any, signIn: any, ops: any, since: number, spec: any } | undefined}
   */
  let serving;

  const stopServing = async () => {
    const current = serving;
    serving = undefined;
    if (current === undefined) return;
    current.bridge.closeAll(
      closeCodes.gatewayStopped,
      gatewayTexts.gatewayStopped,
    );
    await current.server.close(
      closeCodes.gatewayStopped,
      gatewayTexts.gatewayStopped,
    );
    log({ event: 'gateway-unbound', port: current.server.port });
  };

  /** One bind or unbind at a time. */
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  const serialize = job => {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  };

  /** @param {any} spec a `GatewaySpec` (checked by the manager's guards) */
  const bind = spec =>
    serialize(async () => {
      await stopServing();
      const { config } = spec;
      // Before anything is read or bound (the K1 kill point of the tests).
      log({ event: 'gateway-binding', port: config.port });
      const parts = incarnationParts();
      const signIn = makeSignInStore({ stateDir: stateDirNow(), env });
      await signIn.ensure();
      const limiter = makeSignInLimiter({
        now,
        ...(config.signInFailuresPerMinute === undefined
          ? {}
          : { perMinute: config.signInFailuresPerMinute }),
      });
      /** @type {{ current: any }} */
      const operatorOf = { current: config.operator };
      const bridge = makeBridge({
        makeBootstrap: makeBootstrapFactory({
          signIn,
          limiter,
          operator: () => operatorOf.current,
          live,
          content,
          composer,
          history: () => history(),
          extras: parts.extras,
          log,
        }),
        vocabulary: parts.vocabulary,
        methods: parts.methods,
        isLargeCall: parts.isLargeCall,
        log,
      });
      const server = await makeGatewayServer({
        port: config.port,
        ...(config.publicOrigin === undefined
          ? {}
          : { publicOrigin: config.publicOrigin }),
        trustedProxies: [...(config.trustedProxies ?? [])],
        routes: parts.routes,
        staticHandler: makeStaticHandler({ assetsDir, csp: parts.csp }),
        onSocket: socket => {
          bridge.connect(socket);
        },
        log,
        csp: parts.csp,
        ...(serverLimits === undefined ? {} : { limits: serverLimits }),
      });
      const since = now();
      const statusNow = () =>
        harden({
          state: 'serving',
          port: server.port,
          origin: server.origin,
          connections: server.connections(),
          since,
        });
      const ops = makeExo('GatewayOps', m3Interfaces.GatewayOps, {
        status: statusNow,
        rotateSignIn: async () => {
          await signIn.rotate();
          bridge.closeAll(closeCodes.signInRotated, gatewayTexts.signInRotated);
          log({ event: 'gateway-signin-rotated' });
          return undefined;
        },
      });
      markGatewayLocal(ops);
      serving = { server, bridge, signIn, ops, since, spec };
      try {
        await E(spec.sink).attach(ops, statusNow());
      } catch (error) {
        // The manager is gone or refused: no listener without its admin.
        await stopServing();
        throw error;
      }
      log({ event: 'gateway-bound', port: server.port });
      return undefined;
    });

  const unbind = () => serialize(stopServing);

  const attached = () => {
    if (isAttached) return;
    isAttached = true;
    const callbacks = waiting;
    waiting = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        log({
          event: 'gateway-attached-callback-failed',
          error: messageOf(error),
        });
      }
    }
  };

  return harden({
    binding: harden({ bind, unbind }),
    attached,
    close: unbind,
    /** Tests: the port served now, if any. */
    port: () => serving?.server.port,
  });
};
harden(makeGatewayService);
