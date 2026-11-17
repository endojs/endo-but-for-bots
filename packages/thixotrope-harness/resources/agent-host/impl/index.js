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
import { pid } from 'node:process';

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

/**
 * @typedef {object} BackendKind
 * @property {string} kind the `BackendSpec.kind` it serves
 * @property {(options: { label: string, script: any, logPath?: string, timers: import('./timers.js').Timers, log: import('./providers/scripted.js').EventLog, blobs: import('./blobs.js').BlobStore }) => { startRound: (req: any, channel: any, prepare?: () => Promise<import('./projection.js').Projection>) => Promise<void>, cancelRound: (turn: any) => void, releaseTurn?: (turn: any) => void }} makeProvider
 * @property {readonly string[]} tools names in `adapterTools` this kind
 *   offers in its `TurnPorts.tools`
 *
 * @typedef {object} AdapterToolKind
 * @property {string} name the tool name the model sees
 * @property {(options: { timers: import('./timers.js').Timers, log: import('./providers/scripted.js').EventLog, blobs: import('./blobs.js').BlobStore }) => any} makeTool
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
]);

/**
 * Tools that run in this adapter (hook table).
 * @type {readonly AdapterToolKind[]}
 */
export const adapterTools = harden([
  // M1a W1a.2: the echo test tool.
  { name: 'echo', makeTool: makeEchoTool },
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
    const provider = kind.makeProvider({
      label: spec.label,
      script: spec.script,
      logPath: spec.logPath,
      timers,
      log,
      blobs,
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
            return harden({
              name,
              tool: entry.makeTool({ timers, log, blobs: sessionBlobs }),
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
    },
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
  });
};
harden(makeAgentHostImpl);
