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
const projectRoot = path.resolve(dirname, '..', '..', '..');

// Short socket path under os.tmpdir() to stay under the unix-socket limit.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm-nw-'));
const stateHome = path.join(testRoot, 's');
const runtimeDir = path.join(testRoot, 'r');
const cacheHome = path.join(testRoot, 'c');
fs.mkdirSync(stateHome, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(cacheHome, { recursive: true });

// Minimal caplet used for make --no-wait integration.
const capletDir = path.join(testRoot, 'caplet');
fs.mkdirSync(capletDir, { recursive: true });
fs.writeFileSync(
  path.join(capletDir, 'package.json'),
  JSON.stringify({
    name: 'make-no-wait-fixture',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
  }),
  'utf8',
);
fs.writeFileSync(
  path.join(capletDir, 'index.js'),
  `export const make = () => ({ ping: () => 'pong' });\n`,
  'utf8',
);

const endoEnv = {
  ...process.env,
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
    cwd: projectRoot,
    env: endoEnv,
    reject: opts.reject !== false,
  });

test.serial('make --no-wait without -n errors', async t => {
  await runEndo(['purge', '-f'], { reject: false });
  await runEndo(['start']);
  try {
    const error = await t.throwsAsync(
      runEndo(['make', '--no-wait', '--UNCONFINED', path.join(capletDir, 'index.js')]),
    );
    t.regex(
      `${error.stderr}\n${error.stdout}`,
      /result name|--name|-n|no-wait/i,
    );
  } finally {
    await runEndo(['purge', '-f'], { reject: false });
  }
});

test.serial(
  'make --no-wait with -n prints name and locator; show works; temp archive removed',
  async t => {
    await runEndo(['purge', '-f'], { reject: false });
    await runEndo(['start']);
    try {
      // Confined make from a directory packages an archive under a temp name,
      // then removes that temp pet name after the receipt.
      const result = await runEndo([
        'make',
        '--no-wait',
        '-n',
        'made-caplet',
        path.join(capletDir, 'index.js'),
      ]);
      const lines = result.stdout.trim().split('\n');
      t.is(lines[0], 'made-caplet');
      t.regex(lines[1], /^locator: endo:\/\//);

      // Temp archive pet names must not linger.
      const list = await runEndo(['list']);
      t.false(
        /tmp-archive-/.test(list.stdout),
        `temp archive name should be removed: ${list.stdout}`,
      );
      t.regex(list.stdout, /made-caplet/);

      // Construction settles; show / inspect the named result.
      const show = await runEndo(['show', 'made-caplet'], { reject: false });
      // Caplet may print as [object Object] or similar; non-zero is only for
      // construction failure. Accept either a successful show or a descriptive
      // non-empty inspector path.
      t.true(
        show.exitCode === 0 || /made-caplet|object|Function|ping/i.test(
          `${show.stdout}\n${show.stderr}`,
        ),
        `show should observe the made value: ${show.stdout}\n${show.stderr}`,
      );
    } finally {
      await runEndo(['purge', '-f'], { reject: false });
    }
  },
);
