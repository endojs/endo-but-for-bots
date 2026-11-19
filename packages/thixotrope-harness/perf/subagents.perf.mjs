// @ts-check
/** Subagent tool latencies and subtree cleanup through scripted provider rounds. */
import { performance } from 'node:perf_hooks';
import { emit, runPerf, stats } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');
const { turnRecords } = await import('../test/integration/_m1b.js');

const ms = windowMs('SUBAGENT_WINDOW_MS', 60_000);

/** @param {string} name @param {string} child @param {string} [task] */
const call = (name, child, task) => ({
  name,
  args: JSON.stringify({
    name: child,
    ...(task === undefined ? {} : { task }),
  }),
});

/** @param {string} input @param {ReturnType<typeof call>[]} calls */
const toolTurn = (input, calls) => ({
  input,
  rounds: [
    { chunks: [{ text: 'call' }], toolCalls: calls },
    { chunks: [{ text: 'finished' }] },
  ],
});
const eight = Array.from({ length: 8 }, (_, i) => `child-${i}`);
const script = harden({
  turns: [
    toolTurn('spawn', [call('spawnSubagent', 'one')]),
    toolTurn('ask', [call('askSubagent', 'one', 'a short answer')]),
    toolTurn('stop', [call('stopSubagent', 'one')]),
    toolTurn(
      'burst',
      eight.map(n => call('spawnSubagent', n)),
    ),
    toolTurn(
      'clear',
      eight.map(n => call('stopSubagent', n)),
    ),
    toolTurn('make subtree', [call('askSubagent', 'one', 'make leaves')]),
    toolTurn('make leaves', [
      call('spawnSubagent', 'leaf-a'),
      call('spawnSubagent', 'leaf-b'),
    ]),
    { rounds: [{ chunks: [{ text: 'answer' }] }] },
  ],
});

await runPerf('subagents', async ({ provision }) => {
  const run = await provision({ template: await sliceTemplate() });
  const slice = await makeSlice(run);
  const made = await slice.makeBackend(script);
  await E(slice.harness).configure(
    harden({ spareSessions: 2, maxDescendants: 8, maxDepth: 2 }),
  );
  const parent = await slice.createSession(made.backend, 'Delegator');
  /** @param {string} input @param {number} [expected] */
  const measure = async (input, expected = 1) => {
    const before = made.log().length;
    const { turn } = await slice.submit(parent, input);
    const { turnId, state } = await E(turn).whenFinished();
    if (state !== 'completed') throw Error(`${input}: ${state}`);
    const results = (await turnRecords(turn)).filter(
      record => record.kind === 'tool-result',
    );
    if (results.length !== expected || results.some(r => r.failed))
      throw Error(`${input}: ${JSON.stringify(results)}`);
    const log = made.log().slice(before);
    const start = log.findIndex(
      line =>
        line.kind === 'round-final' &&
        line.turnId === turnId &&
        line.round === 0,
    );
    const end = log.findLastIndex(
      line =>
        line.kind === 'request' && line.turnId === turnId && line.round === 1,
    );
    if (start < 0 || end <= start)
      throw Error(`Missing provider timestamps for ${input}`);
    const elapsed = Number(log[end].at) - Number(log[start].at);
    return { elapsed, between: log.slice(start + 1, end) };
  };
  const spawnWindow = await runWindow(
    async () => {
      await E(slice.harness).whenSettled();
      const { elapsed } = await measure('spawn');
      await measure('stop');
      return elapsed;
    },
    { ms },
  );
  await stats('subagent.spawn', spawnWindow.results, {
    budget: { median: 1500 },
    extra: windowFields(spawnWindow),
  });
  await measure('spawn');
  const askWindow = await runWindow(
    async () => {
      const { elapsed, between } = await measure('ask');
      const first = between.find(line => line.kind === 'request');
      const last = between.findLast(line => line.kind === 'round-final');
      if (!first || !last)
        throw Error('Missing child request/final timestamps');
      return elapsed - (Number(last.at) - Number(first.at));
    },
    { ms },
  );
  await stats('subagent.ask', askWindow.results, {
    budget: { median: 300 },
    extra: windowFields(askWindow),
  });
  await measure('stop');
  for (let n = 1; n <= 3; n += 1) {
    await E(slice.harness).whenSettled();
    const { elapsed } = await measure('burst', 8);
    emit({
      metric: 'subagent.burst8',
      unit: 'ms',
      sample: n,
      value: elapsed,
      budget: { maximum: 30_000 },
      pass: elapsed <= 30_000,
    });
    if (elapsed > 30_000) process.exitCode = 1;
    await measure('clear', 8);
  }
  for (let n = 1; n <= 3; n += 1) {
    const { sessions: before } = await E(slice.harness).status();
    await measure('spawn');
    await measure('make subtree');
    const { sessions: withTree } = await E(slice.harness).status();
    if (withTree !== before + 3)
      throw Error('Missing nodes before subtree stop');
    const start = performance.now();
    await measure('stop');
    const { sessions: after } = await E(slice.harness).status();
    emit({
      metric: 'subagent.stop',
      unit: 'ms',
      sample: n,
      value: performance.now() - start,
      removed: withTree - after,
      pass: after === before,
    });
    if (after !== before) process.exitCode = 1;
  }
});
