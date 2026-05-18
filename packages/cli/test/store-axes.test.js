// @ts-nocheck
/* global process */

import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo');

// These tests exercise the option-parser surface of the unified
// `endo store`, `endo cat`, `endo write`, and `endo read` verbs introduced
// by `designs/cli-store-verb-text-modes.md`.
// They run without a daemon — every assertion is on the help text or on
// the usage error the CLI emits before any RPC.

test('endo --help advertises store, write, and read in Storage group', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, '--help']);
  // store is the unified create-formula verb
  t.regex(stdout, /\bstore\b/);
  // write and read are the mount-path mutation pair
  t.regex(stdout, /\bwrite\b/);
  t.regex(stdout, /\bread\b/);
});

test('endo store --help lists the three axes', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'store',
    '--help',
  ]);
  // representation axis
  t.regex(stdout, /--blob/, 'should advertise --blob representation');
  t.regex(stdout, /--text/, 'should advertise --text representation');
  t.regex(stdout, /--json/, 'should advertise --json representation');
  t.regex(stdout, /--bigint/, 'should advertise --bigint representation');
  t.regex(stdout, /--tree/, 'should advertise --tree representation');
  // source axis
  t.regex(stdout, /--stdin/, 'should advertise --stdin source');
  t.regex(stdout, /--literal/, 'should advertise --literal source');
  t.regex(stdout, /-p,--path/, 'should advertise -p source');
});

test('endo cat --help lists the unified representation/sink axes', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'cat', '--help']);
  t.regex(stdout, /--blob/);
  t.regex(stdout, /--text/);
  t.regex(stdout, /--json/);
  t.regex(stdout, /--tree/);
  t.regex(stdout, /--stdout/);
  t.regex(stdout, /--show/);
  t.regex(stdout, /-p,--path/);
});

test('endo write --help advertises target argument and axes', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'write',
    '--help',
  ]);
  t.regex(stdout, /<target>/);
  t.regex(stdout, /--text/);
  t.regex(stdout, /--stdin/);
  t.regex(stdout, /--literal/);
  t.regex(stdout, /-p,--path/);
});

test('endo read --help advertises target argument and representation', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, 'read', '--help']);
  t.regex(stdout, /<target>/);
  t.regex(stdout, /--text/);
});

test('endo store with no axis flags rejects with axis-missing usage error', async t => {
  // No daemon required: the option-parser rejects before opening a connection.
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '-n', 'foo'],
    { reject: false },
  );
  t.not(result.exitCode, 0, 'should exit with non-zero status');
  // Usage error printed to stderr.
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /representation/i,
    'usage error should mention the missing representation flag',
  );
});

test('endo store --text without source rejects with source-missing usage error', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '-n', 'foo', '--text'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /source/i,
    'usage error should mention the missing source flag',
  );
});

test('endo store --tree --stdin is rejected as incoherent', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '-n', 'foo', '--tree', '--stdin'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /tree.*stdin|incoherent/i,
    'usage error should explain that --tree --stdin is incoherent',
  );
});

test('endo store --bigint with --stdin is rejected (bigint is literal-only)', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '-n', 'foo', '--bigint', '--stdin'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /bigint.*literal/i,
    'usage error should require --literal for --bigint',
  );
});

test('endo store with two representation flags is rejected', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '-n', 'foo', '--text', '--blob', '--literal', 'hi'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /representation/i,
    'usage error should reject two representation flags',
  );
});

test('endo store with two source flags is rejected', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '-n', 'foo', '--text', '--literal', 'a', '--stdin'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /source/i,
    'usage error should reject two source flags',
  );
});

test('endo store without -n <name> is rejected', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'store', '--text', '--literal', 'hi'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
});

test('endo write without target is rejected by commander', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'write', '--text', '--literal', 'hi'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
});

test('endo write with bare path (no mount segment) is rejected', async t => {
  // Single-segment targets have no <mount>/<path> shape.
  const result = await execa(
    process.execPath,
    [endoBin, 'write', 'just-one-segment', '--text', '--literal', 'hi'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /mount/i,
    'usage error should mention the required <mount-name>/<path> shape',
  );
});

test('endo read with bare path (no mount segment) is rejected', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'read', 'just-one-segment'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /mount/i,
    'usage error should mention the required <mount-name>/<path> shape',
  );
});

test('endo read --blob is rejected as not-yet-implemented', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'read', 'mount/path', '--blob'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /not yet implemented|blob/i,
  );
});

test('endo write --blob is rejected as not-yet-implemented', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'write', 'mount/path', '--blob', '--literal', 'x'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /not yet implemented|blob/i,
  );
});

test('endo cat with two representation flags is rejected', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'cat', 'name', '--text', '--blob'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /representation/i,
  );
});

test('endo cat --tree without -p <dir> is rejected', async t => {
  const result = await execa(
    process.execPath,
    [endoBin, 'cat', 'name', '--tree'],
    { reject: false },
  );
  t.not(result.exitCode, 0);
  t.regex(
    /** @type {string} */ (result.stderr) +
      /** @type {string} */ (result.stdout),
    /tree.*-p|-p.*tree|directory/i,
    'usage error should explain that --tree needs -p <dir>',
  );
});
