// @ts-check
// The adapter's one atomic write (`impl/files.js`, HR-SYN-26): a SIGKILL at
// every step leaves the old file or the new one, never neither and never a
// mix; the scratch file a kill leaves is the only other thing in the
// directory. The archive's segment writes (m2-archive-kill) and the store's
// writers run over the same helper.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../../resources/agent-host/impl/files.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHILD = fileURLToPath(
  new URL('./_atomic-write-kill-child.mjs', import.meta.url),
);

/**
 * @param {string} path
 * @param {string} killAt
 * @param {string} text
 * @param {string} [scratch]
 */
const runChild = async (path, killAt, text, scratch) => {
  const child = spawn(
    execPath,
    [CHILD, path, killAt, text, ...(scratch === undefined ? [] : [scratch])],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let err = '';
  child.stderr.on('data', chunk => {
    err += chunk;
  });
  const [code, signal] = await once(child, 'exit');
  return { code, signal, err };
};

/** What a kill at each step leaves: the file's text and the scratch file. */
const EXPECTED = harden({
  write: { text: 'old', scratch: true },
  fsync: { text: 'old', scratch: true },
  rename: { text: 'old', scratch: true },
  'fsync-dir': { text: 'new', scratch: false },
  after: { text: 'new', scratch: false },
});

test('SIGKILL at every step of writeFileAtomic leaves the old or the new file', async t => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'atomic-kill-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  for (const [scratch, suffix] of [
    [undefined, '.tmp'],
    ['.part', '.part'],
  ]) {
    for (const [killAt, expected] of Object.entries(EXPECTED)) {
      const sub = join(dir, `${killAt}${suffix}`);
      mkdirSync(sub);
      const path = join(sub, 'file.json');
      writeFileSync(path, 'old');
      // eslint-disable-next-line no-await-in-loop
      const run = await runChild(path, killAt, 'new', scratch);
      t.is(run.signal, 'SIGKILL', `${killAt}: ${run.err.slice(0, 300)}`);
      t.is(readFileSync(path, 'utf8'), expected.text, `${killAt}${suffix}`);
      const left = readdirSync(sub).sort();
      t.deepEqual(
        left,
        expected.scratch ? ['file.json', `file.json${suffix}`] : ['file.json'],
        `${killAt}${suffix}`,
      );
    }
  }
});

test('writeFileAtomic: mode, chmod, a failed step, and the cache writes', async t => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'atomic-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'a');
  /** @type {string[]} */
  const steps = [];
  await writeFileAtomic(path, 'one', {
    chmod: true,
    trace: step => steps.push(step),
  });
  t.is(readFileSync(path, 'utf8'), 'one');
  // eslint-disable-next-line no-bitwise
  t.is(statSync(path).mode & 0o777, 0o600);
  t.deepEqual(steps, ['write', 'fsync', 'rename', 'fsync-dir']);

  // A cache write: no fsync of the file or the directory.
  steps.length = 0;
  await writeFileAtomic(path, 'two', {
    sync: false,
    syncDirectory: false,
    trace: step => steps.push(step),
  });
  t.is(readFileSync(path, 'utf8'), 'two');
  t.deepEqual(steps, ['write', 'rename']);

  // A buffer list is written whole.
  await writeFileAtomic(path, [Buffer.from('th'), Buffer.from('ree')]);
  t.is(readFileSync(path, 'utf8'), 'three');

  // A failed step keeps the old file; the scratch is removed only when asked.
  const fail = () => {
    throw Error('stop at rename');
  };
  await t.throwsAsync(
    writeFileAtomic(path, 'four', {
      trace: step => (step === 'rename' ? fail() : undefined),
    }),
    { message: 'stop at rename' },
  );
  t.deepEqual(readdirSync(dir).sort(), ['a', 'a.tmp']);
  await t.throwsAsync(
    writeFileAtomic(path, 'five', {
      removeScratchOnError: true,
      trace: step => (step === 'rename' ? fail() : undefined),
    }),
    { message: 'stop at rename' },
  );
  t.deepEqual(readdirSync(dir), ['a']);
  t.is(readFileSync(path, 'utf8'), 'three');
});
