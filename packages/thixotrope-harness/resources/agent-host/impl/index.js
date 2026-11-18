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
 * add entries to `backendKinds` and `adapterTools` below, never edit another
 * milestone's entry.
 */
import { dirname } from 'node:path';
import { env, pid } from 'node:process';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { textOf } from '../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { channelTaps } from './channel-taps.js';
import { makeChannelRegistry } from './channels.js';
import { makeComposer } from './composer.js';
import { makeLive } from './live-service.js';
import { makeAttach, makeOps } from './attach.js';
import { makeEndpoint } from './endpoint.js';
import { makeTimerFacet, makeTimers } from './timers.js';
import { findBlobDir, makeBlobStore } from './blobs.js';
import { makeContent } from './content.js';
import { makeContextCache } from './context-cache.js';
import { archiveDirFor, makeArchiveStore } from './archive/store.js';
import { makeListChannel } from './list-channel.js';
import { makeEventLog, makeScriptedProvider } from './providers/scripted.js';
import { makeEchoTool } from './tools/echo.js';
import { openRouterKind } from './providers/openrouter.js';
import { anthropicKind } from './providers/anthropic.js';
import { makeCatalog } from './providers/catalog.js';
import { findSecretsFiles, makeSecretStore } from './secrets/store.js';
import { makeSealKeys } from './secrets/seal.js';
import { makeSecretsOps } from './secrets/manager.js';
import { makeGatewayService } from './gateway/index.js';
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
import { GATEWAY_KEY } from '../../../guest/lib/interfaces-m3.js';
import { makeSubscriptions } from './subscriptions/index.js';
import { claudePoolKind, codexPoolKind } from './subscriptions/provider.js';
import {
  accountStatusDescription,
  makeAccountStatusTool,
} from './subscriptions/account-tool.js';

/**
 * @typedef {object} BackendKind
 * @property {string} kind the `BackendSpec.kind` it serves
 * @property {(options: { label: string, spec: any, readKey?: () => Promise<string>, script: any, logPath?: string, timers: import('./timers.js').Timers, log: import('./providers/scripted.js').EventLog, blobs: import('./blobs.js').BlobStore, backend: any, subscriptions: any }) => { startRound: (req: any, channel: any, prepare?: () => Promise<import('./projection.js').Projection>) => Promise<void>, cancelRound: (turn: any) => void, releaseTurn?: (turn: any) => void }} makeProvider
 * @property {readonly string[]} tools names in `adapterTools` this kind
 *   offers in its `TurnPorts.tools`
 *
 * @typedef {object} AdapterToolKind
 * @property {string} name the tool name the model sees
 * @property {{ name: string, description: string, parameters: string }} [description]
 *   the `ToolDescription` the model is offered; the open handler passes it
 *   in each `AdapterToolEntry`. A tool with a static tool-table entry of its
 *   name (`echo`) needs none; any other is offered to the model only with
 *   one (D-M4-9 as amended, XC)
 * @property {(options: { timers: import('./timers.js').Timers, log: import('./providers/scripted.js').EventLog, blobs: import('./blobs.js').BlobStore, backend: any, session: any, subscriptions: any }) => any} makeTool
 */

/**
 * Backend kinds, by `BackendSpec.kind` (hook table).
 * @type {readonly BackendKind[]}
 */
export const backendKinds = harden([
  // M1a W1a.2: the scripted fake provider; offers echo.
  { kind: 'scripted', makeProvider: makeScriptedProvider, tools: ['echo'] },
  // M2 W2.1a: OpenRouter chat completions, streamed (m2-interfaces.md 8.1).
  openRouterKind,
  // M2 W2.1b: the Anthropic Messages API, streamed (m2-interfaces.md 8.1).
  anthropicKind,
  // M4 W4.6: subscription pools (m4-interfaces.md 5.2).
  claudePoolKind,
  codexPoolKind,
]);

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
]);

/**
 * One adapter incarnation of the agent host.
 *
 * @param {object} [options]
 * @param {import('./timers.js').Timers} [options.timers]
 * @param {{ channelFor: (session: any) => any }} [options.channels] the
 *   session channel registry (tests may pass their own)
 * @param {readonly BackendKind[]} [options.kinds]
 * @param {readonly AdapterToolKind[]} [options.tools]
 * @param {string} [options.incarnation] names this incarnation in the
 *   manager's attach count (default: pid and a random suffix, from the
 *   loader)
 * @param {string | (() => string)} [options.blobDir] M1b: where staged
 *   text lives (default: `<state>/agent-host/blobs`, found from argv)
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
 */
export const makeAgentHostImpl = ({
  timers = makeTimers(),
  channels = makeChannelRegistry({ taps: channelTaps }),
  kinds = backendKinds,
  tools = adapterTools,
  incarnation = `${pid}`,
  blobDir = () => findBlobDir(),
  sink: givenSink = undefined,
  archiveDir = undefined,
  catalog = undefined,
  secrets: givenSecrets = undefined,
  fetch = undefined,
} = {}) => {
  /** The manager's sink, from the attach (M1b blobs mint through it). */
  let sink = givenSink;
  const blobs = makeBlobStore({
    dir: blobDir,
    sink: () => {
      if (sink === undefined) throw Error('the agent host is not attached');
      return sink;
    },
    timers,
  });
  const content = makeContent({ store: blobs });
  // M2 W2.8: the record archive (D-M2-1), next to the blobs.
  const archive = makeArchiveStore({
    dir:
      archiveDir ??
      (() =>
        archiveDirFor(typeof blobDir === 'function' ? blobDir() : blobDir)),
    blobs,
    sink: () => sink,
  });
  const timer = makeTimerFacet(timers);
  // The session list channel (W1b.5's list-channel.js), one per incarnation.
  const listChannel = makeListChannel();
  const live = makeLive({ channels, listChannel });
  const composer = makeComposer({ blobs });
  // W1b.2: the context cache of every session served here (D-9).
  const contextCache = makeContextCache({ store: blobs, archive });
  // M2 W2.2: the model catalogue (R4-17, R4-104), this incarnation only.
  const models = catalog ?? makeCatalog(fetch === undefined ? {} : { fetch });

  /**
   * M2 (W2.3's ops, wired by W2.2, m2-interfaces 2.3): made on first use.
   * The state directory is the blob directory's grandparent
   * (`<state>/agent-host/blobs`); the key file comes from
   * THIX_HARNESS_SECRETS_KEY or the user's config directory (9.1).
   * @type {any}
   */
  let secretsMade = givenSecrets;
  const secrets = () => {
    if (secretsMade === undefined) {
      const stateDir = dirname(
        dirname(typeof blobDir === 'function' ? blobDir() : blobDir),
      );
      const files = findSecretsFiles({ stateDir, env });
      secretsMade = makeSecretsOps({
        store: makeSecretStore({
          file: files.file,
          keyFile: files.keyFile,
          auditFile: files.auditFile,
          stateDir: files.stateDir,
        }),
        seal: makeSealKeys({ file: files.keyFile, stateDir: files.stateDir }),
        sink: () => {
          if (sink === undefined) throw Error('the agent host is not attached');
          return sink;
        },
      });
    }
    return secretsMade;
  };
  // M4 W4.6 (H-4 c): pools, credentials and accounts, made lazily.
  const subscriptions = makeSubscriptions({
    sink: () => sink,
    secrets,
    stateDir: () =>
      dirname(dirname(typeof blobDir === 'function' ? blobDir() : blobDir)),
    timers,
    ...(fetch === undefined ? {} : { fetch }),
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
    const kind = kinds.find(entry => entry.kind === spec.kind);
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
        prepare: req => contextCache.prepare(session, req, { key: archiveKey }),
        owner: session,
      });
      // Per session (J-9361, J-9364): the tools, writers and Content of
      // these ports stage for this session and read only its blobs.
      const sessionBlobs = blobsOf(session);
      let toolEntries = toolsOf.get(session);
      if (toolEntries === undefined) {
        toolEntries = harden(
          kind.tools.map(name => {
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
    // M2 W2.2 (8.4): the catalogue, with the backend's key.
    listModels: ({ backend, spec, request }) =>
      (subscriptions.handles(spec) ? subscriptions.catalog : models).listModels(
        {
          backend,
          spec,
          readKey: readKeyOf(spec),
          log: backendState(backend, spec).log,
          ...(request === undefined ? {} : { request }),
        },
      ),
    resolveModel: ({ backend, spec, modelId }) =>
      (subscriptions.handles(spec)
        ? subscriptions.catalog
        : models
      ).resolveModel({
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
    // The in-process write path, never the hub's SealedBox-only writer
    // (m3-interfaces A-11).
    secretWriter: async () => {
      const { replaceLocal, publicKeyLocal } = secrets();
      return harden({ replaceLocal, publicKey: publicKeyLocal });
    },
  });
  const { bind, unbind } = makeAttach({
    ops,
    incarnation,
    onSink: async attachedSink => {
      sink = attachedSink;
      // Writes that never completed (section 4.6); no state dir in tests.
      await blobs.sweep().catch(() => {});
      // M2: half-written segments, manifests and mirrors (4.5).
      await archive.sweep().catch(() => {});
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
