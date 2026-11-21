// @ts-check
// Test helper for the session's `environment` part and shell tools
// (guest/session/environment.js; m6-interfaces.md 3.8, 4.2-4.5): the real
// session over in-memory fakes of the agent-host ports (as
// m1b-exec-tool.test.js has them) and of the environments resource's
// `EnvironmentControl` and `ShellPort`, built with the resource's own
// guards (`guest/lib/guards/environments.js`). Import after
// `_m1a-prelude.js`. AVA skips files starting with an underscore.
//
// The fake environment logs every control and port message in arrival
// order; each `runCommand` / `inspect` is a pending kit the test answers;
// `restartRunner()` makes the current ShellPort a tombstone (every call to
// it, pending or new, breaks with the retired text), as an environments
// adapter restart does; `port()` then answers a new one.

/* eslint-disable import/no-relative-packages */
import { environmentInterfaces } from '../../guest/lib/guards/environments.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import { makeSession } from '../../guest/session/session.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);
// Typed loosely, as session.js does: the guards check the values.
const { makeExo } = /** @type {any} */ (globalThis);

/** Let every pending microtask and eventual send run. */
export const drain = async () => {
  await null;
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

export const AT = 1_700_000_000_000;

let serial = 0;
/** A fresh A.4 request id. */
export const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};

const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

export const retiredBreak = () => Error(HUB_RETIRED_MESSAGE);

/** @param {string} text */
export const ok = text => harden({ status: 'ok', text });

/**
 * The fake environments resource: one EnvironmentControl and the
 * ShellPorts of its adapter incarnations.
 * @param {object} [options]
 * @param {boolean} [options.holdStops] each `emergencyStop` waits for the
 *   test (`stops`), else it answers at once
 */
export const makeFakeEnvironment = ({ holdStops = false } = {}) => {
  /** @type {any[]} every message, in arrival order */
  const log = [];
  /** @type {{ method: string, request: any, kit: any, incarnation: number }[]} */
  const commands = [];
  /** @type {any[]} pending emergencyStop kits */
  const stops = [];
  let incarnation = 0;
  /** @type {string | undefined} `port()` rejects with this text */
  let refusePort;

  /** @param {number} born */
  const makePort = born => {
    /**
     * @param {string} method
     * @param {any} request
     */
    const take = (method, request) => {
      log.push([method, request.opId]);
      if (born !== incarnation) return Promise.reject(retiredBreak());
      const kit = makePromiseKit();
      commands.push({ method, request, kit, incarnation: born });
      return kit.promise;
    };
    return makeExo('ShellPort', environmentInterfaces.ShellPort, {
      /** @param {any} request */
      runCommand: request => take('runCommand', request),
      /** @param {any} request */
      inspect: request => take('inspect', request),
    });
  };
  let port = makePort(incarnation);

  const control = makeExo(
    'EnvironmentControl',
    environmentInterfaces.EnvironmentControl,
    {
      useWorkspaceSeed: () => {
        throw Error('not used');
      },
      describe: () =>
        harden({
          workspace: true,
          shell: true,
          stopped: false,
          released: false,
        }),
      port: () => {
        log.push(['port']);
        if (refusePort !== undefined) throw Error(refusePort);
        return port;
      },
      stop: () => {
        log.push(['stop']);
      },
      emergencyStop: () => {
        log.push(['emergencyStop']);
        if (!holdStops) return undefined;
        const kit = makePromiseKit();
        stops.push(kit);
        return kit.promise;
      },
      resume: () => {
        log.push(['resume']);
      },
    },
  );

  return {
    control,
    log,
    commands,
    stops,
    /**
     * Messages of these kinds, in order.
     * @param {...string} kinds
     */
    sent: (...kinds) => log.filter(([kind]) => kinds.includes(kind)),
    /** @param {string | undefined} text */
    refusePorts: text => {
      refusePort = text;
    },
    /** The adapter restarts: the held port becomes a tombstone. */
    restartRunner: () => {
      incarnation += 1;
      for (const command of commands) {
        if (command.incarnation !== incarnation) {
          command.kit.reject(retiredBreak());
        }
      }
      port = makePort(incarnation);
    },
  };
};

/**
 * A session with (or without) the fake environment, over fake agent-host
 * ports with writers and a content reader.
 * @param {object} [options]
 * @param {ReturnType<typeof makeFakeEnvironment>} [options.environment]
 *   undefined: a session without a shell environment
 * @param {readonly any[]} [options.parts] runtime parts
 */
export const makeEnvironmentSession = async ({
  environment = undefined,
  parts = undefined,
} = {}) => {
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} every published batch, in and outside turns */
  const published = [];
  /** @type {any[]} */
  const endpointLog = [];
  const endpoint = Far('Endpoint', {
    holdTurn: () => {
      const kit = makePromiseKit();
      leases.push(kit);
      return kit.promise;
    },
    releaseTurn: () => undefined,
    startRound: (/** @type {any} */ req) => {
      rounds.push(req);
    },
    cancelRound: () => {
      endpointLog.push('cancelRound');
    },
    armDeadline: () => undefined,
    disarm: () => undefined,
  });
  const publisher = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => {
      published.push(batch);
    },
  });
  const ports = harden({
    endpoint,
    publisher,
    tools: [],
    since: AT - 1000,
    writers: Far('BlobWriters', {}),
    timer: Far('Timer', {}),
    content: Far('Content', {}),
  });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => ports,
  });
  const host = Far('SessionHostFacet', { liveChannel: () => publisher });
  /** @type {any} */
  const services = { backend, host };
  if (environment !== undefined) {
    services.environment = environment.control;
    // Opaque here: seeded as labels, never called by the session.
    services.shell = Far('Shell', {});
    services.workspace = Far('Git', {});
  }
  const { session, internal } = makeSession(
    {
      config: harden({
        key: 's1',
        title: 't',
        backendTitle: 'fake',
        modelId: 'm',
        preset: { label: environment ? 'development' : 'chat-only' },
        createdAt: AT,
        userInitiated: true,
      }),
      services: harden(services),
      rowReporter: Far('RowReporter', { changed: () => undefined }),
    },
    harden(parts === undefined ? {} : { parts }),
  );
  await drain();
  const last = () => rounds[rounds.length - 1];
  /** Every published event, in order. */
  const events = () => published.flatMap(batch => batch.events);
  return {
    session,
    internal,
    rounds,
    leases,
    ports,
    endpointLog,
    last,
    events,
    /** The `execution` events' states, in order. */
    executionEvents: () =>
      events()
        .filter(event => event.type === 'execution')
        .map(event => event.state),
    /** The tool results of the session's newest turn (first on the page). */
    results: () =>
      session
        .getHistoryPage()
        .turns[0].records.filter(
          (/** @type {any} */ r) => r.kind === 'tool-result',
        )
        .map((/** @type {any} */ r) => r.result),
    /** The newest turn's state. */
    turnState: () => session.getHistoryPage().turns[0].state,
    /**
     * Submit a message; its round 0 asks for these tool calls.
     * @param {readonly { name: string, args: any }[]} calls
     */
    toolTurn: async calls => {
      session.enqueueOnce(harden({ text: 'go' }), requestId(), AT);
      await drain();
      const req = last();
      req.sink.dispatching(0);
      req.sink.roundFinal(
        harden({
          round: 0,
          text: '',
          toolCalls: calls.map((call, i) => ({ callId: `c${i}`, ...call })),
          usage,
          at: AT + 1,
        }),
      );
      await drain();
      return req;
    },
    /** Finish the turn's tool round with a closing round. */
    closeTurn: async () => {
      last().sink.roundFinal(
        harden({ round: 1, text: 'done', toolCalls: [], usage, at: AT + 2 }),
      );
      await drain();
    },
  };
};

/**
 * The model's argument JSON for a command.
 * @param {string} command
 * @param {string[]} [args]
 */
export const commandArgs = (command, args = []) =>
  JSON.stringify({ command, args });
