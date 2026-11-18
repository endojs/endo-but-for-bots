// @ts-check
// Test helper for W2.5 (the record archive's vat side and history): the
// session's turn runner assembled as session.js assembles it (record log,
// live publishing, queue, runtime parts), over in-memory fakes of the Backend,
// Endpoint, publisher, host facet, row reporter and an echo tool, with
// W2.8's in-memory fake archive (test/unit/_m2-fake-archive.js) as the
// ports' ArchivePort. Unlike session.js it hands the runner and the
// archive to the test (findTurn, importTurns, ...). Import after
// `_m1a-prelude.js`.
//
// The adapter has incarnations: `restartAdapter()` kills the current one
// (tombstones: publishes and leases break with the retired text) and
// starts another with a later `since`. With `tap` (default), every record
// the runner appends is also kept in `all` (the oracle the archive is
// checked against); `tap: false` keeps nothing, for the blob-release test.

/* eslint-disable import/no-relative-packages */
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeSessionArchive } from '../../guest/session/archive.js';
import { makeContextSource } from '../../guest/session/context-source.js';
import { makeLivePublishing } from '../../guest/session/live.js';
import { makeQueue } from '../../guest/session/queue.js';
import { inCallOrder, makeRecordLog } from '../../guest/session/records.js';
import { makeLabels } from '../../guest/session/labels.js';
import { isRestartSignal } from '../../guest/session/recovery.js';
import { makeRuntime } from '../../guest/session/runtime-parts.js';
import { toolTable } from '../../guest/session/tool-table.js';
import { makeTurnRunner } from '../../guest/session/turn.js';
/* eslint-enable import/no-relative-packages */
import { encodeRecord } from '../../resources/agent-host/impl/archive/segment.js';
import { makeFakeArchive } from './_m2-fake-archive.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** Let every pending microtask and eventual send run. */
export const drain = () => new Promise(resolve => setImmediate(resolve));

export const AT = 1_700_000_000_000;

export const retired = () => Error(`ocapn hub: ${RETIRED_TEXT}`);

export const usage = harden({
  inputTokens: 3,
  outputTokens: 2,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/** A Blob handle and a StagedText for it. @param {string} label */
export const stagedText = label => {
  const blob = Far('Blob', { label: () => label });
  return {
    blob,
    staged: harden({ blob, preview: `${label} preview`, bytes: 9000 }),
  };
};

/**
 * @param {object} [options]
 * @param {Record<string, any>} [options.config] SessionConfig additions
 * @param {boolean} [options.tap] keep every appended record (default true)
 * @param {boolean} [options.keepRounds] keep every RoundRequest (default
 *   true; false keeps the latest only)
 * @param {(fake: any) => any} [options.wrapPort] wrap the fake ArchivePort
 */
export const makeArchiveSession = async ({
  config: extra = {},
  tap = true,
  keepRounds = true,
  wrapPort = port => port,
} = {}) => {
  /** @type {WeakMap<any, string>} */
  const blobKeys = new WeakMap();
  let blobSerial = 0;
  const keyOf = (/** @type {any} */ blob) => {
    let key = blobKeys.get(blob);
    if (key === undefined) {
      blobSerial += 1;
      key = `b${blobSerial}`;
      blobKeys.set(blob, key);
    }
    return key;
  };
  const fake = makeFakeArchive({ keyOf });
  /** @type {any[]} */
  const rounds = [];
  /** turn -> its lease (answered by releaseTurn, as the endpoint does) @type {Map<any, any>} */
  const leases = new Map();
  /** @type {any[]} */
  const toolCalls = [];
  /** @type {any[]} */
  const armed = [];
  /** @type {any[]} */
  const cancels = [];
  /** @type {any[]} */
  const published = [];
  const counts = { opens: 0 };
  let since = AT - 60_000;

  const makeIncarnation = () => {
    const state = { dead: false };
    const publisher = Far('LivePublisher', {
      publish: (/** @type {any} */ batch) => {
        if (state.dead) throw retired();
        if (tap) published.push(batch);
      },
    });
    const endpoint = Far('Endpoint', {
      holdTurn: (/** @type {any} */ turn) => {
        if (state.dead) return Promise.reject(retired());
        const kit = makePromiseKit();
        leases.set(turn, kit);
        return kit.promise;
      },
      releaseTurn: (/** @type {any} */ turn) => {
        leases.get(turn)?.resolve(undefined);
        leases.delete(turn);
      },
      startRound: (/** @type {any} */ req) => {
        if (state.dead) return;
        if (!keepRounds) rounds.length = 0;
        rounds.push(req);
      },
      cancelRound: (/** @type {any} */ turn) => cancels.push(turn),
      armDeadline: (/** @type {any} */ request) => armed.push(request),
      disarm: () => {},
    });
    const echoTool = Far('AdapterTool', {
      execute: (/** @type {any} */ request) => {
        const kit = makePromiseKit();
        toolCalls.push({ request, kit });
        return kit.promise;
      },
    });
    const archivePort = wrapPort(fake.port);
    const ports = harden({
      endpoint,
      publisher,
      tools: harden([harden({ name: 'echo', tool: echoTool })]),
      since,
      archive: archivePort,
    });
    return { state, ports };
  };
  let incarnation = makeIncarnation();

  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => {
      counts.opens += 1;
      return incarnation.ports;
    },
  });
  const outside = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => {
      if (tap) published.push(batch);
    },
  });
  const host = Far('SessionHostFacet', { liveChannel: () => outside });
  const rowReporter = Far('RowReporter', { changed: () => {} });
  const config = harden({
    key: 's1',
    title: 'archive test',
    backendTitle: 'fake',
    modelId: 'scripted',
    preset: harden({ label: 'chat-only' }),
    createdAt: AT,
    userInitiated: true,
    ...extra,
  });

  /** Every record appended, in order (the oracle). @type {any[]} */
  const all = [];
  const log = makeRecordLog();
  const records = tap
    ? harden({
        ...log,
        append: (/** @type {any} */ record) => {
          const index = log.append(record);
          all.push(log.at(index));
          return index;
        },
      })
    : log;
  const services = harden({ backend, host });
  const live = makeLivePublishing({
    host,
    onStale: publisher => runner.publisherBroke(publisher),
  });
  let deleted = false;
  const fence = harden({
    close: () => {
      deleted = true;
    },
    closed: () => deleted,
  });
  const archive = makeSessionArchive({
    records,
    onSealed: dropped => runner.onSealed(dropped),
    onNotSealed: (error, ports) => runner.onNotSealed(error, ports),
    fence,
  });
  const contextSource = makeContextSource({ records, archive });
  const runner = makeTurnRunner({
    config,
    services,
    rowReporter,
    records,
    live,
    archive,
    contextSource,
    fence,
    runtime: makeRuntime({ labels: makeLabels(), services, config }),
    isRestartSignal,
    table: toolTable,
  });
  const queue = makeQueue({
    onChange: runner.queueChanged,
    turnOf: runner.turnById,
    claim: () => runner.claimNext(),
  });
  runner.attach({ queue });
  runner.openPorts();
  await drain();

  let clock = AT;
  const lastRound = () => rounds[rounds.length - 1];

  /**
   * Run one turn to its settle (and the seal answer, if any).
   * @param {object} [options]
   * @param {any} [options.input] text or StagedText
   * @param {number} [options.calls] echo calls in round 0 (then round 1 ends it)
   * @param {boolean} [options.reverse] results arrive in reverse call order
   * @param {'completed' | 'failed' | 'unknown'} [options.end]
   */
  const turn = async ({
    input,
    calls = 0,
    reverse = true,
    end = 'completed',
  } = {}) => {
    clock += 1000;
    const text = input ?? `message ${clock}`;
    const handle = runner.startTurn(text, clock);
    await drain();
    const req = lastRound();
    req.sink.dispatching(0);
    if (calls === 0 && end === 'failed') {
      req.sink.roundFailed(
        harden({ round: 0, reason: 'provider said no', at: clock }),
      );
      await drain();
      return handle;
    }
    /** @type {any[]} */
    const toolCallsOut = [];
    for (let i = 0; i < calls; i += 1) {
      toolCallsOut.push(
        harden({ callId: `c${i}`, name: 'echo', args: `{"i":${i}}` }),
      );
    }
    req.sink.roundFinal(
      harden({
        round: 0,
        text: calls === 0 ? `reply ${clock}` : '',
        toolCalls: harden(toolCallsOut),
        usage,
        at: clock,
      }),
    );
    await drain();
    if (calls === 0) return handle;
    const mine = toolCalls.splice(0);
    if (end === 'unknown') {
      // Dispatched with calls open: the adapter restarts (recovery).
      await restartAdapter();
      return handle;
    }
    // At most callWindow calls run at once; each result issues the next.
    let batch = mine;
    while (batch.length > 0) {
      const order = reverse ? [...batch].reverse() : batch;
      for (const call of order) {
        call.kit.resolve(
          harden({ status: 'ok', text: `echo ${call.request.opId}` }),
        );
        // eslint-disable-next-line no-await-in-loop
        await drain();
      }
      batch = toolCalls.splice(0);
    }
    const next = lastRound();
    next.sink.dispatching(1);
    next.sink.roundFinal(
      harden({
        round: 1,
        text: `reply ${clock}`,
        toolCalls: harden([]),
        usage,
        at: clock,
      }),
    );
    await drain();
    return handle;
  };

  /** The adapter restarts: tombstones; pending leases break. */
  const restartAdapter = async () => {
    incarnation.state.dead = true;
    since += 1_000_000;
    incarnation = makeIncarnation();
    for (const kit of leases.values()) kit.reject(retired());
    leases.clear();
    await drain();
  };

  /** Every kept record, paged through the ContextSource from `sealedTo`. */
  const keptRecords = async () => {
    const context = lastRound().context;
    /** @type {any[]} */
    const out = [];
    /** @type {string | undefined} */
    let cursor = `p${archive.state().sealedTo}`;
    while (cursor !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      const page = await E(context).page(cursor);
      out.push(...page.records);
      cursor = page.next;
    }
    return out;
  };

  /** @param {any} record */
  const encode = record => encodeRecord(record, keyOf);

  /**
   * Nothing lost, nothing duplicated: the vat's acknowledged segments hold
   * exactly the oracle's records [0, sealedTo) range by range (segment
   * order), and the vat keeps exactly the oracle's records from sealedTo.
   * Returns a description of the first difference, or undefined.
   */
  const checkLog = async () => {
    const state = archive.state();
    const entries = archive.entries();
    if (entries.length !== state.segments) return 'index length';
    let at = 0;
    for (let ordinal = 1; ordinal <= state.segments; ordinal += 1) {
      const entry = entries[ordinal - 1];
      if (entry.from !== at) return `segment ${ordinal} does not follow`;
      const held = fake.recordsOf(ordinal);
      if (held === undefined) return `segment ${ordinal} missing`;
      const want = inCallOrder(all.slice(entry.from, entry.to)).map(encode);
      if (JSON.stringify(held) !== JSON.stringify(want)) {
        return `segment ${ordinal} differs`;
      }
      at = entry.to;
    }
    if (at !== state.sealedTo) return 'sealedTo';
    const kept = (await keptRecords()).map(encode);
    const want = all.slice(state.sealedTo).map(encode);
    if (JSON.stringify(kept) !== JSON.stringify(want)) return 'kept records';
    return undefined;
  };

  /**
   * History from the newest turn back to turn 1: the vat's pages for kept
   * turns, then the fake archive's segments for archived ones; every
   * ordinal once. Returns the turn ids seen, newest first, and the pages.
   */
  const historyWalk = () => {
    /** @type {string[]} */
    const seen = [];
    /** @type {any[]} */
    const pages = [];
    /** @type {string | undefined} */
    let cursor;
    let archivedFrom = 0;
    for (;;) {
      const page = runner.historyPage(cursor);
      pages.push(page);
      for (const one of page.turns) seen.push(one.turnId);
      if (page.next === undefined) break;
      if (page.archived) {
        archivedFrom = Number(page.next.slice(1));
        break;
      }
      cursor = page.next;
    }
    // Archived ordinals archivedFrom .. 1 from the acknowledged segments.
    const state = archive.state();
    /** @type {string[]} */
    const sealedIds = [];
    for (let ordinal = 1; ordinal <= state.segments; ordinal += 1) {
      for (const record of fake.recordsOf(ordinal) ?? []) {
        if (record.kind === 'turn-started') sealedIds.push(record.turnId);
      }
    }
    if (archivedFrom !== sealedIds.length) {
      seen.push(`archive boundary ${archivedFrom} != ${sealedIds.length}`);
    }
    seen.push(...sealedIds.reverse());
    return { seen, pages };
  };

  return {
    runner,
    archive,
    /** `SessionInternal.deleteSelf` as export.js does it. */
    deleteSelf: () => {
      fence.close();
      runner.beginDelete();
    },
    records,
    all,
    fake,
    rounds,
    toolCalls,
    armed,
    cancels,
    published,
    counts,
    leases,
    queue,
    turn,
    restartAdapter,
    keptRecords,
    checkLog,
    historyWalk,
    lastRound,
    /** Run `n` plain turns. @param {number} n @param {any} [options] */
    turns: async (n, options) => {
      for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await turn(options);
      }
    },
  };
};
