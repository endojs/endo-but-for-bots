// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { E } from '@endo/eventual-send';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount, makeRevocableMount } from '../src/mount.js';
import { buildMountFixture } from './_mount-fixture.js';

const grepCasesUrl = new URL('./mount-grep-cases.json', import.meta.url);

const filePowers = makeFilePowers({ fs, path });

/**
 * The grep variant coverage matrix, shared verbatim with a future Rust/XS-side
 * runner. Each case pins the exact `grep(pattern, options)` records over the
 * canonical mount fixture; a discrepancy is either a Node regression or a
 * cross-language parity break.
 */
const { cases } = JSON.parse(fs.readFileSync(grepCasesUrl, 'utf8'));

test('grep variant case table over the shared fixture (Rust/Node parity contract)', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  await null;
  let ran = 0;
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await E(mount).grep(testCase.pattern, testCase.options);
    t.deepEqual(
      [...result],
      testCase.expect,
      `${testCase.name} — grep(${JSON.stringify(testCase.pattern)}, ${JSON.stringify(
        testCase.options,
      )})`,
    );
    ran += 1;
  }
  // Guard against a silently-empty table or a broken loop reporting green.
  t.true(ran >= 10, `expected the matrix to exercise many cases, ran ${ran}`);
});

test('grep defaults to searching the whole tree with an unbounded cap', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // No options argument at all exercises `{ glob = '**/*', maxResults = 1000 }`.
  const result = await E(mount).grep('first line');
  t.true(
    [...result].some(
      match =>
        match.file === 'notes.txt' &&
        match.line === 1 &&
        match.text === 'first line',
    ),
    'the default `**/*` selection reaches notes.txt',
  );
});

test('grep on a subView reports sub-root-relative file paths', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const sub = await E(mount).subView('src');
  const result = await E(sub).grep('export', { glob: '**/*.js' });
  t.deepEqual(
    [...result],
    [
      { file: 'index.js', line: 1, text: 'export const index = 1;' },
      { file: 'nested/deep.js', line: 1, text: 'export const deep = 3;' },
      {
        file: 'nested/deeper/deepest.js',
        line: 1,
        text: 'export const deepest = 4;',
      },
      { file: 'util.js', line: 1, text: 'export const util = 2;' },
    ],
  );
});

test('grep strips a trailing carriage return from CRLF lines', async t => {
  // A CRLF fixture, kept out of the shared manifest so the glob case table's
  // pinned expectations stay LF-only. `alpha$` is load-bearing: with the `\r`
  // strip the line is "alpha" and matches; without it the line is "alpha\r",
  // which ends in a carriage return and `alpha$` would not match.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-grep-crlf-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'alpha\r\nbeta\r\n');

  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const result = await E(mount).grep('alpha$', { glob: 'crlf.txt' });
  t.deepEqual(
    [...result],
    [{ file: 'crlf.txt', line: 1, text: 'alpha' }],
    'the matched text carries no trailing carriage return',
  );
  // Belt and suspenders: no record's text retains a `\r`.
  const everyLine = await E(mount).grep('a', { glob: 'crlf.txt' });
  t.false(
    [...everyLine].some(match => match.text.includes('\r')),
    'CRLF normalization strips every carriage return',
  );
});

test('grep does not fail on a binary file it cannot decode', async t => {
  const { root } = buildMountFixture(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  // The default `**/*` selection includes the binary probe docs/img.png. Node
  // substitutes U+FFFD where XS may throw; either way grep must complete rather
  // than propagating the decode failure as a rejection. Asserting non-rejection
  // is the load-bearing check (a leaked decode error would reject the promise);
  // the returned records are additionally verified to be well-formed.
  const grepping = E(mount).grep('e');
  await t.notThrowsAsync(
    grepping,
    'grep completes over the undecodable binary probe instead of rejecting',
  );
  const result = await grepping;
  for (const match of [...result]) {
    t.is(typeof match.file, 'string');
    t.is(typeof match.line, 'number');
    t.is(typeof match.text, 'string');
  }
});

test('grep on a revoked mount throws before reading any file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-grep-revoke-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.txt'), 'live\n');

  const { mount, control } = makeRevocableMount({
    rootPath: root,
    readOnly: false,
    filePowers,
  });
  t.deepEqual(
    [...(await E(mount).grep('live', { glob: 'a.txt' }))],
    [{ file: 'a.txt', line: 1, text: 'live' }],
  );

  E(control).revoke();

  await t.throwsAsync(() => E(mount).grep('live', { glob: 'a.txt' }), {
    message: /Mount has been revoked/,
  });
});
