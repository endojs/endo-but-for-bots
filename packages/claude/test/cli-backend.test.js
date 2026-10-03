// @ts-check
// spell-out-exempt: `argv` and `CLAUDE_CONFIG_DIR` are names in Claude Code's own config and environment.

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { makeClaudeCliBackend } from '../src/cli-backend.js';
import {
  CREDENTIAL,
  FORMULA_IDENTIFIER,
  assistant,
  line,
  makeCredentialSource,
  makeFakeSpawn,
  makeManualTimers,
  makeMemoryScratch,
  makeProjection,
  makeRequest,
  settle,
  shapeTable,
  successResult,
} from './_backend-fixtures.js';

/** @import { FakeChildScript } from './_backend-fixtures.js' */
/** @import { ShapeTable } from '@endo/inference/types.js' */

const VERSION = '2.1.268';

/**
 * @param {FakeChildScript} script
 * @param {object} [options]
 * @param {ReturnType<typeof makeCredentialSource>} [options.source]
 * @param {ShapeTable} [options.responseShapes]
 * @param {boolean} [options.permissionPromptsNone]
 * @param {ReturnType<typeof makeMemoryScratch>} [options.scratch]
 * @param {() => string | Promise<string>} [options.getVersion]
 * @param {any} [options.credentialSource]  overrides `source`
 */
const makeHarness = (script, options = {}) => {
  const {
    source = makeCredentialSource(),
    responseShapes,
    getVersion = () => VERSION,
  } = options;
  const fake = makeFakeSpawn(script);
  const scratch = options.scratch ?? makeMemoryScratch();
  const manualTimers = makeManualTimers();
  const projections = { launched: 0, closed: 0 };
  const backend = makeClaudeCliBackend({
    credentialSource: options.credentialSource ?? source.credentialSource,
    executablePath: '/opt/claude/bin/claude',
    version: VERSION,
    getVersion,
    stdioProjection: () => {
      projections.launched += 1;
      return harden({
        command: '/opt/endo/bin/guest-stdio-relay',
        commandArguments: ['--turn', 'relay-1'],
        close: () => {
          projections.closed += 1;
        },
      });
    },
    spawn: fake.spawn,
    makeScratchDirectory: scratch.makeScratchDirectory,
    kill: fake.kill,
    timers: manualTimers.timers,
    pathValue: '/opt/claude/bin',
    ...(responseShapes === undefined ? {} : { responseShapes }),
    ...(options.permissionPromptsNone ? { permissionPromptsNone: true } : {}),
  });
  return { backend, fake, scratch, source, manualTimers, projections };
};

test('describe names the vendor and the harness separately', t => {
  const { backend } = makeHarness({});
  t.deepEqual(backend.describe(), {
    provider: 'anthropic',
    kind: 'claude-cli',
    version: VERSION,
  });
});

test('a successful turn runs one confined process and reports text and usage', async t => {
  const { backend, fake, scratch, source, projections } = makeHarness({
    stdout: [
      line({ type: 'system', subtype: 'init' }),
      assistant('message-1', 'hel'),
      assistant('message-1', 'lo'),
      successResult({ result: 'hello' }),
    ],
  });
  const result = await backend.infer(makeRequest({ model: 'claude-opus-5-5' }));
  t.deepEqual(result, {
    type: 'ok',
    text: 'hello',
    usage: { inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 40 },
  });

  t.is(fake.spawns.length, 1);
  const [{ command, commandArguments: argv, options, stdin }] = fake.spawns;
  t.is(command, '/opt/claude/bin/claude');
  t.is(stdin, 'write then read', 'the prompt goes on stdin');
  t.false(argv.includes('write then read'), 'the prompt is never in argv');
  t.is(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  t.is(
    argv[argv.indexOf('--allowedTools') + 1],
    'mcp__endo__readText,mcp__endo__writeText',
  );
  t.is(argv[argv.indexOf('--max-turns') + 1], '4');
  t.is(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
  t.is(options.cwd, '/scratch/turn');
  t.true(options.detached);
  t.deepEqual(options.env, {
    PATH: '/opt/claude/bin',
    HOME: '/scratch/turn/config',
    CLAUDE_CONFIG_DIR: '/scratch/turn/config',
    TMPDIR: '/scratch/turn/config',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_AUTH_TOKEN: CREDENTIAL,
  });

  const mcpConfig = JSON.parse(
    scratch.files.get(argv[argv.indexOf('--mcp-config') + 1]) ?? '',
  );
  t.deepEqual(mcpConfig, {
    mcpServers: {
      endo: {
        type: 'stdio',
        command: '/opt/endo/bin/guest-stdio-relay',
        args: ['--turn', 'relay-1'],
      },
    },
  });
  t.is(scratch.files.get(argv[argv.indexOf('--settings') + 1]), '{}');

  const everythingTheProcessSees = JSON.stringify([
    argv,
    [...scratch.files.values()],
    stdin,
  ]);
  t.false(
    everythingTheProcessSees.includes(FORMULA_IDENTIFIER),
    'the formula identifier is a label and never reaches the provider',
  );
  t.false(
    everythingTheProcessSees.includes(CREDENTIAL),
    'the credential reaches the process only through its environment',
  );

  t.deepEqual(source.counts, { acquired: 1, released: 1 });
  t.deepEqual(scratch.state, { made: 1, removed: 1 });
  t.deepEqual(projections, { launched: 1, closed: 1 });
});

test('a refused admission maps to its tag and starts no process', async t => {
  const source = makeCredentialSource({
    refusal: { reason: 'budget-exhausted', retryAfterMs: 5000 },
  });
  const { backend, fake, scratch } = makeHarness({}, { source });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'budget-exhausted',
    retryAfterMs: 5000,
  });
  t.is(fake.spawns.length, 0);
  t.is(scratch.state.made, 0);
  t.is(source.counts.released, 0, 'a refusal holds nothing to release');
});

for (const [label, getVersion] of [
  ['an upgraded binary', () => '2.1.269'],
  ['a near-miss version', () => `${VERSION} `],
  ['a failed version read', () => Promise.reject(Error('no such file'))],
]) {
  test(`${label} fails closed before the credential is acquired`, async t => {
    const { backend, fake, scratch, source } = makeHarness(
      {},
      { getVersion: /** @type {() => Promise<string>} */ (getVersion) },
    );
    const result = await backend.infer(makeRequest());
    t.is(result.type, 'unavailable');
    t.regex(/** @type {any} */ (result).detail, /^version check failed: /);
    t.is(source.counts.acquired, 0, 'no credential is acquired');
    t.is(fake.spawns.length, 0, 'no process starts');
    t.is(scratch.state.made, 0);
  });
}

test('a malformed admission is unavailable and never leaks its values', async t => {
  const credentialSource = Far('LooseCredentialSource', {
    acquire: async () =>
      harden({
        type: 'granted',
        environment: { ANTHROPIC_AUTH_TOKEN: CREDENTIAL },
      }),
  });
  const { backend, fake } = makeHarness({}, { credentialSource });
  const result = await backend.infer(makeRequest());
  t.is(result.type, 'unavailable');
  t.false(JSON.stringify(result).includes(CREDENTIAL));
  t.is(fake.spawns.length, 0);
});

test('a credential source that rejects is unavailable and starts no process', async t => {
  const source = makeCredentialSource({ failure: Error('vault sealed') });
  const { backend, fake, scratch } = makeHarness({}, { source });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'credential source failed: acquire rejected',
  });
  t.is(fake.spawns.length, 0);
  t.is(scratch.state.made, 0);
});

test('a fractional count ceiling resolves to a tag, never a rejection', async t => {
  const { backend, fake, source } = makeHarness({});
  for (const limits of [{ maxTurns: 1.5 }, { maxOutputBytes: 0.5 }]) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await backend.infer(makeRequest({ limits })), {
      type: 'unavailable',
      detail: 'limits refused: Error',
    });
  }
  t.is(fake.spawns.length, 0);
  t.is(source.counts.acquired, 0);
});

test('output beyond the byte limit kills the process group', async t => {
  const { backend, fake, source } = makeHarness({
    stdout: [assistant('message-1', 'x'.repeat(200))],
    hang: true,
  });
  const result = await backend.infer(
    makeRequest({ limits: { maxOutputBytes: 100 } }),
  );
  t.deepEqual(result, { type: 'limit-exceeded', which: 'output-bytes' });
  t.deepEqual(
    fake.kills,
    [{ pid: -4001, signal: 'SIGKILL' }],
    'the whole process group',
  );
  t.is(source.counts.released, 1);
});

test('a turn past the turn limit is stopped by the enforcer', async t => {
  const { backend, fake } = makeHarness({
    stdout: [
      assistant('message-1', 'a'),
      assistant('message-2', 'b'),
      assistant('message-3', 'c'),
    ],
    hang: true,
  });
  const result = await backend.infer(makeRequest({ limits: { maxTurns: 2 } }));
  t.deepEqual(result, { type: 'limit-exceeded', which: 'max-turns' });
  t.is(fake.kills.length, 1);
});

test("the CLI's own turn ceiling maps to limit-exceeded", async t => {
  const { backend } = makeHarness({
    stdout: [
      line({ type: 'result', subtype: 'error_max_turns', is_error: true }),
    ],
    exitCode: 1,
  });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'limit-exceeded',
    which: 'max-turns',
  });
});

test('a hung process is ended by the wall clock', async t => {
  const { backend, fake, manualTimers, source } = makeHarness({ hang: true });
  const resultP = backend.infer(makeRequest());
  await settle();
  t.is(fake.spawns.length, 1);
  manualTimers.fire();
  t.deepEqual(await resultP, { type: 'limit-exceeded', which: 'wall-clock' });
  t.is(fake.kills.length, 1);
  t.is(source.counts.released, 1);
});

test('an exit after a killed turn returns starts no grace timer', async t => {
  const { backend, fake, manualTimers } = makeHarness({ hang: true });
  const resultP = backend.infer(makeRequest());
  await settle();
  manualTimers.fire();
  t.deepEqual(await resultP, { type: 'limit-exceeded', which: 'wall-clock' });
  fake.emitters[0]('exit', null, 'SIGKILL');
  t.is(manualTimers.pending.size, 0);
});

test('cancellation kills a running turn', async t => {
  /** @type {(reason: unknown) => void} */
  let cancel = () => {};
  const cancelled = new Promise((_, reject) => {
    cancel = reject;
  });
  const { backend, fake } = makeHarness({ hang: true });
  const resultP = backend.infer(makeRequest({ cancelled }));
  await settle();
  cancel(Error('stop'));
  t.deepEqual(await resultP, { type: 'cancelled' });
  t.is(fake.kills.length, 1);
});

test('cancellation before the spawn starts no process', async t => {
  const cancelled = Promise.reject(Error('stop'));
  cancelled.catch(() => {});
  const { backend, fake, source } = makeHarness({});
  t.deepEqual(await backend.infer(makeRequest({ cancelled })), {
    type: 'cancelled',
  });
  t.is(fake.spawns.length, 0);
  await settle();
  t.is(
    source.counts.released,
    source.counts.acquired,
    'a grant that arrives after the cancellation is released',
  );
});

test('an unpinned failure is unavailable, never needs-auth', async t => {
  const { backend } = makeHarness({
    stdout: [
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 401,
        result: 'Invalid API key · Please run /login',
      }),
    ],
    exitCode: 1,
  });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'turn ended with error_during_execution',
  });
});

test('a pinned row for the running version classifies the failure', async t => {
  const responseShapes = shapeTable({
    [VERSION]: [
      {
        pattern: M.splitRecord({ source: 'result', api_error_status: 401 }),
        result: { type: 'needs-auth' },
      },
    ],
    '2.1.999': [
      {
        pattern: M.splitRecord({ source: 'result' }),
        result: { type: 'rate-limited' },
      },
    ],
  });
  const failing = {
    stdout: [
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 401,
      }),
    ],
    exitCode: 1,
  };
  const { backend } = makeHarness(failing, { responseShapes });
  t.deepEqual(await backend.infer(makeRequest()), { type: 'needs-auth' });
});

test('a process that exits without a result is unavailable', async t => {
  const { backend } = makeHarness({ stderr: 'boom', exitCode: 3 });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'no terminal result event (exit 3)',
  });
});

test('a success result with a nonzero exit is not ok', async t => {
  const { backend } = makeHarness({ stdout: [successResult()], exitCode: 2 });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'exited 2 after a success result',
  });
});

test('malformed stream output is unavailable', async t => {
  const { backend } = makeHarness({
    stdout: ['not json\n', successResult()],
  });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'malformed stream: line 1 is not JSON',
  });
});

test('a binary that cannot spawn is unavailable', async t => {
  const { backend, source } = makeHarness({ spawnError: 'ENOENT' });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'spawn failed: ENOENT',
  });
  t.is(source.counts.released, 1);
});

test('a credential holding a NUL fails setup without reaching the detail', async t => {
  const { backend, fake, source } = makeHarness(
    {},
    {
      source: makeCredentialSource({
        environment: { ANTHROPIC_API_KEY: `${CREDENTIAL}\0x` },
      }),
    },
  );
  const result = await backend.infer(makeRequest());
  t.deepEqual(result, {
    type: 'unavailable',
    detail: 'turn setup failed: Error',
  });
  t.false(JSON.stringify(result).includes(CREDENTIAL));
  t.is(fake.spawns.length, 0);
  t.is(source.counts.released, 1);
});

test('the wall clock ends a wait for a credential that never comes', async t => {
  const { backend, fake, manualTimers } = makeHarness(
    {},
    {
      credentialSource: Far('NeverSource', {
        acquire: () => new Promise(() => {}),
      }),
    },
  );
  const resultP = backend.infer(makeRequest());
  await settle();
  manualTimers.fire();
  t.deepEqual(await resultP, { type: 'limit-exceeded', which: 'wall-clock' });
  t.is(fake.spawns.length, 0);
});

test('a grant delivering an ignored credential variable fails closed', async t => {
  const source = makeCredentialSource({
    environment: { CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL },
  });
  const { backend, fake, scratch } = makeHarness({}, { source });
  const result = await backend.infer(makeRequest());
  t.is(result.type, 'unavailable');
  t.false(JSON.stringify(result).includes(CREDENTIAL));
  t.is(fake.spawns.length, 0);
  t.deepEqual(source.counts, { acquired: 1, released: 1 });
  t.deepEqual(scratch.state, { made: 1, removed: 1 });
});

test('an inadmissible tool name refuses the turn before any spawn', async t => {
  const { guest } = makeProjection();
  const { backend, fake } = makeHarness({});
  const result = await backend.infer(
    makeRequest({ guest: harden({ ...guest, toolNames: ['evaluate'] }) }),
  );
  t.is(result.type, 'unavailable');
  t.is(fake.spawns.length, 0);
});

test('permissionPromptsNone adds the flag for CLI versions that have it', async t => {
  const { backend, fake } = makeHarness(
    { stdout: [successResult()] },
    { permissionPromptsNone: true },
  );
  await backend.infer(makeRequest());
  const [{ commandArguments: argv }] = fake.spawns;
  t.is(argv[argv.indexOf('--permission-prompts') + 1], 'none');
});

test('a request outside the seam guard is rejected by the exo', async t => {
  const { backend } = makeHarness({});
  await t.throwsAsync(() =>
    backend.infer(
      /** @type {any} */ ({ ...makeRequest(), credential: CREDENTIAL }),
    ),
  );
});

test('a multibyte character split across stdout chunks decodes intact', async t => {
  const bytes = encodeUtf8(successResult({ result: 'café' }));
  let cut = 0;
  while (bytes[cut] !== 0xc3) cut += 1;
  cut += 1;
  const { backend } = makeHarness({
    stdout: [bytes.slice(0, cut), bytes.slice(cut)],
  });
  const result = await backend.infer(makeRequest());
  t.like(result, { type: 'ok', text: 'café' });
});

test('stderr past the ring-buffer ceiling classifies on its exact tail', async t => {
  // Each 8 KiB chunk is marked by its index, so only the newest 4096 code
  // units, which lie wholly inside the last chunk, match the row; a trim that
  // dropped the newest chunks instead of the oldest would not.
  const chunks = Array.from({ length: 10 }, (_, index) =>
    String(index).repeat(8192),
  );
  const responseShapes = shapeTable({
    [VERSION]: [
      {
        pattern: M.splitRecord({ source: 'exit', stderr: '9'.repeat(4096) }),
        result: { type: 'needs-auth' },
      },
    ],
  });
  const { backend } = makeHarness(
    { stderr: chunks, exitCode: 1 },
    { responseShapes },
  );
  t.deepEqual(await backend.infer(makeRequest()), { type: 'needs-auth' });
});

test('the stderr tail never begins with half a surrogate pair', async t => {
  const responseShapes = shapeTable({
    [VERSION]: [
      {
        pattern: M.splitRecord({ source: 'exit', stderr: 'y'.repeat(4095) }),
        result: { type: 'needs-auth' },
      },
    ],
  });
  // The astral character straddles the 4096-code-unit cut.
  const { backend } = makeHarness(
    { stderr: `x\u{1F600}${'y'.repeat(4095)}`, exitCode: 1 },
    { responseShapes },
  );
  t.deepEqual(await backend.infer(makeRequest()), { type: 'needs-auth' });
});

test('a turn settles after exit when a descendant holds the pipes open', async t => {
  const { backend, fake, manualTimers } = makeHarness({
    stdout: [successResult({ result: 'hello' })],
    lingers: true,
  });
  const pending = backend.infer(makeRequest());
  await settle();
  const graceTimer = [...manualTimers.pending.values()].at(-1);
  graceTimer?.();
  t.like(await pending, { type: 'ok', text: 'hello' });
  t.is(fake.kills.length > 0, true, 'the lingering group is reaped');
});

test('a scratch cleanup failure does not replace the turn result', async t => {
  const memory = makeMemoryScratch();
  const scratch = {
    ...memory,
    makeScratchDirectory: async () => {
      const directory = await memory.makeScratchDirectory();
      return harden({
        ...directory,
        remove: async () => {
          throw Error('rm failed');
        },
      });
    },
  };
  const { backend } = makeHarness(
    { stdout: [successResult({ result: 'hello' })] },
    { scratch },
  );
  const result = await backend.infer(makeRequest());
  t.like(result, { type: 'ok', text: 'hello' });
});

test('a success with no usage fields omits usage from the result', async t => {
  const { backend } = makeHarness({
    stdout: [
      successResult({
        result: 'hi',
        usage: {},
        num_turns: undefined,
        duration_ms: undefined,
      }),
    ],
  });
  t.deepEqual(await backend.infer(makeRequest()), { type: 'ok', text: 'hi' });
});

test('a result missing subtype falls to the generic error detail', async t => {
  const { backend } = makeHarness({
    stdout: [line({ type: 'result', is_error: true })],
  });
  t.deepEqual(await backend.infer(makeRequest()), {
    type: 'unavailable',
    detail: 'turn ended with an error',
  });
});
