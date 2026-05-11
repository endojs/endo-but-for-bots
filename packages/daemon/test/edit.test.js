// @ts-nocheck

// Establish a perimeter:
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'fs';
import path from 'path';
import url from 'url';
import crypto from 'crypto';

import {
  applyPatch,
  joinLines,
  lineAnchorHash,
  parseHashlineText,
  splitLines,
  validateAnchors,
  validateEditPatch,
} from '../src/hashline.js';
import { makeMount } from '../src/mount.js';
import { makeCryptoPowers, makeFilePowers } from '../src/daemon-node-powers.js';

const dirname = url.fileURLToPath(new URL('..', import.meta.url));

const cryptoPowers = makeCryptoPowers(crypto);
const filePowers = makeFilePowers({ fs, path });

/**
 * @param {string} text
 * @returns {string}
 */
const sha256Hex = text => {
  const d = cryptoPowers.makeSha256();
  d.updateText(text);
  return d.digestHex();
};

/** @param {import('ava').ExecutionContext<unknown>} t */
const makeTempMount = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(dirname, 'tmp', 'edit-test-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  return makeMount({
    rootPath: root,
    readOnly: false,
    filePowers,
    cryptoPowers,
  });
};

test.before(async () => {
  await fs.promises.mkdir(path.join(dirname, 'tmp'), { recursive: true });
});

// ---------------------------------------------------------------
// Pure module: lineAnchorHash, splitLines/joinLines, parser, validator
// ---------------------------------------------------------------

test('lineAnchorHash is stable for identical inputs', t => {
  t.is(lineAnchorHash('hello world', 1), lineAnchorHash('hello world', 1));
});

test('lineAnchorHash differs between empty lines via line-number seed', t => {
  // Per design: empty / whitespace-only lines seed the hash with the
  // line number so multiple blank lines do not collide.
  const h1 = lineAnchorHash('', 1);
  const h2 = lineAnchorHash('', 2);
  t.not(h1, h2);
});

test('lineAnchorHash strips trailing whitespace', t => {
  // Per design: strip trailing whitespace; preserve leading.
  t.is(lineAnchorHash('foo', 1), lineAnchorHash('foo   ', 1));
  t.not(lineAnchorHash('  foo', 1), lineAnchorHash('foo', 1));
});

test('splitLines round-trips with trailing newline', t => {
  const text = 'a\nb\nc\n';
  const { lines, trailingNewline } = splitLines(text);
  t.deepEqual(lines, ['a', 'b', 'c']);
  t.true(trailingNewline);
  t.is(joinLines(lines, trailingNewline), text);
});

test('splitLines round-trips without trailing newline', t => {
  const text = 'a\nb\nc';
  const { lines, trailingNewline } = splitLines(text);
  t.deepEqual(lines, ['a', 'b', 'c']);
  t.false(trailingNewline);
  t.is(joinLines(lines, trailingNewline), text);
});

test('splitLines handles empty file', t => {
  const { lines, trailingNewline } = splitLines('');
  t.deepEqual(lines, []);
  t.false(trailingNewline);
  t.is(joinLines(lines, trailingNewline), '');
});

test('parseHashlineText accepts a minimal patch', t => {
  const fileHash = sha256Hex('hello\n');
  const patchText = `@expected-file-hash ${fileHash}\n@replace 1#${lineAnchorHash('hello', 1)}\n| world\n`;
  const patch = parseHashlineText(patchText);
  t.is(patch.expectedFileHash, fileHash);
  t.is(patch.ops.length, 1);
  t.is(patch.ops[0].op, 'replace');
  t.deepEqual(patch.ops[0].payload, ['world']);
});

test('parseHashlineText rejects missing expected-file-hash header', t => {
  t.throws(() => parseHashlineText('@replace 1#a3\n| foo\n'), {
    message: /missing required @expected-file-hash/,
  });
});

test('parseHashlineText rejects unknown op kind', t => {
  const fileHash = sha256Hex('a\n');
  t.throws(
    () =>
      parseHashlineText(`@expected-file-hash ${fileHash}\n@bogus 1#a3\n| x\n`),
    { message: /unknown op/ },
  );
});

test('validateEditPatch accepts a valid envelope', t => {
  const fileHash = sha256Hex('hello\n');
  const patch = validateEditPatch({
    expectedFileHash: fileHash,
    ops: [
      {
        op: 'replace',
        anchor: { line: 1, hash: lineAnchorHash('hello', 1) },
        payload: ['world'],
      },
    ],
  });
  t.is(patch.expectedFileHash, fileHash);
});

test('validateEditPatch rejects malformed expectedFileHash', t => {
  t.throws(() => validateEditPatch({ expectedFileHash: 'short', ops: [] }), {
    message: /64-char lowercase hex SHA-256/,
  });
});

test('validateAnchors flags a stale per-line anchor', t => {
  const lines = ['hello', 'world'];
  const patch = {
    expectedFileHash: 'a'.repeat(64),
    ops: [
      {
        op: 'replace',
        // Wrong hash on purpose
        anchor: { line: 1, hash: 'ff' },
        payload: ['HELLO'],
      },
    ],
  };
  const mismatches = validateAnchors(patch, lines);
  t.is(mismatches.length, 1);
  t.is(mismatches[0].line, 1);
  t.is(mismatches[0].hashExpected, 'ff');
  t.is(mismatches[0].hashActual, lineAnchorHash('hello', 1));
});

test('applyPatch executes ops bottom-up across multiple lines', t => {
  const lines = ['a', 'b', 'c', 'd', 'e'];
  const patch = {
    expectedFileHash: 'a'.repeat(64),
    ops: [
      {
        op: 'replace',
        anchor: { line: 5, hash: lineAnchorHash('e', 5) },
        payload: ['E'],
      },
      {
        op: 'insert-after',
        anchor: { line: 2, hash: lineAnchorHash('b', 2) },
        payload: ['B+'],
      },
      {
        op: 'delete',
        anchor: { line: 3, hash: lineAnchorHash('c', 3) },
      },
    ],
  };
  const { lines: out } = applyPatch(patch, lines);
  // Expected: a, b, B+, d, E (c deleted; B+ inserted after b; e replaced).
  t.deepEqual(out, ['a', 'b', 'B+', 'd', 'E']);
});

test('applyPatch supports prepend and append', t => {
  const lines = ['middle'];
  const patch = {
    expectedFileHash: 'a'.repeat(64),
    ops: [
      { op: 'prepend', payload: ['top'] },
      { op: 'append', payload: ['bottom'] },
    ],
  };
  const { lines: out } = applyPatch(patch, lines);
  t.deepEqual(out, ['top', 'middle', 'bottom']);
});

// ---------------------------------------------------------------
// Mount-level integration: read-edit-read round-trip; CAS race;
// per-line anchor mismatch.
// ---------------------------------------------------------------

test.serial('mount.edit: round-trip read-edit-read', async t => {
  const mount = await makeTempMount(t);
  const original = 'alpha\nbeta\ngamma\n';
  await mount.writeText(['notes.txt'], original);

  // Compute the patch envelope from the read content.
  const fileHash = sha256Hex(original);
  const { lines } = splitLines(original);
  const patch = {
    expectedFileHash: fileHash,
    ops: [
      {
        op: 'replace',
        anchor: { line: 2, hash: lineAnchorHash(lines[1], 2) },
        payload: ['BETA'],
      },
    ],
  };

  const result = await mount.edit(['notes.txt'], patch);
  t.true(result.success, JSON.stringify(result));
  const after = await mount.readText(['notes.txt']);
  t.is(after, 'alpha\nBETA\ngamma\n');
  t.is(result.fileHashAfter, sha256Hex(after));
});

test.serial('mount.edit: CAS mismatch leaves file unmodified', async t => {
  const mount = await makeTempMount(t);
  const original = 'one\ntwo\nthree\n';
  await mount.writeText(['data.txt'], original);

  const patch = {
    // Deliberately wrong file hash.
    expectedFileHash: '0'.repeat(64),
    ops: [
      {
        op: 'replace',
        anchor: { line: 1, hash: lineAnchorHash('one', 1) },
        payload: ['ONE'],
      },
    ],
  };

  const result = await mount.edit(['data.txt'], patch);
  t.false(result.success);
  t.is(result.failure.reason, 'file-rev-mismatch');
  t.is(result.failure.fileHashActual, sha256Hex(original));

  const after = await mount.readText(['data.txt']);
  t.is(after, original, 'file must not be modified on CAS failure');
});

test.serial(
  'mount.edit: per-line anchor mismatch leaves file unmodified',
  async t => {
    const mount = await makeTempMount(t);
    const original = 'first\nsecond\nthird\n';
    await mount.writeText(['lines.txt'], original);

    const fileHash = sha256Hex(original);
    const patch = {
      expectedFileHash: fileHash,
      ops: [
        {
          op: 'replace',
          // Right line number, wrong content hash.
          anchor: { line: 2, hash: 'ff' },
          payload: ['SECOND'],
        },
      ],
    };

    const result = await mount.edit(['lines.txt'], patch);
    t.false(result.success);
    t.is(result.failure.reason, 'hash-mismatch');
    t.is(result.failure.mismatches.length, 1);
    t.is(result.failure.mismatches[0].line, 2);

    const after = await mount.readText(['lines.txt']);
    t.is(after, original, 'file must not be modified on anchor failure');
  },
);

test.serial(
  'mount.edit: read-only mount rejects edit with permission-denied',
  async t => {
    const root = await fs.promises.mkdtemp(
      path.join(dirname, 'tmp', 'edit-ro-'),
    );
    t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'ro.txt');
    await fs.promises.writeFile(file, 'locked\n');
    const mount = makeMount({
      rootPath: root,
      readOnly: true,
      filePowers,
      cryptoPowers,
    });
    const fileHash = sha256Hex('locked\n');
    const patch = {
      expectedFileHash: fileHash,
      ops: [
        {
          op: 'replace',
          anchor: { line: 1, hash: lineAnchorHash('locked', 1) },
          payload: ['LOCKED'],
        },
      ],
    };
    const result = await mount.edit(['ro.txt'], patch);
    t.false(result.success);
    t.is(result.failure.reason, 'permission-denied');
  },
);

test.serial('mount.edit: missing file returns path-not-found', async t => {
  const mount = await makeTempMount(t);
  const patch = {
    expectedFileHash: sha256Hex(''),
    ops: [],
  };
  const result = await mount.edit(['absent.txt'], patch);
  t.false(result.success);
  t.is(result.failure.reason, 'path-not-found');
});

test.serial('mount.edit: malformed patch returns patch-syntax', async t => {
  const mount = await makeTempMount(t);
  await mount.writeText(['x.txt'], 'hi\n');
  const result = await mount.edit(['x.txt'], { not: 'a patch' });
  t.false(result.success);
  t.is(result.failure.reason, 'patch-syntax');
});

test.serial(
  'mount.edit: two concurrent edits — one wins, one sees file-rev-mismatch',
  async t => {
    const mount = await makeTempMount(t);
    const original = 'x\ny\n';
    await mount.writeText(['race.txt'], original);

    const fileHash = sha256Hex(original);
    const patchA = {
      expectedFileHash: fileHash,
      ops: [
        {
          op: 'replace',
          anchor: { line: 1, hash: lineAnchorHash('x', 1) },
          payload: ['X'],
        },
      ],
    };
    const patchB = {
      expectedFileHash: fileHash,
      ops: [
        {
          op: 'replace',
          anchor: { line: 2, hash: lineAnchorHash('y', 2) },
          payload: ['Y'],
        },
      ],
    };

    // Fire both without awaiting in between; the mount-internal lock
    // should serialize them. The first to land succeeds; the second
    // sees the file at a new SHA-256 and reports file-rev-mismatch.
    const [resA, resB] = await Promise.all([
      mount.edit(['race.txt'], patchA),
      mount.edit(['race.txt'], patchB),
    ]);

    const successes = [resA, resB].filter(r => r.success);
    const failures = [resA, resB].filter(r => !r.success);
    t.is(successes.length, 1, 'exactly one edit succeeds');
    t.is(failures.length, 1, 'exactly one edit fails');
    t.is(failures[0].failure.reason, 'file-rev-mismatch');
    // The losing edit reports the file's current SHA-256 (post-winner).
    t.is(failures[0].failure.fileHashActual, successes[0].fileHashAfter);
  },
);
