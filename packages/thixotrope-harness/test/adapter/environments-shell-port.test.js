// @ts-check
// The environments adapter's ShellPort (resources/environments/impl/
// shell-port.js, command-args.js, blob-access.js; designs/m6-interfaces.md
// D-M6-4, D-M6-6, 3.6, 5.5, section 11): model-JSON parsing with Fae's
// texts, staged arguments read through the agent host's real Content,
// large results staged through its real BlobWriters, refusals as failed
// outcomes, a withdrawn key refused. Node adapter test; the runner is a
// recording stand-in for runner.js (a plain adapter object, not a
// remotable).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentLimits,
  environmentTexts,
  environmentTextOf,
} from '../../guest/lib/guards/environments.js';
import { interfaces, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { makeContent } from '../../resources/agent-host/impl/content.js';
import {
  argsReadBytes,
  makeShellPort,
} from '../../resources/environments/impl/shell-port.js';
import {
  parseCommandArgs,
  parseInspectArgs,
} from '../../resources/environments/impl/command-args.js';
import {
  readStaged,
  stageText,
} from '../../resources/environments/impl/blob-access.js';
import { makeTestBlobs } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const encoder = new TextEncoder();
const allowed = harden(['sh', 'git', 'printf', 'sleep', 'true']);
const shellInfo = harden({
  allowedCommands: allowed,
  timeoutMs: environmentLimits.defaultCommandTimeoutMs,
  maxOutputBytes: environmentLimits.streamBytes,
});

/**
 * A RawResult (contract 5.3).
 * @param {string} stdout
 * @param {Record<string, unknown>} [rest]
 */
const raw = (stdout, rest = {}) => {
  const bytes = encoder.encode(stdout);
  const cut = bytes.length > environmentLimits.streamBytes;
  return {
    stdout: cut ? bytes.subarray(0, environmentLimits.streamBytes) : bytes,
    stderr: new Uint8Array(0),
    stdoutCut: cut,
    stderrCut: false,
    exitCode: 0,
    signal: null,
    timedOut: false,
    ms: 2,
    ...rest,
  };
};

/**
 * A stand-in runner that records its calls and answers as told.
 * @param {(argv: string[], options: { timeoutMs: number }) => any} [answer]
 */
const makeRunner = (answer = () => raw('ok\n')) => {
  /** @type {{ key: string, argv: string[], options: { timeoutMs: number } }[]} */
  const calls = [];
  const runner = {
    /**
     * @param {string} key
     * @param {string[]} argv
     * @param {{ timeoutMs: number }} options
     */
    exec: async (key, argv, options) => {
      calls.push({ key, argv, options });
      return answer(argv, options);
    },
    inspect: async () => shellInfo,
  };
  return { runner, calls };
};

/**
 * A port over a stand-in runner, with the agent host's real blob store
 * behind its writers and content.
 * @param {any} t
 * @param {object} [options]
 * @param {(argv: string[], options: { timeoutMs: number }) => any} [options.answer]
 * @param {(key: string) => boolean} [options.isWithdrawn]
 * @param {number} [options.defaultTimeoutMs]
 */
const setup = (t, { answer, isWithdrawn, defaultTimeoutMs } = {}) => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const { runner, calls } = makeRunner(answer);
  const port = makeShellPort({
    key: 'e1',
    runner,
    settings: harden({
      allowedCommands: allowed,
      ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
    }),
    ...(isWithdrawn === undefined ? {} : { isWithdrawn }),
    redact: text => text.split(blobs.root).join('/workspace'),
  });
  const content = makeContent({ store: blobs.store });
  const { writers } = blobs.store;
  let serial = 0;
  /**
   * @param {any} args
   * @param {'runCommand' | 'inspect'} [method]
   */
  const call = (args, method = 'runCommand') => {
    serial += 1;
    return E(port)[method](
      harden({ opId: `op${serial}`, args, writers, content }),
    );
  };
  return { port, calls, call, blobs, content, writers };
};

/** @param {Record<string, unknown>} value */
const json = value => JSON.stringify(value);

test('a command runs with its argv and the default timeout; the result is the A.3 JSON inline', async t => {
  const { call, calls } = setup(t);
  const outcome = await call(json({ command: 'printf', args: ['%s', 'hi'] }));
  t.is(outcome.status, 'ok');
  t.deepEqual(JSON.parse(outcome.text), {
    stdout: 'ok\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: false,
  });
  t.deepEqual(calls, [
    {
      key: 'e1',
      argv: ['printf', '%s', 'hi'],
      options: { timeoutMs: environmentLimits.defaultCommandTimeoutMs },
    },
  ]);
});

test('the settings default timeout and a per-call timeout apply', async t => {
  const { call, calls } = setup(t, { defaultTimeoutMs: 5000 });
  await call(json({ command: 'true', args: [] }));
  await call(json({ command: 'true', args: [], options: { timeoutMs: 700 } }));
  t.deepEqual(
    calls.map(c => c.options.timeoutMs),
    [5000, 700],
  );
});

test('a non-zero exit is data', async t => {
  const { call } = setup(t, {
    answer: () => raw('', { exitCode: 2, signal: null }),
  });
  const outcome = await call(json({ command: 'sh', args: ['-c', 'exit 2'] }));
  t.is(outcome.status, 'ok');
  t.is(JSON.parse(outcome.text).exitCode, 2);
});

test('a command not on the allowlist is refused by name; nothing runs', async t => {
  const { call, calls } = setup(t);
  await null;
  for (const command of ['/bin/sh', '../sh', 'sh;rm', '', 'bash']) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await call(json({ command, args: [] }));
    t.deepEqual(outcome, {
      status: 'failed',
      text: environmentTextOf.notAllowed(command),
    });
  }
  t.is(calls.length, 0);
});

test('arguments that are not JSON, not an object or with unknown keys are refused with Fae texts', async t => {
  const { call, calls } = setup(t);
  const notJson = await call('{"command": ');
  t.is(notJson.status, 'failed');
  t.true(notJson.text.startsWith('could not parse tool arguments as JSON ('));
  t.deepEqual(await call('[1]'), {
    status: 'failed',
    text: textOf.argumentsNotJson('the arguments must be a JSON object'),
  });
  t.deepEqual(await call(json({ command: 'true', args: [], stdin: 'x' })), {
    status: 'failed',
    text: textOf.unexpectedArgument('stdin', 'runCommand', [
      'command',
      'args',
      'options',
    ]),
  });
  t.deepEqual(await call(json({ command: 'true' })), {
    status: 'failed',
    text: textOf.argumentsNotJson('argument "args" is required'),
  });
  t.deepEqual(await call(''), {
    status: 'failed',
    text: textOf.argumentsNotJson('argument "command" is required'),
  });
  t.deepEqual(await call(json({ command: 'true', args: 'a b' })), {
    status: 'failed',
    text: textOf.invalidArgument('args', 'runCommand', 'an array of strings'),
  });
  t.deepEqual(await call(json({ command: 7, args: [] })), {
    status: 'failed',
    text: textOf.invalidArgument('command', 'runCommand', 'a string'),
  });
  t.is(calls.length, 0);
});

test('20,000 fresh keys in options are refused by name in the adapter', async t => {
  /** @type {Record<string, number>} */
  const options = {};
  for (let i = 0; i < 20_000; i += 1) options[`k${i}`] = i;
  const text = json({ command: 'true', args: [], options });
  // Over inlineBytes: the session stages it; the port reads it back.
  const { call, calls, blobs } = setup(t);
  const staged = await blobs.store.stage(text);
  const outcome = await call(staged);
  t.deepEqual(outcome, {
    status: 'failed',
    text: textOf.unexpectedArgument('k0', 'runCommand options', ['timeoutMs']),
  });
  t.is(calls.length, 0);
});

test('timeoutMs that is not a positive timer-range integer is refused', async t => {
  const { call, calls } = setup(t);
  await null;
  for (const timeoutMs of [-1, 0, 1.5, 2 ** 31, '10', null]) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await call(
      json({ command: 'sleep', args: ['1'], options: { timeoutMs } }),
    );
    t.deepEqual(outcome, {
      status: 'failed',
      text: environmentTexts.timeoutInvalid,
    });
  }
  t.is(calls.length, 0);
});

test('too many, too large or NUL-carrying arguments are refused; nothing runs', async t => {
  const { call, calls, blobs } = setup(t);
  const many = json({ command: 'printf', args: Array(2000).fill('a') });
  const manyOutcome = await call(await blobs.store.stage(many));
  t.deepEqual(manyOutcome, {
    status: 'failed',
    text: textOf.invalidArgument(
      'args',
      'runCommand',
      `an array of at most ${environmentLimits.maxCommandArgs} strings`,
    ),
  });
  // One argument of 1 MiB: refused by its staged size, unread.
  const huge = json({ command: 'printf', args: ['x'.repeat(1024 * 1024)] });
  const hugeStaged = await blobs.store.stage(huge);
  t.true(hugeStaged.bytes > argsReadBytes);
  t.deepEqual(await call(hugeStaged), {
    status: 'failed',
    text: environmentTextOf.argsTooLarge(
      hugeStaged.bytes,
      environmentLimits.commandArgsBytes,
    ),
  });
  // Arguments totalling 300 KB: read, parsed, then refused by their bytes.
  const total = json({
    command: 'printf',
    args: Array(100).fill('y'.repeat(3000)),
  });
  t.deepEqual(await call(await blobs.store.stage(total)), {
    status: 'failed',
    text: environmentTextOf.argsTooLarge(
      300_000,
      environmentLimits.commandArgsBytes,
    ),
  });
  const nul = await call(json({ command: 'printf', args: ['a\u0000b'] }));
  t.is(nul.status, 'failed');
  t.true(nul.text.startsWith('Invalid argument "args" for runCommand'));
  t.is(calls.length, 0);
});

test('staged arguments are read through Content, across pages and characters of every width', async t => {
  const { call, calls, blobs } = setup(t);
  const arg = 'é€😀a'.repeat(5000); // 50 KB: three pages
  const staged = await blobs.store.stage(
    json({ command: 'printf', args: ['%s', arg] }),
  );
  t.true(staged.bytes > limits.blobPageBytes * 2);
  const outcome = await call(staged);
  t.is(outcome.status, 'ok');
  t.deepEqual(calls[0].argv, ['printf', '%s', arg]);
});

test('staged arguments without a Content are refused', async t => {
  const { port, blobs, writers, calls } = setup(t);
  const staged = await blobs.store.stage(json({ command: 'true', args: [] }));
  const outcome = await E(port).runCommand(
    harden({ opId: 'op', args: staged, writers }),
  );
  t.is(outcome.status, 'failed');
  t.is(
    outcome.text,
    textOf.stagingFailed(
      'the arguments were staged but no content reader was passed',
    ),
  );
  t.is(calls.length, 0);
});

test('a large result is staged through the BlobWriters: valid JSON within toolOutputUnits', async t => {
  const { call, blobs } = setup(t, {
    answer: () => raw('😀'.repeat(40_000)),
  });
  const outcome = await call(json({ command: 'sh', args: ['-c', 'yes'] }));
  t.is(outcome.status, 'ok');
  t.is(typeof outcome.text, 'object');
  const text = await blobs.store.read(outcome.text.blob);
  t.is(outcome.text.bytes, encoder.encode(text).length);
  t.true(text.length <= limits.toolOutputUnits);
  const parsed = JSON.parse(text);
  t.true(parsed.truncated);
  t.true(parsed.stdout.endsWith(textOf.truncationMarker(32_768)));
});

test('a staging failure answers stagingFailed', async t => {
  const { port, content } = setup(t, { answer: () => raw('w'.repeat(20_000)) });
  const writers = makeExo('BlobWriters', interfaces.BlobWriters, {
    open: async () => {
      throw Error('disk full');
    },
  });
  const outcome = await E(port).runCommand(
    harden({
      opId: 'op',
      args: json({ command: 'true', args: [] }),
      writers,
      content,
    }),
  );
  t.deepEqual(outcome, {
    status: 'failed',
    text: textOf.stagingFailed('disk full'),
  });
});

test('a timeout fails with the exo-shell text; the partial output is dropped', async t => {
  const { call } = setup(t, {
    answer: (_argv, { timeoutMs }) =>
      raw('partial', {
        timedOut: true,
        exitCode: null,
        signal: 'SIGKILL',
        ms: timeoutMs,
      }),
  });
  const outcome = await call(
    json({ command: 'sleep', args: ['30'], options: { timeoutMs: 500 } }),
  );
  t.deepEqual(outcome, {
    status: 'failed',
    text: environmentTextOf.timedOut(500),
  });
});

test('a runtime failure is a bounded reason without the state path; a fixed text passes through', async t => {
  let message = '';
  const { call, blobs } = setup(t, {
    answer: () => {
      throw Error(message);
    },
  });
  message = `spawn failed in ${blobs.root}/environments/sessions/e1 ${'x'.repeat(5000)}`;
  const failed = await call(json({ command: 'true', args: [] }));
  t.is(failed.status, 'failed');
  t.false(failed.text.includes(blobs.root));
  t.true(
    failed.text.startsWith(
      environmentTextOf.runtimeFailed('spawn failed in /workspace'),
    ),
  );
  t.true(String(failed.text).length < 1200);
  message = environmentTexts.imageRefused;
  t.deepEqual(await call(json({ command: 'true', args: [] })), {
    status: 'failed',
    text: environmentTexts.imageRefused,
  });
});

test('a withdrawn key is refused before the command and after it', async t => {
  let withdrawn = true;
  /** @type {(() => void) | undefined} */
  let during;
  const { call, calls } = setup(t, {
    isWithdrawn: () => withdrawn,
    answer: () => {
      during?.();
      return raw('done');
    },
  });
  const stopped = { status: 'failed', text: environmentTexts.stopped };
  await null;
  t.deepEqual(await call(json({ command: 'true', args: [] })), stopped);
  t.deepEqual(await call(json({}), 'inspect'), stopped);
  t.is(calls.length, 0);
  withdrawn = false;
  during = () => {
    withdrawn = true;
  };
  t.deepEqual(await call(json({ command: 'true', args: [] })), stopped);
  t.is(calls.length, 1);
});

test('inspect answers the ShellInfo JSON; it takes no arguments', async t => {
  const { call } = setup(t);
  const outcome = await call('', 'inspect');
  t.is(outcome.status, 'ok');
  t.deepEqual(JSON.parse(outcome.text), shellInfo);
  t.deepEqual(await call(json({ path: '/' }), 'inspect'), {
    status: 'failed',
    text: textOf.unexpectedArgument('path', 'inspectShell', []),
  });
});

test('the port guard refuses a request with an unknown key', async t => {
  const { port, writers } = setup(t);
  await t.throwsAsync(() =>
    E(port).runCommand(
      /** @type {any} */ (
        harden({ opId: 'op', args: '{}', writers, extra: 1 })
      ),
    ),
  );
});

test('parsers: the command parser keeps the argv; the inspect parser takes blank text', t => {
  t.deepEqual(
    parseCommandArgs(json({ command: 'git', args: ['status'] }), allowed),
    { ok: true, command: 'git', args: ['status'] },
  );
  t.deepEqual(
    parseCommandArgs(json({ command: 'git', args: [], options: {} }), allowed),
    { ok: true, command: 'git', args: [] },
  );
  t.deepEqual(parseInspectArgs('  '), { ok: true });
  t.deepEqual(parseInspectArgs('{}'), { ok: true });
});

test('blob access: stageText writes pieces of at most blobPieceBytes; readStaged reads them back and bounds the size', async t => {
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  /** @type {number[]} */
  const pieces = [];
  const real = blobs.store.writers;
  // A recording BlobWriters over the real one, built from the real guards.
  const writers = makeExo('BlobWriters', interfaces.BlobWriters, {
    open: async () => {
      const writer = await E(real).open();
      return makeExo('BlobWriter', interfaces.BlobWriter, {
        /** @param {string} piece */
        append: piece => {
          pieces.push(encoder.encode(piece).length);
          return E(writer).append(piece);
        },
        close: () => E(writer).close(),
        abort: () => E.sendOnly(writer).abort(),
      });
    },
  });
  const text = '漢😀b'.repeat(9000); // 72,000 bytes
  const staged = await stageText(text, writers);
  t.is(staged.bytes, encoder.encode(text).length);
  t.true(pieces.length >= Math.ceil(staged.bytes / limits.blobPieceBytes));
  t.true(pieces.every(bytes => bytes <= limits.blobPieceBytes));
  const content = makeContent({ store: blobs.store });
  t.is(await readStaged(staged, content, 100_000), text);
  await t.throwsAsync(() => readStaged(staged, content, 50_000), {
    message: /staged text too large/,
  });
});
