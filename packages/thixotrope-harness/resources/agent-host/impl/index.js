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
import { channelTaps } from './channel-taps.js';
import { makeChannelRegistry } from './channels.js';
import { makeComposer } from './composer.js';
import { makeLive } from './live-service.js';
import { makeAttach, makeOps } from './attach.js';
import { makeEndpoint } from './endpoint.js';
import { makeTimers } from './timers.js';
import { makeEventLog, makeScriptedProvider } from './providers/scripted.js';
import { makeEchoTool } from './tools/echo.js';

/**
 * @typedef {object} BackendKind
 * @property {string} kind the `BackendSpec.kind` it serves
 * @property {(options: { label: string, script: any, logPath?: string, timers: import('./timers.js').Timers, log: import('./providers/scripted.js').EventLog }) => { startRound: (req: any, channel: any) => Promise<void>, cancelRound: (turn: any) => void, releaseTurn?: (turn: any) => void }} makeProvider
 * @property {readonly string[]} tools names in `adapterTools` this kind
 *   offers in its `TurnPorts.tools`
 *
 * @typedef {object} AdapterToolKind
 * @property {string} name the tool name the model sees
 * @property {(options: { timers: import('./timers.js').Timers, log: import('./providers/scripted.js').EventLog }) => any} makeTool
 */

/**
 * Backend kinds, by `BackendSpec.kind` (hook table).
 * @type {readonly BackendKind[]}
 */
export const backendKinds = harden([
  // M1a W1a.2: the scripted fake provider; offers echo.
  { kind: 'scripted', makeProvider: makeScriptedProvider, tools: ['echo'] },
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
 */
export const makeAgentHostImpl = ({
  timers = makeTimers(),
  channels = makeChannelRegistry({ taps: channelTaps }),
  kinds = backendKinds,
  tools = adapterTools,
  incarnation = `${process.pid}`,
} = {}) => {
  const live = makeLive({ channels });
  const composer = makeComposer();

  /**
   * What a Backend presence of the manager vat is in this incarnation:
   * built from its spec on first open, then reused (one provider per
   * backend, so a script's turn selection spans the backend's turns).
   * @type {WeakMap<any, { provider: any, toolEntries: Array<{ name: string, tool: any }> }>}
   */
  const backends = new WeakMap();

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
    });
    const toolEntries = kind.tools.map(name => {
      const entry = tools.find(candidate => candidate.name === name);
      if (entry === undefined) throw Error(`No adapter tool ${name} here`);
      return harden({ name, tool: entry.makeTool({ timers, log }) });
    });
    const state = harden({ provider, toolEntries });
    backends.set(backend, state);
    return state;
  };

  const ops = makeOps({
    open: ({ backend, spec, session }) => {
      const { provider, toolEntries } = backendState(backend, spec);
      const channel = channels.channelFor(session);
      const endpoint = makeEndpoint({ provider, channel, timers });
      return harden({
        endpoint,
        publisher: channel.publisher,
        tools: toolEntries,
      });
    },
    liveChannel: session => channels.channelFor(session).publisher,
    live: () => live,
    composer: () => composer,
  });

  const { bind, unbind } = makeAttach({ ops, incarnation });
  return harden({ bind, unbind, ops });
};
harden(makeAgentHostImpl);
