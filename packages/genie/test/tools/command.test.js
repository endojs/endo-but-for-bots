// @ts-check

/**
 * Tests for the `makeCommandTool` / `runProcess` error surface.
 *
 * The dev-repl and chatlog renderers surface only `err.message` when
 * a tool throws.  Before TODO/59, every non-zero exit collapsed to
 * an opaque `Command failed with exit code N` with no stderr or
 * command string, which made model-side argv mistakes look identical
 * to real spawner bugs.
 *
 * The regression these tests pin: when `bash` / `exec` reports a
 * non-zero exit, the thrown error message must contain both the exit
 * code and the captured stderr substring, and structured fields
 * (`stderr`, `stdout`, `command`, `exitCode`, `code`) must survive
 * onto the wrapped error so programmatic callers can render them.
 */

import '@endo/harden';

import process from 'node:process';

import test from 'ava';

import { makeBashTool, makeExecTool } from '../../src/tools/command.js';

const isPosix = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// bash: stderr-bearing non-zero exit
// ---------------------------------------------------------------------------

test('bash: non-zero exit surfaces stderr in the thrown error', async t => {
  if (!isPosix) {
    t.pass('skipped on non-POSIX host');
    return;
  }
  const bash = makeBashTool();
  const err = await t.throwsAsync(() =>
    bash.execute({ args: ['echo oops 1>&2; exit 7'] }),
  );
  t.truthy(err);
  // The exit code lands in the user-facing message …
  t.regex(err.message, /exit code 7/);
  // … and so does the captured stderr substring.
  t.regex(err.message, /stderr: .*oops/);
  // Structured fields survive the wrap so a programmatic caller can
  // render them without re-parsing the message.
  const cast =
    /** @type {Error & { exitCode?: number, code?: number, stderr?: string, stdout?: string, command?: string }} */ (
      err
    );
  t.is(cast.exitCode, 7);
  t.is(cast.code, 7);
  t.is(cast.stderr, 'oops');
  t.is(typeof cast.command, 'string');
});

// ---------------------------------------------------------------------------
// exec: stderr-bearing non-zero exit (non-shell path)
// ---------------------------------------------------------------------------

test('exec: non-zero exit surfaces stderr in the thrown error', async t => {
  if (!isPosix) {
    t.pass('skipped on non-POSIX host');
    return;
  }
  const exec = makeExecTool();
  const err = await t.throwsAsync(() =>
    exec.execute({ args: ['sh', '-c', 'echo nope 1>&2; exit 3'] }),
  );
  t.truthy(err);
  t.regex(err.message, /exit code 3/);
  t.regex(err.message, /stderr: .*nope/);
  const cast = /** @type {Error & { exitCode?: number, stderr?: string }} */ (
    err
  );
  t.is(cast.exitCode, 3);
  t.is(cast.stderr, 'nope');
});

// ---------------------------------------------------------------------------
// stdout fallback when stderr is empty
// ---------------------------------------------------------------------------

test('bash: stdout is surfaced when stderr is empty on failure', async t => {
  if (!isPosix) {
    t.pass('skipped on non-POSIX host');
    return;
  }
  const bash = makeBashTool();
  // Diagnostic on stdout, nothing on stderr — `npm run`-style scripts
  // routinely do this when they print "Error: …" to stdout before
  // exiting non-zero.
  const err = await t.throwsAsync(() =>
    bash.execute({ args: ['echo only-on-stdout; exit 5'] }),
  );
  t.truthy(err);
  t.regex(err.message, /exit code 5/);
  t.regex(err.message, /stdout: .*only-on-stdout/);
});

// ---------------------------------------------------------------------------
// Truncation guard
// ---------------------------------------------------------------------------

test('bash: stderr is truncated when it exceeds the budget', async t => {
  if (!isPosix) {
    t.pass('skipped on non-POSIX host');
    return;
  }
  const bash = makeBashTool();
  // Emit ~4 KiB of stderr; the wrapper budget is 2 KiB.
  const err = await t.throwsAsync(() =>
    bash.execute({
      args: ['yes oops 1>&2 2>&1 | head -c 4096 1>&2; exit 1'],
    }),
  );
  t.truthy(err);
  t.regex(err.message, /exit code 1/);
  t.regex(err.message, /truncated/);
});
