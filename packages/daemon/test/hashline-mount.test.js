// Mount-level tests for the hashline `edit` critical section, per
// `designs/cli-edit-verb.md` Phase 2. These construct an `EndoMount`
// directly over a real temp directory (no daemon / worker) and exercise
// the read-validate-splice-write path end to end: CAS success/conflict,
// per-line anchor mismatch, splice edge cases, mode-bit preservation,
// over-cap rejection, the error taxonomy, and concurrent-edit
// serialization under the mount-internal lock.

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { makeMount } from '../src/mount.js';
import { makeFilePowers } from '../src/daemon-node-powers.js';

const filePowers = makeFilePowers({ fs, path });

/**
 * Create a temp directory seeded with files and return a mount over it.
 *
 * @param {Record<string, string>} files
 * @param {{ readOnly?: boolean, maxEditFileSize?: number }} [opts]
 */
const prepareMount = async (files, opts = {}) => {
  const rootPath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'hashline-mount-'),
  );
  for (const [name, content] of Object.entries(files)) {
    // eslint-disable-next-line no-await-in-loop
    await fs.promises.writeFile(path.join(rootPath, name), content, 'utf-8');
  }
  const mount = makeMount({
    rootPath,
    readOnly: opts.readOnly ?? false,
    filePowers,
    maxEditFileSize: opts.maxEditFileSize,
  });
  return { mount, rootPath };
};

test('edit: reads hashline attribution then applies an edit (round trip)', async t => {
  const { mount, rootPath } = await prepareMount({
    'notes.txt': 'alpha\nbravo\ncharlie\n',
  });

  // (a) READ the document with hash-line attribution.
  const view = await mount.readTextHashline('notes.txt');
  t.deepEqual(
    view.lines.map(l => l.text),
    ['alpha', 'bravo', 'charlie'],
  );
  t.is(view.lines[1].line, 2);
  t.regex(view.lines[1].hash, /^[0-9a-f]{2}$/);

  // (b) EDIT the document with a hash-line command built from the view.
  const patch = {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'replace', anchor: view.lines[1], payload: ['BRAVO CHANGED'] }],
  };
  const result = await mount.edit('notes.txt', patch);
  t.true(result.success);

  const after = await fs.promises.readFile(
    path.join(rootPath, 'notes.txt'),
    'utf-8',
  );
  t.is(after, 'alpha\nBRAVO CHANGED\ncharlie\n');

  // fileHashAfter lets the agent chain a follow-up without re-reading.
  const reread = await mount.readTextHashline('notes.txt');
  t.is(result.fileHashAfter, reread.fileHash);
});

test('edit: CAS conflict returns file-rev-mismatch with the live hash', async t => {
  const { mount } = await prepareMount({ 'f.txt': 'one\ntwo\n' });
  const view = await mount.readTextHashline('f.txt');

  const patch = {
    expectedFileHash: 'b'.repeat(64), // stale / wrong
    ops: [{ op: 'replace', anchor: view.lines[0], payload: ['ONE'] }],
  };
  const result = await mount.edit('f.txt', patch);
  t.false(result.success);
  t.is(result.failure.reason, 'file-rev-mismatch');
  t.is(result.failure.fileHashActual, view.fileHash);
});

test('edit: per-line anchor mismatch returns hash-mismatch (both widths)', async t => {
  const { mount } = await prepareMount({ 'f.txt': 'one\ntwo\n' });
  const view = await mount.readTextHashline('f.txt');

  // Correct whole-file hash so the CAS passes, but a wrong per-line
  // anchor so the inner staleness check fires.
  const patch = {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'replace', anchor: { line: 2, hash: '00' }, payload: ['X'] }],
  };
  const result = await mount.edit('f.txt', patch);
  t.false(result.success);
  t.is(result.failure.reason, 'hash-mismatch');
  t.is(result.failure.mismatches.length, 1);
  t.is(result.failure.mismatches[0].line, 2);
  t.is(result.failure.mismatches[0].hashExpected, '00');
  t.truthy(result.failure.mismatches[0].hashActualAtPatchWidth);
});

test('edit: CRLF is preserved byte-for-byte through the splice', async t => {
  const { mount, rootPath } = await prepareMount({
    'crlf.txt': 'a\r\nb\r\nc\r\n',
  });
  const view = await mount.readTextHashline('crlf.txt');
  // The middle line's content includes the trailing CR.
  t.is(view.lines[1].text, 'b\r');

  const patch = {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'insert-after', anchor: view.lines[1], payload: ['inserted'] }],
  };
  const result = await mount.edit('crlf.txt', patch);
  t.true(result.success);

  const after = await fs.promises.readFile(
    path.join(rootPath, 'crlf.txt'),
    'utf-8',
  );
  // Existing CRLF endings survive; the inserted LF-only line is added.
  t.is(after, 'a\r\nb\r\ninserted\nc\r\n');
});

test('edit: populate the empty file via append', async t => {
  const { mount, rootPath } = await prepareMount({ 'empty.txt': '' });
  const view = await mount.readTextHashline('empty.txt');
  t.is(
    view.fileHash,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );

  const result = await mount.edit('empty.txt', {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'append', payload: ['first line'] }],
  });
  t.true(result.success);
  t.is(
    await fs.promises.readFile(path.join(rootPath, 'empty.txt'), 'utf-8'),
    'first line\n',
  );
});

test('edit: absent file returns path-not-found', async t => {
  const { mount } = await prepareMount({});
  const result = await mount.edit('missing.txt', {
    expectedFileHash: 'a'.repeat(64),
    ops: [{ op: 'append', payload: ['x'] }],
  });
  t.false(result.success);
  t.is(result.failure.reason, 'path-not-found');
});

test('edit: malformed patch returns patch-syntax', async t => {
  const { mount } = await prepareMount({ 'f.txt': 'x\n' });
  const result = await mount.edit('f.txt', {
    expectedFileHash: 'nope',
    ops: [],
  });
  t.false(result.success);
  t.is(result.failure.reason, 'patch-syntax');
});

test('edit: read-only mount returns permission-denied', async t => {
  const { mount } = await prepareMount({ 'f.txt': 'x\n' }, { readOnly: true });
  const result = await mount.edit('f.txt', {
    expectedFileHash: 'a'.repeat(64),
    ops: [{ op: 'append', payload: ['x'] }],
  });
  t.false(result.success);
  t.is(result.failure.reason, 'permission-denied');
});

test('edit: preserves the target file mode bits', async t => {
  const { mount, rootPath } = await prepareMount({ 'm.txt': 'a\nb\n' });
  const target = path.join(rootPath, 'm.txt');
  await fs.promises.chmod(target, 0o640);

  const view = await mount.readTextHashline('m.txt');
  const result = await mount.edit('m.txt', {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'replace', anchor: view.lines[0], payload: ['A'] }],
  });
  t.true(result.success);

  const stat = await fs.promises.stat(target);
  // eslint-disable-next-line no-bitwise
  const modeBits = stat.mode & 0o777;
  t.is(modeBits, 0o640, 'mode bits survive the edit');
});

test('edit: over-cap file is rejected as patch-syntax', async t => {
  // A 64-byte file with an 8-byte cap.
  const content = `${'x'.repeat(62)}\n`;
  const { mount } = await prepareMount(
    { 'big.txt': content },
    { maxEditFileSize: 8 },
  );
  const result = await mount.edit('big.txt', {
    expectedFileHash: 'a'.repeat(64),
    ops: [{ op: 'append', payload: ['y'] }],
  });
  t.false(result.success);
  t.is(result.failure.reason, 'patch-syntax');
  t.regex(result.failure.diagnostic, /exceeds edit cap/);
});

test('edit: concurrent edits serialize; the loser sees file-rev-mismatch', async t => {
  const { mount, rootPath } = await prepareMount({
    'race.txt': 'one\ntwo\nthree\n',
  });
  const view = await mount.readTextHashline('race.txt');

  // Two patches built against the SAME revision, targeting different
  // lines. Without the mount lock both would read the same base and one
  // write would clobber the other; with the lock, the second to run
  // fails its CAS.
  const patchA = {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'replace', anchor: view.lines[0], payload: ['ONE'] }],
  };
  const patchB = {
    expectedFileHash: view.fileHash,
    ops: [{ op: 'replace', anchor: view.lines[2], payload: ['THREE'] }],
  };

  const [rA, rB] = await Promise.all([
    mount.edit('race.txt', patchA),
    mount.edit('race.txt', patchB),
  ]);

  const successes = [rA, rB].filter(r => r.success);
  const conflicts = [rA, rB].filter(
    r => !r.success && r.failure.reason === 'file-rev-mismatch',
  );
  t.is(successes.length, 1, 'exactly one edit wins');
  t.is(conflicts.length, 1, 'the loser sees file-rev-mismatch');

  // The winning edit's single-line change is intact and un-clobbered.
  const after = await fs.promises.readFile(
    path.join(rootPath, 'race.txt'),
    'utf-8',
  );
  t.true(
    after === 'ONE\ntwo\nthree\n' || after === 'one\ntwo\nTHREE\n',
    `exactly one edit landed cleanly: ${JSON.stringify(after)}`,
  );
});
