// @ts-check
/**
 * Environments acceptance on the turn path and the exec path
 * (`designs/m6-interfaces.md` section 9: 2, 3 (the staged 10 MiB case), 5
 * (exec path), 7, 10, 15, 16, 18, 21 (through the manager)), in a real daemon on the `environments`
 * template with the fake runtime. One `development` session runs scripted
 * turns:
 *
 * - 2: `runCommand(git ...)` and `E(workspace)` see each other's commits;
 * - 5: no facet answers a method of `gitAbsentMethodNames`, the reader
 *   refuses a write (`gitReadOnly` in the adapter, the guard first), and
 *   `trackingStatus` has no upstream;
 * - 3, 15, 18: a non-zero exit is data, a command off the allowlist is
 *   refused and runs nothing, `inspectShell` answers its three fields and
 *   no host path, `sh -c env` lists only A.3's variables, 10 MiB of stdout
 *   is a staged result that parses as JSON of at most 32,768 units;
 * - 16: `readSources` reads a committed file of the workspace; `..` is
 *   refused;
 * - 21: exec code opens `img/a.png`, reads it in 12,288-byte pages and
 *   gets the file back; a directory and `.git` are refused;
 * - 7: one `exec`, one `runCommand` (`sleep 1`) and one `echo` (1,000 ms)
 *   in one round run at once and record their results in call order;
 * - 10: cancel during `sleep 600` ends the turn `cancelled` within 1 s and
 *   the process is gone; the next command runs.
 *
 *   THIX_AGENT=W6.7 corepack yarn test:integration test/integration/environments-shell.test.js
 */
import '../unit/_m1a-prelude.js';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import {
  environmentTexts,
  gitAbsentMethodNames,
} from '../../guest/lib/guards/environments.js';
import { texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import { fakeCommandEnv } from '../../resources/environments/impl/runtime-fake.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, waitFor } from './_m1a-slice.js';
import { readField, runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentProcesses,
  environmentsTemplate,
  execCall,
  startEnvironmentSession,
  toolCall,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'environments shell test');

const run = integrationEnabled ? test.serial : test.skip;

/** A git commit in the fake runtime: no identity in the scrubbed env. */
const gitCommit = (/** @type {string[]} */ ...rest) =>
  commandCall('git', [
    '-c',
    'user.name=shell',
    '-c',
    'user.email=shell@example.invalid',
    'commit',
    ...rest,
  ]);

const workspaceOf = "const w = await E(powers).lookup('workspace');";

const IMAGE_BYTES = 20_000;
/** `runCommand` arguments with 20,000 fresh keys in `options` (section 11). */
const flooded = `{"command":"true","args":[],"options":{${Array.from(
  { length: 20_000 },
  (_, i) => `"k${i}":0`,
).join(',')}}}`;

const script = harden({
  turns: [
    commandTurn('repo', [
      [commandCall('git', ['status', '--porcelain'])],
      [gitCommit('--allow-empty', '-m', 'from-shell')],
      [commandCall('sh', ['-c', 'printf hello > a.txt'])],
      [
        execCall(
          `${workspaceOf} await E(w).add(['a.txt']); await E(w).commit('from-exec'); const log = await E(w).log(); return JSON.stringify(log.commits.map(e => e.subject));`,
        ),
      ],
      [commandCall('git', ['log', '--format=%s'])],
    ]),
    commandTurn('surface', [
      [
        execCall(
          `${workspaceOf} const absent = ${JSON.stringify(
            gitAbsentMethodNames,
          )}; const out = { absent: [] }; for (const name of absent) { try { await E(w)[name](); out.absent.push(name + ':answered'); } catch (e) { /* refused */ } } const r = await E(w).readOnly(); try { await E(r).commit('x'); out.reader = 'committed'; } catch (e) { out.reader = e.message; } out.tracking = await E(w).trackingStatus(); return JSON.stringify(out);`,
        ),
      ],
    ]),
    commandTurn('contract', [
      [toolCall('inspectShell', {})],
      [commandCall('sh', ['-c', 'env'])],
      [commandCall('sh', ['-c', 'echo out; echo err >&2; exit 3'])],
      [commandCall('ls', ['/'])],
      [commandCall('sh', ['-c', "head -c 10485760 /dev/zero | tr '\\0' a"])],
    ]),
    commandTurn('sources', [
      [
        toolCall('readSources', {
          petName: 'workspace',
          items: [{ path: ['a.txt'] }],
        }),
      ],
      [
        toolCall('readSources', {
          petName: 'workspace',
          items: [{ path: ['..', 'x'] }],
        }),
      ],
    ]),
    commandTurn('image', [
      [
        commandCall('sh', [
          '-c',
          `mkdir -p img && head -c ${IMAGE_BYTES} /dev/urandom > img/a.png`,
        ]),
      ],
      [
        execCall(
          `${workspaceOf} const s = await E(w).openImage(['img', 'a.png']); const size = await E(s).size(); const pages = []; let offset = 0; for (;;) { const p = await E(s).readBase64({ offset, maxBytes: 12288 }); pages.push(p.data); offset += 12288; if (p.done || offset >= size) break; } const refused = []; for (const bad of [['img'], ['.git', 'config']]) { try { await E(w).openImage(bad); refused.push('opened'); } catch (e) { refused.push(e.message); } } return JSON.stringify({ size, pages: pages.length, data: pages.join('|'), refused });`,
        ),
      ],
    ]),
    commandTurn('one call', [[toolCall('echo', { text: 'x', delayMs: 1000 })]]),
    commandTurn('concurrent', [
      [
        execCall('await sleep(1000); return 1;'),
        commandCall('sleep', ['1']),
        toolCall('echo', { text: 'e', delayMs: 1000 }),
      ],
    ]),
    commandTurn('round limit', [
      Array.from({ length: limits.maxCallsPerRound + 1 }, () =>
        commandCall('true'),
      ),
    ]),
    commandTurn('cancel', [[commandCall('sleep', ['600'])]]),
    commandTurn('after cancel', [[commandCall('printf', ['again'])]]),
  ],
});

/**
 * The value an exec result carries: the returned string parsed as JSON.
 * @param {any} result
 */
const execValue = result => {
  let value = result;
  for (let i = 0; i < 3 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

run('environments on the turn and exec paths', async t => {
  t.timeout(5 * 60_000);
  const t0 = performance.now();
  const template = await environmentsTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const identity = { ...(await runIdentity()), loadAvg: loadAvg() };
  const content = await E(slice.admin).content();
  const { backend } = await slice.makeBackend(script);
  const session = await startEnvironmentSession(slice, backend);
  const live = await slice.subscribe(session);
  t.teardown(() => live.stop());
  /** @param {string} input */
  const turn = async input => {
    const ran = await runTurn(slice, session, live, input);
    const results = toolResultsOf(await turnRecords(ran.turn));
    t.log(input, ran.end.status, JSON.stringify(results).slice(0, 1500));
    return { ...ran, results };
  };

  // 2: one repository.
  const repo = await turn('repo');
  t.is(repo.end.status, 'completed', 'the repo turn completes');
  const [status, , , exec, gitLog] = repo.results.map(r => r.result);
  t.deepEqual(JSON.parse(status).exitCode, 0, 'git status runs');
  const subjects = execValue(exec);
  t.true(
    Array.isArray(subjects) && subjects.includes('from-shell'),
    'E(workspace).log() sees the commit runCommand(git commit) made',
  );
  t.true(
    JSON.parse(gitLog).stdout.includes('from-exec'),
    'runCommand(git log) sees the commit E(workspace).commit() made',
  );
  t.true(
    JSON.parse(gitLog).stdout.includes('Initialize workspace'),
    'the workspace starts with its empty initial commit',
  );

  // 5: the git surface from exec code.
  const surface = await turn('surface');
  const shown = execValue(surface.results[0].result);
  t.deepEqual(shown.absent, [], 'no facet answers an absent method');
  t.true(
    typeof shown.reader === 'string' && shown.reader !== 'committed',
    `the reader refuses a write (${shown.reader})`,
  );
  t.is(shown.tracking.upstream, null, 'trackingStatus reports no upstream');

  // 3, 15, 18: the command contract.
  const contract = await turn('contract');
  const [inspect, env, failing, refused, big] = contract.results;
  const info = JSON.parse(inspect.result);
  t.deepEqual(
    Object.keys(info).sort(),
    ['allowedCommands', 'maxOutputBytes', 'timeoutMs'],
    'inspectShell answers its three fields',
  );
  t.false(inspect.result.includes(state.root), 'no host path in inspect');
  const names = JSON.parse(env.result)
    .stdout.split('\n')
    .filter(line => line.includes('='))
    .map(line => line.slice(0, line.indexOf('=')))
    .sort();
  // A.3's six variables, plus the three `sh` itself sets (PWD, SHLVL, _).
  // The fake runtime runs on the host, so the values name host paths; a
  // container names /workspace and /home/node ([real-runtime]).
  const allowed = [
    ...Object.keys(fakeCommandEnv('/home/node')),
    'PWD',
    'SHLVL',
    '_',
  ];
  const extra = names.filter(name => !allowed.includes(name));
  t.deepEqual(extra, [], `sh -c env lists only A.3's variables (${names})`);
  const exit = JSON.parse(failing.result);
  t.deepEqual(
    [exit.exitCode, exit.stdout, exit.stderr, failing.failed],
    [3, 'out\n', 'err\n', false],
    'a non-zero exit is data',
  );
  t.true(refused.failed, 'a command off the allowlist is refused');
  t.true(
    String(refused.result).includes('ls'),
    `the refusal names the command (${refused.result})`,
  );
  const bigText = await readField(content, big.result);
  t.true(typeof big.result === 'object', 'the 10 MiB result is staged');
  t.true(bigText.length <= 32_768, `at most 32,768 units (${bigText.length})`);
  const bigResult = JSON.parse(bigText);
  t.true(bigResult.truncated, 'the 10 MiB result is truncated');

  // 16: readSources over the workspace.
  const sources = await turn('sources');
  t.true(
    String(sources.results[0].result).includes('hello'),
    'readSources reads a committed file',
  );
  t.false(
    JSON.parse(sources.results[1].result).results[0].ok,
    'a path with .. is refused',
  );

  // 21: workspace images through the manager.
  const image = await turn('image');
  const read = execValue(await readField(content, image.results[1].result));
  const [key] = environmentKeys(state.root);
  const file = readFileSync(
    path.join(
      state.root,
      'environments',
      'sessions',
      key,
      'workspace',
      'img',
      'a.png',
    ),
  );
  t.is(read.size, IMAGE_BYTES, 'size() is the file size');
  t.is(
    read.pages,
    Math.ceil(IMAGE_BYTES / 12_288),
    'read in 12,288-byte pages',
  );
  t.is(
    Buffer.concat(
      read.data
        .split('|')
        .map((/** @type {string} */ page) => Buffer.from(page, 'base64')),
    ).compare(file),
    0,
    'the pages reassemble the file',
  );
  t.deepEqual(
    read.refused,
    [environmentTexts.gitPathRefused, environmentTexts.gitPathRefused],
    'a directory and .git are refused',
  );

  // 7: concurrency.
  let t1 = performance.now();
  await turn('one call');
  const oneMs = performance.now() - t1;
  t1 = performance.now();
  const concurrent = await turn('concurrent');
  const bothMs = performance.now() - t1;
  t.is(concurrent.end.status, 'completed', 'the concurrent round completes');
  t.deepEqual(
    concurrent.results.map(r => r.failed),
    [false, false, false],
    'three results',
  );
  t.is(execValue(concurrent.results[0].result), 1, 'exec first');
  t.is(JSON.parse(concurrent.results[1].result).exitCode, 0, 'sleep second');
  t.is(concurrent.results[2].result, 'e', 'echo third');

  const limited = await turn('round limit');
  t.is(limited.results.filter(r => !r.failed).length, limits.maxCallsPerRound);
  t.is(limited.results.filter(r => r.failed).length, 1);

  // 10: cancel stops the environment.
  const from = live.deliveries.length;
  const receipt = await slice.submit(session, 'cancel');
  await waitFor(
    () => environmentProcesses(state.root).length > 0,
    30_000,
    'sleep 600 running',
  );
  const tCancel = performance.now();
  await E(receipt.turn).cancel();
  await live.until(
    event => event.type === 'end' || event.type === 'abort',
    30_000,
    from,
  );
  const cancelMs = performance.now() - tCancel;
  const { state: cancelled } = await E(receipt.turn).getStatus();
  t.is(cancelled, 'cancelled', 'the turn ends cancelled');
  t.true(cancelMs < 1000, `within 1 s (${round1(cancelMs)} ms)`);
  await waitFor(
    () => environmentProcesses(state.root).length === 0,
    5000,
    'the sleep gone',
  );
  const cancelRecords = toolResultsOf(await turnRecords(receipt.turn));
  t.true(
    cancelRecords.every(r => r.failed) &&
      cancelRecords.some(r => String(r.result).includes(texts.commandStopped)),
    `the command records commandStopped (${JSON.stringify(cancelRecords)})`,
  );
  const after = await turn('after cancel');
  t.is(
    JSON.parse(after.results[0].result).stdout,
    'again',
    'next command runs',
  );

  emit({
    metric: 'environments.shell.acceptance',
    oneCallMs: round1(oneMs),
    concurrentMs: round1(bothMs),
    ratio: +(bothMs / oneMs).toFixed(2),
    cancelMs: round1(cancelMs),
    wallMs: round1(performance.now() - t0),
    ...identity,
  });
  t.true(
    bothMs < 1.6 * oneMs,
    `the round runs its three calls at once (${round1(bothMs)} ms against ${round1(oneMs)} ms)`,
  );
});

run(
  'oversized scripted backend input is refused at the control boundary',
  async t => {
    const state = await startFromTemplate(await environmentsTemplate(), { t });
    const slice = await makeSlice(state);
    const oversized = harden({
      turns: [commandTurn('oversized', [[toolCall('runCommand', flooded)]])],
    });
    await t.throwsAsync(() => slice.makeBackend(oversized), {
      message: /exceeds the inbound frame ceiling/,
    });
  },
);

// These guest-facing probes in the checkpoint were behind a script that the
// control boundary rejected. Adapter-level validation is independently covered.
test.todo(
  'section 11: a guest sees short closed-argument refusals for a 20,000-key options record',
);
test.todo(
  'section 11: invalid branch names are refused through the guest Git facet',
);
test.todo(
  'section 11: the exec vat remains available after an image answer larger than its frame ceiling',
);
