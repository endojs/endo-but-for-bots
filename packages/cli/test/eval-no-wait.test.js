// @ts-nocheck

import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url)).toString();
const cliBin = path.resolve(dirname, '..', 'bin');
const endoBin = path.join(cliBin, 'endo.cjs');

// Keep the unix-socket path under the platform limit (~104–108 bytes) by
// using a short directory under os.tmpdir() rather than the long worktree path.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e-nw-'));
const stateHome = path.join(testRoot, 's');
const runtimeDir = path.join(testRoot, 'r');
const cacheHome = path.join(testRoot, 'c');
fs.mkdirSync(stateHome, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(cacheHome, { recursive: true });

const endoEnv = {
  ...process.env,
  // Prefer the worktree CLI packages over the garden profile launcher.
  PATH: `${cliBin}${path.delimiter}${process.env.PATH ?? ''}`,
  HOME: testRoot,
  XDG_STATE_HOME: stateHome,
  XDG_RUNTIME_DIR: runtimeDir,
  XDG_CACHE_HOME: cacheHome,
  ENDO_SOCK: path.join(runtimeDir, 'e.sock'),
  ENDO_ADDR: '127.0.0.1:0',
};

/**
 * @param {string[]} args
 * @param {{ reject?: boolean }} [opts]
 */
const runEndo = (args, opts = {}) =>
  execa(process.execPath, [endoBin, ...args], {
    cwd: dirname,
    env: endoEnv,
    reject: opts.reject !== false,
  });

test.serial('eval --no-wait without -n errors', async t => {
  await runEndo(['purge', '-f'], { reject: false });
  await runEndo(['start']);
  try {
    const error = await t.throwsAsync(runEndo(['eval', '--no-wait', '1 + 1']));
    t.regex(
      `${error.stderr}\n${error.stdout}`,
      /result name|--name|-n|no-wait/i,
    );
  } finally {
    await runEndo(['purge', '-f'], { reject: false });
  }
});

test.serial(
  'eval --no-wait with -n prints name and locator; show reads value',
  async t => {
    await runEndo(['purge', '-f'], { reject: false });
    await runEndo(['start']);
    try {
      const result = await runEndo([
        'eval',
        '--no-wait',
        '-n',
        'slow-result',
        '21 * 2',
      ]);
      const lines = result.stdout.trim().split('\n');
      t.is(lines[0], 'slow-result');
      t.regex(lines[1], /^locator: endo:\/\//);

      const show = await runEndo(['show', 'slow-result']);
      t.regex(show.stdout, /42/);
    } finally {
      await runEndo(['purge', '-f'], { reject: false });
    }
  },
);

test.serial(
  'eval --no-wait construction failure surfaces on show',
  async t => {
    await runEndo(['purge', '-f'], { reject: false });
    await runEndo(['start']);
    try {
      await runEndo([
        'eval',
        '--no-wait',
        '-n',
        'fail-result',
        'throw new Error("cli-boom")',
      ]);
      const error = await t.throwsAsync(runEndo(['show', 'fail-result']));
      t.regex(`${error.stderr}\n${error.stdout}`, /cli-boom/);
    } finally {
      await runEndo(['purge', '-f'], { reject: false });
    }
  },
);
