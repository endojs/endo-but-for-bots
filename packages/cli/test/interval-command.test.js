// @ts-check
/* global process */

// `renderIntervalList` lives in a module that transitively imports
// `@endo/eventual-send`, which relies on the SES `assert` global; initialise
// SES before importing it (mirrors list-grouping.test.js).
import '@endo/init/debug.js';
import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';
import { renderIntervalList } from '../src/commands/interval.js';

/** @import { IntervalEntry } from '@endo/daemon' */

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(dirname, '..', 'bin', 'endo.cjs');

// The `endo interval` verb is the CLI surface for the daemon's
// makeIntervalScheduler host method (endoclaw-timer design § Phase 4). These
// tests observe the command wiring purely from commander's registration —
// no live daemon — plus the pure list renderer.

test('endo --help lists the interval command in the Scheduling group', async t => {
  const { stdout } = await execa(process.execPath, [endoBin, '--help']);
  t.regex(stdout, /Scheduling Commands:/, 'a Scheduling group is advertised');
  t.regex(stdout, /\binterval\b/, 'the interval command is advertised');
});

test('endo interval --help advertises list, pause, and resume', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'interval',
    '--help',
  ]);
  t.regex(stdout, /Usage: endo interval/);
  t.regex(stdout, /list <name>/, 'list subcommand is advertised');
  t.regex(stdout, /pause <name>/, 'pause subcommand is advertised');
  t.regex(stdout, /resume <name>/, 'resume subcommand is advertised');
});

test('endo interval subcommands require a name argument', async t => {
  // commander rejects the missing required argument before any daemon
  // connection attempt, so this is deterministic offline.
  await null;
  for (const sub of ['list', 'pause', 'resume']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await execa(process.execPath, [endoBin, 'interval', sub], {
      reject: false,
    });
    t.not(result.exitCode, 0, `interval ${sub} with no name must fail`);
  }
});

test('renderIntervalList reports an empty scheduler', t => {
  t.deepEqual(renderIntervalList([]), ['No intervals.']);
});

test('renderIntervalList renders an aligned table with a header', t => {
  /** @type {IntervalEntry[]} */
  const entries = /** @type {any} */ ([
    {
      id: 'a1b2c3d4',
      label: 'heartbeat',
      periodMs: 60_000,
      firstDelayMs: 0,
      tickTimeoutMs: 30_000,
      nextTickAt: 1_741_852_860_000,
      createdAt: 1_741_852_800_000,
      tickCount: 42,
      status: 'active',
    },
    {
      id: 'e5f6a7b8',
      label: 'nightly',
      periodMs: 3_600_000,
      firstDelayMs: 0,
      tickTimeoutMs: 1_800_000,
      nextTickAt: 1_741_852_860_000,
      createdAt: 1_741_852_800_000,
      tickCount: 0,
      status: 'paused',
    },
  ]);
  const lines = renderIntervalList(entries);
  t.is(lines.length, 3, 'a header row plus one row per interval');
  t.regex(lines[0], /LABEL/, 'first line is the header');
  t.regex(lines[0], /STATUS/);
  t.true(
    lines.some(line => line.includes('heartbeat') && line.includes('60000ms')),
    `heartbeat row missing; got: ${lines.join(' | ')}`,
  );
  t.true(
    lines.some(line => line.includes('nightly') && line.includes('paused')),
    `nightly row missing; got: ${lines.join(' | ')}`,
  );
  // Every rendered row splits into the same five columns (aligned table).
  const columnCounts = lines.map(line => line.trim().split(/\s{2,}/u).length);
  t.true(
    columnCounts.every(count => count === 5),
    `every row has five columns; got: ${columnCounts.join(',')}`,
  );
});
