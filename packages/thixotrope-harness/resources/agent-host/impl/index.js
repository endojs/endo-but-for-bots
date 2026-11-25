// @ts-check
/**
 * The agent-host implementation (M1a W1a.2; architecture D-7, D-8, D-14;
 * `designs/m1a-interfaces.md` sections 3.2, 10 and 11).
 *
 * Loaded at run time by `resources/agent-host/ephemeral.js` after the guest
 * prelude is on `globalThis`, so these modules may import `guest/lib/*`.
 * `makeAgentHostImpl` composes one adapter incarnation: the session
 * channels, `Live`, the `Composer`, the backends and their adapter tools,
 * and the ops facet the manager vat calls (`attach.js`).
 *
 * Hook tables (append-only; milestones.md "Hook tables"): later milestones
 * add entries to `backendKinds` (`providers/kinds.js`) and `adapterTools`
 * below, never edit another milestone's entry.
 */
import { dirname } from 'node:path';
import { env, pid, stderr } from 'node:process';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { textOf } from '../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { channelTaps } from './channel-taps.js';
import { liveProbeFromEnv, makeChannelRegistry } from './channels.js';
import { makeComposer } from './composer.js';
import { makeLive } from './live-service.js';
import { makeAttach, makeOps } from './attach.js';
import { makeEndpoint } from './endpoint.js';
import { makeTimerFacet, makeTimers } from './timers.js';
import { blobDirIn, findStateDir, makeBlobStore } from './blobs.js';
import { makeContent } from './content.js';
import { makeContextCache } from './context-cache.js';
import { archiveDirFor, makeArchiveStore } from './archive/store.js';
import { makeListChannel } from './list-channel.js';
import { makeEventLog } from './providers/event-log.js';
import { assertBackendKinds, backendKinds, kindOf } from './providers/kinds.js';
import { makeEchoTool } from './tools/echo.js';
import { makeImageTool } from './tools/view-image.js';
import { makeCatalog } from './providers/catalog.js';
import { findSecretsFiles, makeSecretStore } from './secrets/store.js';
import { makeSealKeys } from './secrets/seal.js';
import { makeWrappingKey } from './secrets/wrapping-key.js';
import { makeSecretsOps } from './secrets/manager.js';
import { makeGatewayService } from './gateway/index.js';
import { gatewayExtension as speechExtension } from './gateway/extensions/speech.js';
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
import { GATEWAY_KEY } from '../../../guest/lib/interfaces-m3.js';
import { makeSubscriptions } from './subscriptions/index.js';
import {
  accountStatusDescription,
  makeAccountStatusTool,
} from './subscriptions/account-tool.js';

/**
 * @typedef {import('./providers/kinds.js').BackendKind} BackendKind
 *
 * @typedef {object} AdapterToolKind
 * @property {string} name the tool name the model sees
 * @property {{ name: string, description: string, parameters: string }} [description]
 *   the `ToolDescription` the model is offered; the open handler passes it
 *   in each `AdapterToolEntry`. A tool with a static tool-table entry of its
 *   name (`echo`) needs none; any other is offered to the model only with
 *   one (D-M4-9 as amended, XC)
 * @property {(options: { timers: import('./timers.js').Timers, log: import('./providers/event-log.js').EventLog, blobs: import('./blobs.js').BlobStore, backend: any, session: any, subscriptions: any }) => any} makeTool
 */

/**
 * Tools that run in this adapter (hook table).
 * @type {readonly AdapterToolKind[]}
 */
export const adapterTools = harden([
  // M1a W1a.2: the echo test tool.
  { name: 'echo', makeTool: makeEchoTool },
  // M4 W4.6: account status (m4-interfaces.md 6).
  {
    name: 'accountStatus',
    makeTool: makeAccountStatusTool,
    description: accountStatusDescription,
  },
  // M8 (m8-interfaces.md 6.2, S-18): image input; the session's static
  // entry describes it, so it carries no description here.
  { name: 'viewImage', makeTool: makeImageTool },
]);

/**
 * Adapter tools every backend kind's ports offer, after the kind's own
 * (M8 S-18: `viewImage` on every kind).
 */
const everyKindTools = harden(['viewImage']);

/** @param {Record<string, unknown>} event */
const stderrLog = event => {
  stderr.write(
    `${JSON.stringify({ agentHost: true, at: Date.now(), ...event })}\n`,
  );
};

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error => {
  try {
    const message = /** @type {any} */ (error)?.message;
    return typeof message === 'string' ? message : String(error);
  } catch {
    return 'unprintable error';
  }
};

/**
 * @template T
 * @param {() => T} compute
 * @returns {() => T} `compute`'s value, worked out on the first call that
 *   succeeds and kept
 */
const once = compute => {
  /** @type {{ value: T } | undefined} */
  let made;
  return () => {
    made ??= { value: compute() };
    return made.value;
  };
};

/**
 * One adapter incarnation of the agent host.
 *
 * @param {object} [options]
 * @param {import('./timers.js').Timers} [options.timers]
 * @param {ReturnType<typeof liveProbeFromEnv>} [options.probe] the live
 *   probe of the default channel registry (perf; default: the one a perf
 *   run named in this process's environment, else none; HR-SYN-13)
 * @param {{ channelFor: (session: any) => any }} [options.channels] the
 *   session channel registry (tests may pass their own)
 * @param {readonly BackendKind[]} [options.kinds]
 * @param {readonly AdapterToolKind[]} [options.tools]
 * @param {string} [options.incarnation] names this incarnation in the
 *   manager's attach count (default: pid and a random suffix, from the
 *   loader)
 * @param {string | (() => string)} [options.stateDir] the daemon's state
 *   directory (default: the blob directory's grandparent when `blobDir` is
 *   given, else found from argv by `findStateDir`); worked out once, on
 *   first use, and passed to everything that keeps files (HR-SYN-22)
 * @param {string | (() => string)} [options.blobDir] M1b: where staged
 *   text lives (default: `<state>/agent-host/blobs`)
 * @param {any} [options.sink] M1b: the manager's sink, when there is no
 *   attach (tests); otherwise `bind` provides it
 * @param {string | (() => string)} [options.archiveDir] M2 (W2.8): the
 *   record archive's root (default: `archive` next to the blob directory)
 * @param {ReturnType<typeof makeCatalog>} [options.catalog] M2 (W2.2): the
 *   model catalogue (default: one per incarnation, over `fetch`)
 * @param {Pick<ReturnType<typeof makeSecretsOps>, 'readKey'> & Partial<ReturnType<typeof makeSecretsOps>>} [options.secrets]
 *   M2 (W2.2 wiring W2.3's ops): the Secrets operations (default: made on
 *   first use over `<state>/agent-host/secrets.enc`, so an incarnation that
 *   never meets a secret creates no key file)
 * @param {typeof globalThis.fetch} [options.fetch] M2: the catalogue's fetch
 * @param {(event: Record<string, unknown>) => void} [options.report] the
 *   adapter's report of what it cannot do itself (a failed start-up sweep;
 *   default: one JSON line on stderr)
 */
export const makeAgentHostImpl = ({
  timers = makeTimers(),
  probe = liveProbeFromEnv(env),
  channels = makeChannelRegistry({ taps: channelTaps, probe }),
  kinds = backendKinds,
  tools = adapterTools,
  incarnation = `${pid}`,
  stateDir = undefined,
  blobDir = undefined,
  sink: givenSink = undefined,
  archiveDir = undefined,
  catalog = undefined,
  secrets: givenSecrets = undefined,
  fetch = undefined,
  report = stderrLog,
} = {}) => {
  assertBackendKinds(kinds);
  /**
   * The state layout, worked out once on first use (HR-SYN-22): the state
   * directory, and the blob directory in it unless the caller named one.
   * Lazy, so an incarnation that never keeps a file never asks argv.
   */
  const blobDirNow = once(() => {
    if (blobDir === undefined) {
      // eslint-disable-next-line no-use-before-define
      return blobDirIn(stateDirNow());
    }
    return typeof blobDir === 'function' ? blobDir() : blobDir;
  });
  const stateDirNow = once(() => {
    if (stateDir !== undefined)
      return typeof stateDir === 'function' ? stateDir() : stateDir;
    // A caller that names only the blob directory names
    // `<state>/agent-host/blobs`.
    if (blobDir !== undefined) return dirname(dirname(blobDirNow()));
    return findStateDir();
  });
  /** The manager's sink, from the attach (M1b blobs mint through it). */
  let sink = givenSink;
  /** The sink, or `undefined` before the attach (start-up code asks quietly). */
  const sinkOrUndefined = () => sink;
  /** The sink; a call before the attach fails. */
  const requireSink = () => {
    if (sink === undefined) throw Error('the agent host is not attached');
    return sink;
  };
  const blobs = makeBlobStore({
    dir: blobDirNow,
    sink: requireSink,
    timers,
  });
  const content = makeContent({ store: blobs });
  // M2 W2.8: the record archive (D-M2-1), next to the blobs.
  const archive = makeArchiveStore({
    dir: archiveDir ?? (() => archiveDirFor(blobDirNow())),
    blobs,
    sink: sinkOrUndefined,
  });
  const timer = makeTimerFacet(timers);
  // The session list channel (W1b.5's list-channel.js), one per incarnation.
  const listChannel = makeListChannel();
  const live = makeLive({ channels, listChannel });
  const composer = makeComposer({ blobs });
  // W1b.2: the context cache of every session served here (D-9).
  const contextCache = makeContextCache({ store: blobs, archive });
  // M2 W2.2: the model catalogue (R4-17, R4-104), this incarnation only.
  const models =
    catalog ??
    makeCatalog({ kinds, ...(fetch === undefined ? {} : { fetch }) });

  /**
   * M2 (W2.3's ops, wired by W2.2, m2-interfaces 2.3): made on first use,
   * in the state directory; the key file comes from
   * THIX_HARNESS_SECRETS_KEY or the user's config directory (9.1).
   * @type {any}
   */
  let secretsMade = givenSecrets;
  const secrets = () => {
    if (secretsMade === undefined) {
      const files = findSecretsFiles({ stateDir: stateDirNow(), env });
      // One wrapping key per incarnation for the store and the sealing keys
      // (one load, one failure policy: HR-SYN-5).
      const wrappingKey = makeWrappingKey({
        keyFile: files.keyFile,
        stateDir: files.stateDir,
      });
      secretsMade = makeSecretsOps({
        store: makeSecretStore({
          file: files.file,
          wrappingKey,
          auditFile: files.auditFile,
        }),
        seal: makeSealKeys({ wrappingKey }),
        sink: requireSink,
      });
    }
    return secretsMade;
  };
  // M4 W4.6 (H-4 c): pools, credentials and accounts, made lazily.
  const subscriptions = makeSubscriptions({
    sink: sinkOrUndefined,
    secrets,
    stateDir: stateDirNow,
    timers,
    ...(fetch === undefined ? {} : { fetch }),
    // The gateway's operator, read at each use (pool additions, 3.5).
    currentOperator: () => gateway.operator(),
  });
  /**
   * An API backend's key, through its grant, read at every use (R4-82).
   * @param {any} spec
   * @returns {(() => Promise<string>) | undefined}
   */
  const readKeyOf = spec =>
    spec.keyGrant === undefined
      ? undefined
      : () => secrets().readKey(spec.keyGrant);
  /**
   * The catalogue that answers for `spec`'s kind (the model catalogue for a
   * kind this table does not know: its listing refuses the spec).
   * @param {any} spec
   * @returns {import('./providers/kinds.js').ModelCatalog}
   */
  const catalogOf = spec =>
    kindOf(spec, kinds)?.catalog({ models, pools: subscriptions.catalog }) ??
    models;
  /**
   * A Secrets handler that builds the operations on first use.
   * @param {string} name
   */
  const secretsHandler =
    name =>
    /** @param {any[]} args */
    (...args) => {
      const handler = secrets()[name];
      if (handler === undefined) throw Error(textOf.notBuilt(name));
      return handler(...args);
    };

  /**
   * What a Backend presence of the manager vat is in this incarnation:
   * built from its spec on first open, then reused (one provider per
   * backend, so a script's turn selection spans the backend's turns).
   * @type {WeakMap<any, { provider: any, log: any, kind: BackendKind, toolsOf: WeakMap<any, any> }>}
   */
  const backends = new WeakMap();

  /**
   * The blob store as one session sees it (J-9361, J-9364): what it stages
   * counts against that session's quota, and what it reads must be its own.
   * @param {any} owner the Session presence
   * @returns {import('./blobs.js').BlobStore}
   */
  const blobsOf = owner =>
    harden({
      ...blobs,
      stage: (text, options = {}) => blobs.stage(text, { ...options, owner }),
      stagePending: (text, options = {}) =>
        blobs.stagePending(text, { ...options, owner }),
      read: blob => blobs.read(blob, owner),
      readPage: (blob, offset, maxBytes) =>
        blobs.readPage(blob, offset, maxBytes, owner),
    });

  /**
   * @param {any} backend
   * @param {any} spec
   */
  const backendState = (backend, spec) => {
    const known = backends.get(backend);
    if (known !== undefined) return known;
    const kind = kindOf(spec, kinds);
    if (kind === undefined)
      throw Error(`No backend kind ${JSON.stringify(spec.kind)} here`);
    const log = makeEventLog({ label: spec.label, logPath: spec.logPath });
    const readKey = readKeyOf(spec);
    const provider = kind.makeProvider({
      label: spec.label,
      // M2 (W2.2 wiring, 2.3): API kinds read `spec` (base URL, timeout,
      // output limit) and the key through its grant.
      spec,
      ...(readKey === undefined ? {} : { readKey }),
      script: spec.script,
      logPath: spec.logPath,
      timers,
      log,
      blobs,
      backend,
      subscriptions,
    });
    // The backend's adapter tools, one set per session (J-9364).
    const state = harden({ provider, log, kind, toolsOf: new WeakMap() });
    backends.set(backend, state);
    return state;
  };

  const ops = makeOps({
    open: ({ backend, spec, session, archiveKey }) => {
      const { provider, log, kind, toolsOf } = backendState(backend, spec);
      const channel = channels.channelFor(session);
      const endpoint = makeEndpoint({
        provider,
        channel,
        timers,
        prepare: (req, options) =>
          contextCache.prepare(session, req, { key: archiveKey, ...options }),
        owner: session,
        unexpectedFailure: kind.unexpectedFailure,
      });
      // Per session (J-9361, J-9364): the tools, writers and Content of
      // these ports stage for this session and read only its blobs.
      const sessionBlobs = blobsOf(session);
      let toolEntries = toolsOf.get(session);
      if (toolEntries === undefined) {
        toolEntries = harden(
          [...kind.tools, ...everyKindTools].map(name => {
            const entry = tools.find(candidate => candidate.name === name);
            if (entry === undefined)
              throw Error(`No adapter tool ${name} here`);
            // XC (D-M4-9 as amended): the description travels with the
            // tool, so the session offers a tool it has no entry for.
            return harden({
              name,
              ...(entry.description === undefined
                ? {}
                : { description: entry.description }),
              tool: entry.makeTool({
                timers,
                log,
                blobs: sessionBlobs,
                backend,
                session,
                subscriptions,
              }),
            });
          }),
        );
        toolsOf.set(session, toolEntries);
      }
      /** @type {Record<string, any>} */
      const ports = {
        endpoint,
        publisher: channel.publisher,
        tools: toolEntries,
        content: makeContent({ store: sessionBlobs }),
        writers: blobs.writersFor(session),
        timer,
      };
      // M2 W2.8: the session's archive port (its key from `archiveKey`,
      // else resolved through the manager when first needed).
      ports.archive = archive.portFor({ session, key: archiveKey });
      return harden(ports);
    },
    liveChannel: session => channels.channelFor(session).publisher,
    live: () => live,
    composer: () => composer,
    content: () => content,
    listPublisher: () => listChannel.publisher,
    // M2 W2.8 (m2-interfaces.md 3.4, 4.9-4.11).
    history: () => archive.history(),
    releaseBlobs: keys => blobs.release(keys),
    releaseArchive: key => archive.release(key),
    writersFor: session => blobs.writersFor(session),
    // M2 W2.2 (8.4): the catalogue, with the backend's key; which catalogue
    // is the kind's (the pool kinds': the pool catalogue, H-4 (g)).
    listModels: ({ backend, spec, request }) =>
      catalogOf(spec).listModels({
        backend,
        spec,
        readKey: readKeyOf(spec),
        log: backendState(backend, spec).log,
        ...(request === undefined ? {} : { request }),
      }),
    resolveModel: ({ backend, spec, modelId }) =>
      catalogOf(spec).resolveModel({
        backend,
        spec,
        readKey: readKeyOf(spec),
        log: backendState(backend, spec).log,
        ...(modelId === undefined ? {} : { modelId }),
      }),
    // M2 W2.3's Secrets operations (9), wired by W2.2 (2.3).
    secretCreate: secretsHandler('secretCreate'),
    secretDescribe: secretsHandler('secretDescribe'),
    secretRevoke: secretsHandler('secretRevoke'),
    secretDelete: secretsHandler('secretDelete'),
    secretAudit: secretsHandler('secretAudit'),
    secretWriter: secretsHandler('secretWriter'),
    // M4 W4.6 (H-4 f, H-3).
    credentials: () => subscriptions.credentialOps,
  });

  const gateway = makeGatewayService({
    live,
    composer,
    content,
    history: () => archive.history(),
    blobs,
    timers,
    stateDir: stateDirNow,
    // The in-process write path, never the hub's SealedBox-only writer
    // (m3-interfaces A-11).
    secretWriter: async () => {
      const { replaceLocal, publicKeyLocal } = secrets();
      return harden({ replaceLocal, publicKey: publicKeyLocal });
    },
    // The key reader goes to the speech extension only, picked by its
    // object (m11-interfaces.md D-M11-22): API backends read keys the same
    // way (`readKeyOf`).
    extensionPowers: [
      {
        extension: speechExtension,
        powers: { readGrant: grant => secrets().readKey(grant) },
      },
    ],
  });
  const { bind, unbind } = makeAttach({
    ops,
    incarnation,
    onSink: async attachedSink => {
      sink = attachedSink;
      // Writes that never completed (section 4.6), and the daemon quota's
      // count: once per incarnation (a rebind answers the first sweep). A
      // failure does not fail the bind, which would stop every session: it
      // is reported, and the blob store refuses stagings until a later
      // sweep succeeds (HR-SYN-9).
      await blobs.sweep().catch(error => {
        report({
          event: 'sweep-failed',
          store: 'blobs',
          error: messageOf(error),
        });
      });
      // M2: half-written segments, manifests and mirrors (4.5); reported
      // the same way.
      await archive.sweep().catch(error => {
        report({
          event: 'sweep-failed',
          store: 'archive',
          error: messageOf(error),
        });
      });
      gateway.attached();
    },
    bindings: { [GATEWAY_KEY]: gateway.binding },
  });
  return harden({
    bind,
    unbind,
    ops,
    blobs,
    content,
    listChannel,
    contextCache,
    archive,
    catalog: models,
  });
};
harden(makeAgentHostImpl);
