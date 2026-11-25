// @ts-check
// The project preset's hand-back (scripts/handback.js) on a seeded
// workspace: a preset carrying a project seed gives the parent and both
// children their own checkouts of it; each child commits and runs the
// hand-back exec code exactly as the instructions give it, which writes its
// bundle into the parent's checkout through the parent shell attached as
// `parent-shell`. The parent fetches both with the instructions' command,
// merges both with merge commits, and runs the seed's test on the result.
// Also: the code before any commit answers "no commits"; a second run
// resumes and writes nothing new; the fetch of a commit never handed back
// fails with its own line.
import '../unit/_m1a-prelude.js';

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'ava';
import { E } from '@endo/far';

import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentsTemplate,
  execCall,
  presetOfTemplate,
  toolCall,
  toolResultsOf,
} from './_environments.js';
import { handBackExec, handBackFetch } from '../../scripts/handback.js';

takeIntegrationLock(test, 'subagent hand-back');
const run = integrationEnabled ? test.serial : test.skip;
/** @type {Awaited<ReturnType<typeof environmentsTemplate>>} */
let template;
if (integrationEnabled) {
  test.before(async t => {
    t.timeout(5 * 60_000);
    template = await environmentsTemplate();
  });
}

// Fixed identity and dates, so the test knows each commit before the
// children make it and the parent's scripted fetch names it literally.
const gitEnv = harden({
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z',
});
const commitLine = Object.entries(gitEnv)
  .map(([k, v]) => `${k}=${v}`)
  .join(' ');
/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...gitEnv },
  }).trim();

/**
 * 54,400 bytes of 64-hex-digit lines, which compress to about half: a bundle
 * of about 42,000 base64 characters, so 17 pieces of 2,500. The child runs it
 * in its checkout and the test in its own, so the commit is the same. The
 * lines come from awk (an LCG below 2**53, exact in every awk), not from
 * sha256sum, which is not on every shell's PATH (macOS keeps it in /sbin).
 */
const makeBig =
  'awk \'BEGIN { x = 1; for (i = 0; i < 800; i++) { s = ""; for (j = 0; j < 8; j++) { x = (x * 69069 + 1) % 2147483648; s = s sprintf("%08x", x) } print s "  -" } }\' > big';

/**
 * The child's commit command: its files, then a commit with fixed dates.
 * @param {string} name
 */
const childCommit = name =>
  commandCall('sh', [
    '-c',
    name === 'a'
      ? `${makeBig} && printf a > a && git add a big && ${commitLine} git commit -qm 'child a'`
      : `printf b > b && git add b && ${commitLine} git commit -qm 'child b'`,
  ]);

/** The hand-back code as given, its answer kept on globalThis. */
const handBack = `globalThis.hb = [...(globalThis.hb ?? []), await (async () => { ${handBackExec} })()]; return globalThis.hb.at(-1);`;

run(
  'two children hand back through the parent shell; the parent fetches, merges both and tests',
  async t => {
    t.timeout(8 * 60_000);
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);

    // The published seed, as publishSource lays it out.
    const scratch = await mkdtemp(path.join(tmpdir(), 'hb-'));
    t.teardown(() => rm(scratch, { recursive: true, force: true }));
    const src = path.join(scratch, 'src');
    await mkdir(src);
    git(src, ['init', '-q', '--initial-branch=seed']);
    await writeFile(path.join(src, 'test.sh'), 'test "$(cat a b)" = ab\n');
    git(src, ['add', 'test.sh']);
    git(src, ['commit', '-qm', 'seed']);
    const seed = git(src, ['rev-parse', 'HEAD']);
    const projects = path.join(state.root, 'environments', 'projects');
    await mkdir(path.join(projects, 'thixotrope'), { recursive: true });
    const bundle = path.join(projects, 'thixotrope', `${seed}.bundle`);
    git(src, ['bundle', 'create', '-q', bundle, 'refs/heads/seed']);
    await chmod(bundle, 0o600);
    // The children's commits, made the same way here.
    git(src, ['checkout', '-q', '-b', 'a']);
    execFileSync('sh', ['-c', makeBig], { cwd: src });
    await writeFile(path.join(src, 'a'), 'a');
    git(src, ['add', 'a', 'big']);
    git(src, ['commit', '-qm', 'child a']);
    const commitA = git(src, ['rev-parse', 'HEAD']);
    git(src, ['checkout', '-q', '-b', 'b', seed]);
    await writeFile(path.join(src, 'b'), 'b');
    git(src, ['add', 'b']);
    git(src, ['commit', '-qm', 'child b']);
    const commitB = git(src, ['rev-parse', 'HEAD']);

    const parentShell = [{ name: 'parent-shell', petName: 'shell' }];
    const fetchCall = (
      /** @type {string} */ commit,
      /** @type {string} */ name,
    ) => commandCall('sh', ['-c', handBackFetch, 'sh', commit, name]);
    const merge = (/** @type {string} */ name) =>
      execCall(
        `const w = await E(powers).lookup("workspace"); return E(w).merge("${name}", { mode: "merge-commit", message: "Merge ${name}" });`,
      );
    const childTurn = (/** @type {string} */ name) =>
      commandTurn(`implement ${name}`, [
        [execCall(handBack)],
        [childCommit(name)],
        [execCall(handBack)],
        [execCall(handBack)],
        [execCall("await powers.store('hb', globalThis.hb); return true;")],
        [
          toolCall('send', {
            recipient: 'user',
            strings: [`handback ${name} `],
            edgeNames: ['hb'],
          }),
        ],
      ]);
    const script = harden({
      turns: [
        commandTurn('delegate', [
          [toolCall('spawnSubagent', { name: 'a', attachments: parentShell })],
          [toolCall('spawnSubagent', { name: 'b', attachments: parentShell })],
          [toolCall('askSubagent', { name: 'a', task: 'implement a' })],
          [toolCall('askSubagent', { name: 'b', task: 'implement b' })],
        ]),
        childTurn('a'),
        childTurn('b'),
        commandTurn('integrate', [
          [fetchCall(commitA, 'a')],
          [fetchCall(commitB, 'b')],
          [fetchCall('0'.repeat(40), 'x')],
          [merge('a')],
          [merge('b')],
          [commandCall('sh', ['test.sh'])],
        ]),
      ],
    });
    const { backend } = await slice.makeBackend(script);

    // A development preset carrying the seed (the legacy marker becomes the
    // preset's workspaceSeed on this factory).
    const operator = await E(slice.harness).getOperator();
    const catalog = await E(operator).getPresets();
    const development = await presetOfTemplate(slice.factory, 'development');
    const { objects } = await E(development).describe();
    const admin = await state.client.call('lookup', 'environmentsAdmin');
    const marker = await E(admin).makeWorkspaceSeed(
      harden({ project: 'thixotrope', commit: seed }),
    );
    const { revision } = await E(catalog).configuration();
    const { preset } = await E(catalog).create(
      harden({
        label: 'Seeded project',
        template: 'development',
        objects,
        endowments: [{ label: 'thixotrope-project-source', value: marker }],
      }),
      revision,
    );
    const baselineKeys = new Set(environmentKeys(state.root));
    const parent = await E(slice.factory).createSession(
      harden({ title: 'parent', preset, backend, at: Date.now() }),
    );
    const live = await slice.subscribe(parent);
    t.teardown(() => live.stop());

    const delegated = await runTurn(slice, parent, live, 'delegate');
    const asked = toolResultsOf(await turnRecords(delegated.turn));
    t.deepEqual(
      asked.map(r => r.failed),
      [false, false, false, false],
      JSON.stringify(asked),
    );
    const mailbox = await E(operator).getMail();
    const { messages } = await E(mailbox).list();
    /** @param {string} name */
    const handedBack = async name => {
      const row = messages.find(
        (/** @type {any} */ m) => m.body === `handback ${name} @hb`,
      );
      if (!row) return undefined;
      return JSON.parse((await E(row.message).take('hb')).json);
    };
    const answers = { a: await handedBack('a'), b: await handedBack('b') };
    t.deepEqual(
      answers,
      {
        a: ['no commits', `handed back ${commitA}`, `handed back ${commitA}`],
        b: ['no commits', `handed back ${commitB}`, `handed back ${commitB}`],
      },
      'the code answers as the instructions say; a rerun resumes',
    );
    const keys = environmentKeys(state.root).filter(k => !baselineKeys.has(k));
    t.is(keys.length, 3, 'the parent and two children, each its own checkout');

    const integrated = await runTurn(slice, parent, live, 'integrate');
    const results = toolResultsOf(await turnRecords(integrated.turn));
    t.deepEqual(
      results.map(r => r.failed),
      [false, false, false, false, false, false],
      JSON.stringify(results),
    );
    const text = results.map(r => String(r.result));
    t.regex(text[0], /child a/u, text[0]);
    t.regex(text[1], /child b/u, text[1]);
    t.regex(text[2], /no hand-back of 0{40}/u, text[2]);
    t.regex(text[2], /"exitCode":\s*1/u, text[2]);
    t.regex(text[5], /"exitCode":\s*0/u, text[5]);

    // The parent's checkout: both merged with merge commits on the seed.
    const parentKey = keys.find(key =>
      git(path.join(state.root, 'environments', 'sessions', key, 'workspace'), [
        'branch',
        '--list',
        'a',
      ]),
    );
    t.truthy(parentKey);
    const parentDir = path.join(
      state.root,
      'environments',
      'sessions',
      /** @type {string} */ (parentKey),
      'workspace',
    );
    t.deepEqual(
      git(parentDir, ['log', '--format=%s', '--first-parent']).split('\n'),
      ['Merge b', 'Merge a', 'seed'],
    );
    t.is(git(parentDir, ['rev-parse', 'HEAD^2']), commitB);
    t.is(git(parentDir, ['rev-parse', 'HEAD^^2']), commitA);
    t.is(git(parentDir, ['status', '--porcelain']), '');
  },
);
