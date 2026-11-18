// @ts-check
// Test helpers for W1b.1 (blobs and staging): a blob store in a temporary
// directory over a fake manager sink that mints local handles and counts
// its cranks. Import after the guest prelude.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages */
import { interfaces } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { makeBlobStore } from '../../resources/agent-host/impl/blobs.js';
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import {
  makeScriptedProvider,
  scriptedUnexpectedFailure,
} from '../../resources/agent-host/impl/providers/scripted.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();
/** A request id for fake sessions' receipts (M1b follow-ups tests). */
export const FIXED_REQUEST_ID = `${Date.now()}-fixed-request-id`;

/**
 * A fake `AgentHostSink` blob half: handles are local Far objects; the
 * key map is weak, as the manager's.
 * @param {{ batch?: number }} [options]
 */
export const makeFakeBlobSink = ({ batch = 32 } = {}) => {
  let serial = 0;
  /** @type {WeakMap<any, string>} */
  const keys = new WeakMap();
  const counts = { mints: 0, resolves: 0, resolved: 0 };
  const sink = Far('AgentHostSink', {
    mintBlobs: () => {
      counts.mints += 1;
      /** @type {any[]} */
      const entries = [];
      for (let i = 0; i < batch; i += 1) {
        serial += 1;
        const blob = Far('Blob', {});
        keys.set(blob, `b${serial}`);
        entries.push(harden({ blob, key: `b${serial}` }));
      }
      return harden(entries);
    },
    /** @param {any[]} blobs */
    resolveBlobs: blobs => {
      counts.resolves += 1;
      counts.resolved += blobs.length;
      return harden(blobs.map(blob => keys.get(blob) ?? null));
    },
  });
  return { sink, counts };
};

/**
 * @param {object} [options]
 * @param {any} [options.sink]
 * @param {string} [options.dir]
 * @param {Parameters<typeof makeBlobStore>[0]['trace']} [options.trace]
 * @param {Parameters<typeof makeBlobStore>[0]['quota']} [options.quota]
 */
export const makeTestBlobs = ({ sink, dir, trace, quota } = {}) => {
  const fake = sink === undefined ? makeFakeBlobSink() : undefined;
  const root = dir ?? mkdtempSync(join(tmpdir(), 'w1b1-'));
  const store = makeBlobStore({
    dir: join(root, 'agent-host', 'blobs'),
    sink: sink ?? fake?.sink,
    trace,
    ...(quota === undefined ? {} : { quota }),
  });
  return {
    store,
    root,
    blobDir: join(root, 'agent-host', 'blobs'),
    sink: sink ?? fake?.sink,
    counts: fake?.counts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

// ---- M1b follow-ups (J-9361..J-9365): files on disk, fake sessions and rounds

/** Committed blob files (keys), without `.part` files. @param {string} dir */
export const filesIn = dir => {
  try {
    return readdirSync(dir).filter(name => /^b[0-9]+$/.test(name));
  } catch {
    return [];
  }
};
/** @param {string} dir */
export const partsIn = dir => {
  try {
    return readdirSync(dir).filter(name => name.endsWith('.part'));
  } catch {
    return [];
  }
};

/** A fake Session whose enqueueOnce answers or throws as told. */
export const makeFakeSession = (
  /** @type {(submission: any) => any} */ answer = () =>
    harden({
      requestId: FIXED_REQUEST_ID,
      duplicate: false,
      state: 'queued',
      entry: Far('QueueEntry', {}),
    }),
) => {
  /** @type {any[]} */
  const seen = [];
  const session = Far('Session', {
    /** @param {any} submission */
    enqueueOnce: submission => {
      seen.push(submission);
      return answer(submission);
    },
  });
  return { session, seen };
};

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
export const blobsUntil = async (predicate, ms = 5000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw Error('timed out waiting');
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(5);
  }
};

export const makeFakeSinkTurn = () => {
  /** @type {any[]} */
  const finals = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {any[]} */
  const progress = [];
  const turn = makeExo('Turn', interfaces.Turn, {
    getStatus: () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    cancel: () => undefined,
    whenFinished: async () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    resolve: () => undefined,
    getContent: () => harden({ records: [] }),
  });
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => true,
    roundFinal: (/** @type {any} */ r) => {
      finals.push(r);
    },
    roundFailed: (/** @type {any} */ f) => {
      failures.push(f);
    },
    deadline: () => undefined,
    progress: (/** @type {any} */ p) => {
      progress.push(p);
      return true;
    },
  });
  return { turn, sink, finals, failures, progress };
};

/**
 * One scripted round through the endpoint, for `owner`.
 * @param {any} store
 * @param {any} script
 * @param {any} owner
 * @param {string} [turnId]
 */
export const runRoundFor = async (store, script, owner, turnId = 't1') => {
  const provider = makeScriptedProvider({
    label: 'scripted',
    script: harden(script),
    timers,
    log: () => {},
    blobs: store,
  });
  const endpoint = makeEndpoint({
    provider,
    channel: harden({ publishDelta: () => {} }),
    timers,
    owner,
    unexpectedFailure: scriptedUnexpectedFailure,
  });
  const fake = makeFakeSinkTurn();
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(
    harden({
      turn: fake.turn,
      sink: fake.sink,
      turnId,
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [{ kind: 'turn-started', turnId, input: 'hi', at: 1 }],
      tools: [],
      options: { modelId: 'm' },
    }),
  );
  await blobsUntil(() => fake.finals.length + fake.failures.length > 0, 20_000);
  return fake;
};
