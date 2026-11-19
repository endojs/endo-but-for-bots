// @ts-check
/**
 * Environments git perf from exec code (`designs/m6-interfaces.md` section
 * 10), on the `environments` template with the fake runtime. The fixtures
 * are made by `runCommand` in the session's own workspace. One Python
 * process writes the 10,000 files. Git commits the tree and imports the
 * 1,000 additional commits in a single stream.
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

/** 10,000 files of about 40 bytes in 100 directories, one Python process. */
const writeFiles = `
from pathlib import Path
for d in range(100):
    folder = Path('tree') / ('d%d' % d)
    folder.mkdir(parents=True)
    for f in range(100):
        (folder / ('f%d.txt' % f)).write_text('file %d %d of the status fixture\\n' % (d, f))
`;
/** 30 modified tracked files and 2 untracked ones. */
const touchFiles = `
from pathlib import Path
for f in range(30):
    with (Path('tree/d0') / ('f%d.txt' % f)).open('a') as out:
        out.write('changed\\n')
Path('new-a.txt').write_text('a')
Path('new-b.txt').write_text('b')
`;
// Import the same linear history in one Git process during fixture setup.
// Each commit inherits the tree from its parent, including the 10,000 files.
const commits = `
import subprocess
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
ref = git('symbolic-ref', 'HEAD')
base = git('rev-parse', 'HEAD')
stream = []
for i in range(1, 1001):
    message = 'commit %d' % i
    stream.extend(['commit ' + ref, 'committer perf <perf@example.invalid> %d +0000' % (1700000000 + i),
                   'data %d' % len(message), message])
    if i == 1:
        stream.append('from ' + base)
    stream.append('')
subprocess.run(['git', 'fast-import', '--quiet'], input='\\n'.join(stream) + '\\ndone\\n', text=True, check=True)
if git('rev-list', '--count', base + '..HEAD') != '1000' or git('rev-parse', base + '^{tree}') != git('rev-parse', 'HEAD^{tree}'):
    raise ValueError('Git fixture history or tree mismatch')
`;

const workspace = "const w = await E(powers).lookup('workspace');";

const script = harden({
  turns: [
    commandTurn('fixture', [
      [commandCall('python3', ['-c', writeFiles])],
      [commandCall('git', ['add', '-A'])],
      [commandCall('git', [...identity, 'commit', '-q', '-m', 'tree'])],
      [commandCall('python3', ['-c', commits])],
      [commandCall('python3', ['-c', touchFiles])],
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
    const r = await runTurn(
      slice,
      session,
      live,
      input,
      input === 'fixture' ? 5 * 60_000 : 120_000,
    );
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
    const failed = outcomes.find(e => e.failed);
    if (failed) throw Error(`${input} tool failed: ${failed.result}`);
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
