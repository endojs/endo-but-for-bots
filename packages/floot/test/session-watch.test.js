// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import {
  applyTranscript,
  diffTranscript,
  makeSessionListWatch,
  makeSessionWatch,
} from '../src/session-watch.js';

const user = text => harden({ role: 'user', content: text });
const reply = text => harden({ role: 'assistant', content: text });

/** A controllable set of sources, and the number of transcript reads. */
const makeSources = () => {
  const state = {
    transcript: /** @type {unknown[]} */ ([]),
    turn: /** @type {unknown} */ (null),
    pending: /** @type {unknown[]} */ ([]),
    execution: { state: 'running', supported: true },
    network: /** @type {unknown} */ ({ policy: 'off' }),
    running: /** @type {unknown} */ (null),
    usage: /** @type {unknown} */ ({ inputTokens: 0, outputTokens: 0 }),
    transcriptReads: 0,
    failTranscript: '',
    // While true, a transcript read parks until `release()`; it returns the
    // transcript as it was when the read STARTED, like a real read would.
    gated: false,
    /** @type {Array<() => void>} */
    transcriptGates: [],
    /** @type {Array<() => void>} */
    networkGates: [],
    gateNetwork: false,
    /** @type {Array<{ fn: () => void, ms: number }>} */
    timers: [],
  };
  const release = gates => {
    for (const open of gates.splice(0)) open();
  };
  const watch = makeSessionWatch({
    loadTranscript: async () => {
      state.transcriptReads += 1;
      const asOfStart = harden([...state.transcript]);
      if (state.gated) {
        await new Promise(resolve => {
          state.transcriptGates.push(() => resolve(undefined));
        });
      }
      if (state.failTranscript) throw Error(state.failTranscript);
      return asOfStart;
    },
    readTurn: () => state.turn,
    readRunning: () => state.running,
    readPending: () => harden({ entries: [...state.pending], hold: null }),
    readExecution: () => harden({ ...state.execution }),
    loadNetwork: async () => {
      const asOfStart = harden(state.network);
      if (state.gateNetwork) {
        await new Promise(resolve => {
          state.networkGates.push(() => resolve(undefined));
        });
      }
      return asOfStart;
    },
    loadUsage: async () => harden(state.usage),
    // Timers are collected, never run on their own: a test fires the one it
    // means to.
    timers: harden({
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        state.timers.push(timer);
        return timer;
      },
      clearTimeout: handle => {
        const index = state.timers.indexOf(handle);
        if (index >= 0) state.timers.splice(index, 1);
      },
    }),
  });
  return {
    state,
    watch,
    releaseTranscript: () => release(state.transcriptGates),
    releaseNetwork: () => release(state.networkGates),
    /** Fire the pending timers with this delay (a retry, a view reaper). */
    fire: ms => {
      for (const timer of state.timers.filter(item => item.ms === ms)) {
        state.timers.splice(state.timers.indexOf(timer), 1);
        timer.fn();
      }
    },
  };
};

const turns = async (count = 20) => {
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

const open = async watch => iterateReader(await watch.watch());
const next = async view => (await view.next()).value;

test('diffTranscript keeps the common prefix and appends the rest', t => {
  const a = [user('hi'), reply('hello')];
  t.deepEqual(diffTranscript([], a), { keep: 0, append: a });
  t.deepEqual(diffTranscript(a, [...a, user('more')]), {
    keep: 2,
    append: [user('more')],
  });
  // A resolution rewrites the last turn's status line: the tail is replaced.
  t.deepEqual(diffTranscript(a, [user('hi'), reply('changed')]), {
    keep: 1,
    append: [reply('changed')],
  });
  t.deepEqual(diffTranscript(a, [user('hi')]), { keep: 1, append: [] });
});

test('applyTranscript follows a chain of events and refuses a gap', t => {
  let held = applyTranscript(null, {
    version: 1,
    base: 0,
    keep: 0,
    append: [user('hi')],
  });
  t.deepEqual(held, { version: 1, messages: [user('hi')] });
  held = applyTranscript(held || null, {
    version: 2,
    base: 1,
    keep: 1,
    append: [reply('hello')],
  });
  t.deepEqual(held?.messages, [user('hi'), reply('hello')]);
  // A repeat of something already applied changes nothing.
  t.deepEqual(
    applyTranscript(held || null, {
      version: 2,
      base: 1,
      keep: 1,
      append: [reply('hello')],
    })?.messages,
    [user('hi'), reply('hello')],
  );
  // A missed event: the viewer must reopen rather than guess.
  t.is(
    applyTranscript(held || null, {
      version: 4,
      base: 3,
      keep: 2,
      append: [],
    }),
    undefined,
  );
  t.is(
    applyTranscript(null, { version: 4, base: 3, keep: 2, append: [] }),
    undefined,
  );
});

test('a view opens on a snapshot and then hears only what changed', async t => {
  const { state, watch } = makeSources();
  state.transcript = [user('hi'), reply('hello')];
  const view = await open(watch);
  const snapshot = await next(view);
  t.is(snapshot.type, 'snapshot');
  t.deepEqual(snapshot.transcript, {
    version: 1,
    base: 0,
    keep: 0,
    append: [user('hi'), reply('hello')],
  });
  t.is(snapshot.turn, null);
  t.is(snapshot.running, null);
  t.deepEqual(snapshot.pending, { entries: [], hold: null });
  t.deepEqual(snapshot.execution, { state: 'running', supported: true });
  t.deepEqual(snapshot.network, { policy: 'off' });
  t.deepEqual(snapshot.usage, { inputTokens: 0, outputTokens: 0 });

  // A touch with nothing different publishes nothing; the next real change is
  // the next event the viewer sees.
  watch.touch('transcript');
  state.transcript = [...state.transcript, user('again')];
  watch.touch('transcript');
  t.deepEqual(await next(view), {
    type: 'transcript',
    version: 2,
    base: 1,
    keep: 2,
    append: [user('again')],
  });
  state.execution = { state: 'stopping', supported: true };
  watch.touch();
  t.deepEqual(await next(view), {
    type: 'execution',
    execution: { state: 'stopping', supported: true },
  });
  state.network = { policy: 'off', request: { id: '1' } };
  watch.touch('network');
  t.deepEqual(await next(view), {
    type: 'network',
    network: { policy: 'off', request: { id: '1' } },
  });
  state.usage = { inputTokens: 5, outputTokens: 7 };
  watch.touch('usage');
  t.deepEqual(await next(view), {
    type: 'usage',
    usage: { inputTokens: 5, outputTokens: 7 },
  });
  // A mail turn has no FlootTurn; `running` is how a view knows of it.
  state.running = { input: 'from the mailbox', from: 'alice' };
  watch.touch();
  t.deepEqual(await next(view), {
    type: 'running',
    running: { input: 'from the mailbox', from: 'alice' },
  });
  watch.touch('journal');
  t.deepEqual(await next(view), { type: 'journal', version: 1 });
  await view.return();
});

test('the transcript is published before the turn that produced it is reported finished', async t => {
  const { state, watch } = makeSources();
  const turn = harden({ input: 'hi', turn: 'T' });
  state.turn = turn;
  const view = await open(watch);
  t.is((await next(view)).turn, turn);
  // The turn ends: the slot empties and the agent reports a settled turn, in
  // either order. One sync publishes both, transcript first.
  state.turn = null;
  state.transcript = [user('hi'), reply('done')];
  watch.touch();
  watch.touch('transcript');
  t.is((await next(view)).type, 'transcript');
  t.deepEqual(await next(view), { type: 'turn', turn: null });
  await view.return();
});

test('a sync publishes the state as it is when it runs, never a stale value', async t => {
  const { state, watch, releaseTranscript } = makeSources();
  const view = await open(watch);
  await next(view);
  const first = harden({ input: 'a', turn: 'A' });
  const second = harden({ input: 'b', turn: 'B' });
  // Hold a transcript read so touches pile up behind it.
  state.gated = true;
  state.transcript = [user('a')];
  watch.touch('transcript');
  await turns();
  state.turn = first;
  watch.touch();
  state.turn = null;
  watch.touch();
  state.turn = second;
  watch.touch();
  state.gated = false;
  releaseTranscript();
  t.is((await next(view)).type, 'transcript');
  // Never `first`, and no null after `second`: the very next thing this
  // viewer hears after the turn is the journal bump sent below.
  t.deepEqual(await next(view), { type: 'turn', turn: second });
  watch.touch('journal');
  t.deepEqual(await next(view), { type: 'journal', version: 1 });
  await view.return();
});

test('a change that lands while the transcript is being read is not lost', async t => {
  const { state, watch, releaseTranscript } = makeSources();
  state.transcript = [user('a')];
  const view = await open(watch);
  await next(view);
  // Turn one settles; its read starts and parks, having seen [a, b].
  state.gated = true;
  state.transcript = [user('a'), reply('b')];
  watch.touch('transcript');
  await turns();
  // Turn two settles while that read is still out.
  state.transcript = [user('a'), reply('b'), reply('c')];
  watch.touch('transcript');
  state.gated = false;
  releaseTranscript();
  const one = await next(view);
  t.deepEqual(one.append, [reply('b')]);
  // The sync queued behind the first read must read again. In an idle session
  // nothing else would ever prompt it.
  const two = await next(view);
  t.is(two.type, 'transcript');
  t.deepEqual(two.append, [reply('c')]);
  await view.return();
});

test("a change during the first viewer's open is synced once it is in", async t => {
  const { state, watch, releaseTranscript } = makeSources();
  state.transcript = [user('a')];
  state.gated = true;
  const opening = open(watch);
  await turns();
  // The transcript read is out, having seen [a]; no view is registered yet.
  const live = harden({ input: 'now', turn: 'T' });
  state.turn = live;
  watch.touch();
  state.transcript = [user('a'), reply('b')];
  watch.touch('transcript');
  state.gated = false;
  releaseTranscript();
  const view = await opening;
  const snapshot = await next(view);
  t.deepEqual(snapshot.transcript.append, [user('a')]);
  // The synchronous reads happen after the read, so the turn is in.
  t.is(snapshot.turn, live);
  // And the settled turn follows rather than being dropped for want of a
  // registered viewer at the moment it was touched.
  const event = await next(view);
  t.is(event.type, 'transcript');
  t.deepEqual(
    applyTranscript(applyTranscript(null, snapshot.transcript) || null, event)
      ?.messages,
    [user('a'), reply('b')],
  );
  await view.return();
});

test('another viewer leaving mid-open does not cost the new one its transcript', async t => {
  const { state, watch, releaseNetwork } = makeSources();
  state.transcript = [user('a')];
  const first = await open(watch);
  await next(first);
  // Force the second open to load something, and hold it there.
  state.gateNetwork = true;
  watch.touch('network');
  await turns();
  releaseNetwork();
  const opening = open(watch);
  await turns();
  await first.return();
  await new Promise(resolve => setTimeout(resolve, 20));
  state.gateNetwork = false;
  releaseNetwork();
  const second = await opening;
  const snapshot = await next(second);
  t.truthy(snapshot.transcript, 'not null with no error and no retry');
  t.deepEqual(snapshot.transcript.append, [user('a')]);
  await second.return();
});

test('a read that never answers does not stop the rest, and is retried', async t => {
  const { state, watch, fire } = makeSources();
  const view = await open(watch);
  await next(view);
  // The network read hangs (behind a policy change that never finishes, say).
  state.gateNetwork = true;
  watch.touch('network');
  await turns();
  fire(20_000); // its deadline
  await turns();
  // Later events still flow…
  state.execution = { state: 'stopping', supported: true };
  watch.touch();
  t.is((await next(view)).type, 'execution');
  // …and the read is tried again on its own.
  state.gateNetwork = false;
  state.network = { policy: 'public-internet' };
  fire(2000);
  t.deepEqual(await next(view), {
    type: 'network',
    network: { policy: 'public-internet' },
  });
  await view.return();
});

test('no viewer, no work: nothing is read and the transcript is not held', async t => {
  const { state, watch } = makeSources();
  state.transcript = [user('hi')];
  watch.touch('transcript');
  watch.touch('network');
  await null;
  t.is(state.transcriptReads, 0);
  const view = await open(watch);
  t.is((await next(view)).transcript.append.length, 1);
  t.is(state.transcriptReads, 1);
  await view.return();
  // Give the close a chance to cross the stream.
  for (let i = 0; i < 20 && watch.viewers() > 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  t.is(watch.viewers(), 0);
  // The next viewer reads afresh rather than being served a stale cache.
  state.transcript = [user('hi'), reply('later')];
  const again = await open(watch);
  t.is((await next(again)).transcript.append.length, 2);
  t.is(state.transcriptReads, 2);
  await again.return();
});

test('a transcript that cannot be read does not fail the view, and arrives when it can', async t => {
  const sources = makeSources();
  const { state, watch } = sources;
  state.failTranscript = 'agent unavailable';
  const view = await open(watch);
  const { fire } = sources;
  const snapshot = await next(view);
  t.is(snapshot.transcript, null);
  t.is(snapshot.transcriptError, 'agent unavailable');
  t.deepEqual(snapshot.execution, { state: 'running', supported: true });
  state.failTranscript = '';
  state.transcript = [user('hi')];
  // Nobody has to prompt it: the failed read is retried on a backoff.
  fire(2000);
  const event = await next(view);
  t.deepEqual(event, {
    type: 'transcript',
    version: 1,
    base: 0,
    keep: 0,
    append: [user('hi')],
  });
  t.deepEqual(applyTranscript(null, event)?.messages, [user('hi')]);
  await view.return();
});

test('two viewers each get a snapshot, and both hear the change after it', async t => {
  const { state, watch } = makeSources();
  state.transcript = [user('one')];
  const a = await open(watch);
  await next(a);
  state.transcript = [user('one'), reply('two')];
  watch.touch('transcript');
  const b = await open(watch);
  const snapshotB = await next(b);
  // Whichever ran first, B's snapshot and A's event describe one state.
  const eventA = await next(a);
  t.is(eventA.version, snapshotB.transcript.version);
  t.is(snapshotB.transcript.append.length, 2);
  state.pending = [{ id: 'p1', text: 'queued' }];
  watch.touch();
  const expected = {
    type: 'pending',
    pending: { entries: [{ id: 'p1', text: 'queued' }], hold: null },
  };
  t.deepEqual(await next(a), expected);
  t.deepEqual(await next(b), expected);
  await a.return();
  await b.return();
});

test('ending the watch ends every view, and a late viewer is told at once', async t => {
  const { watch } = makeSources();
  const view = await open(watch);
  await next(view);
  watch.end();
  t.deepEqual(await next(view), { type: 'end' });
  t.true((await view.next()).done);
  const late = await open(watch);
  t.is((await next(late)).type, 'snapshot');
  t.deepEqual(await next(late), { type: 'end' });
});

test('the session list reports additions, changes and removals', async t => {
  /** @type {Array<{ id: string, title: string, activity: string }>} */
  let sessions = [{ id: 'a', title: 'A', activity: 'passive' }];
  const list = makeSessionListWatch(async () => harden([...sessions]));
  const view = iterateReader(await list.watch());
  t.deepEqual(await next(view), { type: 'snapshot', sessions });
  sessions = [
    { id: 'a', title: 'A', activity: 'working' },
    { id: 'b', title: 'B', activity: 'passive' },
  ];
  list.touch();
  list.touch();
  t.deepEqual(await next(view), { type: 'session', session: sessions[0] });
  t.deepEqual(await next(view), { type: 'session', session: sessions[1] });
  sessions = [sessions[1]];
  list.touch();
  t.deepEqual(await next(view), { type: 'removed', id: 'a' });
  await view.return();
});

test('a bigint in the data does not stop a sync', async t => {
  const { state, watch } = makeSources();
  state.transcript = [harden({ role: 'user', content: 'x', meta: { n: 1n } })];
  const view = await open(watch);
  t.is((await next(view)).transcript.append.length, 1);
  state.execution = { state: 'stopped', supported: true };
  watch.touch('transcript');
  t.is((await next(view)).type, 'execution', 'unchanged transcript, no throw');
  await view.return();
});

test('a reader that is handed out and never opened is dropped', async t => {
  const { watch, fire } = makeSources();
  await watch.watch(); // never streamed: the tab closed first
  t.is(watch.viewers(), 1);
  fire(120_000);
  t.is(watch.viewers(), 0);
  // An opened one is left alone.
  const view = await open(watch);
  await next(view);
  fire(120_000);
  t.is(watch.viewers(), 1);
  await view.return();
});

test('a session list that cannot be read is retried, and the change is not lost', async t => {
  let fail = false;
  /** @type {Array<{ fn: () => void, ms: number }>} */
  const timers = [];
  let sessions = [{ id: 'a', title: 'A' }];
  const list = makeSessionListWatch(
    async () => {
      if (fail) throw Error('registry unreadable');
      return harden([...sessions]);
    },
    harden({
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimeout: handle => {
        const index = timers.indexOf(handle);
        if (index >= 0) timers.splice(index, 1);
      },
    }),
  );
  const view = iterateReader(await list.watch());
  await next(view);
  fail = true;
  sessions = [{ id: 'a', title: 'Renamed' }];
  list.touch();
  await turns();
  t.true(list.isStale());
  fail = false;
  const retry = timers.find(timer => timer.ms === 2000);
  t.truthy(retry);
  retry?.fn();
  t.deepEqual(await next(view), {
    type: 'session',
    session: { id: 'a', title: 'Renamed' },
  });
  await view.return();
});

test('a viewer opening during a hung read holds up nobody else', async t => {
  const { state, watch, fire } = makeSources();
  const a = await open(watch);
  await next(a);
  state.gateNetwork = true;
  watch.touch('network');
  await turns();
  // B arrives while that read hangs. It takes what is held and goes ahead.
  const b = await open(watch);
  t.deepEqual((await next(b)).network, { policy: 'off' });
  // And an emergency stop reaches A without waiting out the read's deadline.
  state.execution = { state: 'stopping', supported: true };
  watch.touch();
  t.is((await next(a)).type, 'execution');
  t.is((await next(b)).type, 'execution');
  fire(20_000);
  await a.return();
  await b.return();
});

test('a slow transcript read does not delay an emergency stop', async t => {
  const { state, watch, releaseTranscript } = makeSources();
  const view = await open(watch);
  await next(view);
  state.gated = true;
  state.transcript = [user('a')];
  state.execution = { state: 'stopping', supported: true };
  watch.touch('transcript');
  // Published before the read, not after it.
  t.is((await next(view)).type, 'execution');
  state.gated = false;
  releaseTranscript();
  t.is((await next(view)).type, 'transcript');
  await view.return();
});

test('a transcript read that hung is not retried at every turn', async t => {
  const { state, watch, fire } = makeSources();
  const view = await open(watch);
  await next(view);
  const reads = () => state.transcriptReads;
  state.gated = true;
  state.transcript = [user('a')];
  watch.touch('transcript');
  await turns();
  const before = reads();
  fire(30_000); // the read runs out its deadline
  t.is((await next(view)).type, 'transcript-error');
  // A busy session settles turn after turn; none of them re-blocks the chain.
  watch.touch('transcript');
  watch.touch('transcript');
  await turns();
  t.is(reads(), before);
  // The retry timer is what tries again.
  state.gated = false;
  fire(2000);
  t.is((await next(view)).type, 'transcript');
  await view.return();
});

test('a success resets the retry backoff', async t => {
  const { state, watch, fire } = makeSources();
  const view = await open(watch);
  await next(view);
  const failOnce = async () => {
    state.gateNetwork = true;
    watch.touch('network');
    await turns();
    fire(20_000);
    await turns();
    state.gateNetwork = false;
  };
  await failOnce();
  t.deepEqual(
    state.timers.map(timer => timer.ms).filter(ms => ms < 20_000),
    [2000],
  );
  state.network = { policy: 'public-internet' };
  fire(2000);
  t.is((await next(view)).type, 'network');
  // The next transient failure waits the short interval again, not a doubled one.
  await failOnce();
  t.deepEqual(
    state.timers.map(timer => timer.ms).filter(ms => ms < 20_000),
    [2000],
  );
  await view.return();
});
