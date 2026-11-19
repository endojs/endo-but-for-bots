// @ts-check
/**
 * Environments git perf from exec code (`designs/m6-interfaces.md` section
 * 10), on the `environments` template with the fake runtime. The fixtures
 * are made by `runCommand` in the session's own workspace, not by turns of
 * file edits: `node` writes 10,000 files in one process and `git` commits
 * them; a shell loop of empty commits makes the 1,000-commit history.
 *
 * - `environments.gitStatus`: exec code's `E(workspace).status()` on a
 *   10,000-file workspace with 30 modified and 2 untracked files, the exec
 *   tool call (`tool_call` to `tool_result` arrival); budget median 1 s.
 *   Each call crosses the membrane, the manager (2 deliveries) and the
 *   adapter's serial git queue.
 * - `environments.gitLog`: `E(workspace).log({ limit: 50 })` of a 1,000-
 *   commit history, the same path; budget median 500 ms.
 *
 * Windows: ENVIRONMENTS_GIT_WINDOW_MS (default 60 s, PERF_WINDOW_SCALE
 * applies).
 *
 *   node scripts/run-lock.mjs --shared --label env-git-perf -- node perf/environments-git.perf.mjs --shared
 */
import { performance } from 'node:perf_hooks';

import { runPerf, single, stats } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { makeSlice } = await import('../test/integration/_m1a-slice.js');
const { runTurn } = await import('../test/integration/_m1b.js');
const {
  commandCall,
  commandTurn,
  environmentsTemplate,
  execCall,
  startEnvironmentSession,
} = await import('../test/integration/_environments.js');

const WINDOW_MS = windowMs('ENVIRONMENTS_GIT_WINDOW_MS', 60_000);
const WARMUP = 2;

const identity = [
  '-c',
  'user.name=perf',
  '-c',
  'user.email=perf@example.invalid',
];

/** 10,000 files of about 40 bytes in 100 directories, one `node` process. */
const writeFiles = `const fs = require('fs'); for (let d = 0; d < 100; d += 1) { fs.mkdirSync('tree/d' + d, { recursive: true }); for (let f = 0; f < 100; f += 1) fs.writeFileSync('tree/d' + d + '/f' + f + '.txt', 'file ' + d + ' ' + f + ' of the status fixture\\n'); }`;
/** 30 modified tracked files and 2 untracked ones. */
const touchFiles = `const fs = require('fs'); for (let f = 0; f < 30; f += 1) fs.appendFileSync('tree/d0/f' + f + '.txt', 'changed\\n'); fs.writeFileSync('new-a.txt', 'a'); fs.writeFileSync('new-b.txt', 'b');`;
// Import the same linear history in one Git process during fixture setup.
// Each commit inherits the tree from its parent, including the 10,000 files.
const commits = `
  const { execFileSync } = require('node:child_process');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const ref = git('symbolic-ref', 'HEAD');
  const base = git('rev-parse', 'HEAD');
  const stream = [];
  for (let i = 1; i <= 1000; i += 1) {
    const message = 'commit ' + i;
    stream.push('commit ' + ref, 'committer perf <perf@example.invalid> ' + (1700000000 + i) + ' +0000',
      'data ' + message.length, message);
    if (i === 1) stream.push('from ' + base);
    stream.push('');
  }
  execFileSync('git', ['fast-import', '--quiet'], { input: stream.join('\\n') + '\\ndone\\n' });
  if (git('rev-list', '--count', base + '..HEAD') !== '1000' ||
      git('rev-parse', base + '^{tree}') !== git('rev-parse', 'HEAD^{tree}')) {
    throw Error('Git fixture history or tree mismatch');
  }
`;

const workspace = "const w = await E(powers).lookup('workspace');";

const script = harden({
  turns: [
    commandTurn('fixture', [
      [commandCall('node', ['-e', writeFiles])],
      [commandCall('git', ['add', '-A'])],
      [commandCall('git', [...identity, 'commit', '-q', '-m', 'tree'])],
      [commandCall('node', ['-e', commits])],
      [commandCall('node', ['-e', touchFiles])],
    ]),
    commandTurn('status', [
      [
        execCall(
          `${workspace} const s = await E(w).status(); return [s.entries.length, s.truncated];`,
        ),
      ],
    ]),
    commandTurn('log', [
      [
        execCall(
          `${workspace} const l = await E(w).log({ limit: 50 }); return l.commits.length;`,
        ),
      ],
    ]),
  ],
});

await runPerf('environments-git', async ({ provision }) => {
  const template = await environmentsTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const made = await slice.makeBackend(script);
  const session = await startEnvironmentSession(slice, made.backend);
  const live = await slice.subscribe(session);

  /**
   * One tool turn: `tool_call` to `tool_result` arrival.
   * @param {string} input
   */
  const toolTurn = async input => {
    const r = await runTurn(slice, session, live, input, 120_000);
    const of = (/** @type {string} */ type) =>
      live.deliveries.find(
        (/** @type {any} */ d, /** @type {number} */ i) =>
          i >= r.from && d.event.type === type && d.event.turnId === r.turnId,
      );
    if (r.end.status !== 'completed') throw Error(`${input}: ${r.end.status}`);
    const outcomes = live.deliveries
      .slice(r.from)
      .map(d => d.event)
      .filter(e => e.type === 'tool_result' && e.turnId === r.turnId);
    if (outcomes.some(e => e.failed))
      throw Error(`${input} returned a failed tool result`);
    if (
      input === 'fixture' &&
      (outcomes.length !== 5 ||
        outcomes.some(e => JSON.parse(e.result).exitCode !== 0))
    )
      throw Error('Git workload fixture did not complete all five commands');
    const call = /** @type {any} */ (of('tool_call'));
    const result = /** @type {any} */ (of('tool_result'));
    if (
      input === 'status' &&
      JSON.stringify(JSON.parse(result.event.result)) !== '[32,false]'
    )
      throw Error(
        `Unexpected git status fixture result: ${result.event.result}`,
      );
    if (input === 'log' && JSON.parse(result.event.result) !== 50)
      throw Error(
        `Unexpected git history fixture result: ${result.event.result}`,
      );
    return {
      ms: result.arrivedAt - call.arrivedAt,
      result: result.event.result,
    };
  };

  const t0 = performance.now();
  await toolTurn('fixture');
  await single('environments.git.fixture', performance.now() - t0, {
    extra: {
      what: '10,000 files written and committed, 1,000 empty commits, 30 modified, 2 untracked',
    },
  });

  for (const [row, input, budget] of /** @type {const} */ ([
    ['environments.gitStatus', 'status', 1000],
    ['environments.gitLog', 'log', 500],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    for (let i = 0; i < WARMUP; i += 1) await toolTurn(input);
    // eslint-disable-next-line no-await-in-loop
    const w = await runWindow(async () => (await toolTurn(input)).ms, {
      ms: WINDOW_MS,
    });
    // eslint-disable-next-line no-await-in-loop
    const last = await toolTurn(input);
    // eslint-disable-next-line no-await-in-loop
    await stats(row, w.results, {
      budget: { median: budget },
      ...windowFields(w),
      extra: {
        what: `exec E(workspace).${input}() tool call, tool_call to tool_result`,
        answer: last.result,
      },
    });
  }
  await live.stop();
});
