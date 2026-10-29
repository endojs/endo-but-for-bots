// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import {
  parseDiffOutput,
  parseGitDiff,
  parsePatchSections,
  parseRawDiff,
  splitDiffOutput,
} from '../src/parse-diff.js';

const ZERO_OID = '0'.repeat(40);
const OLD_OID = '1'.repeat(40);
const NEW_OID = '2'.repeat(40);

/**
 * @param {string} oldMode
 * @param {string} newMode
 * @param {string} status
 * @param {string[]} paths
 */
const rawRecord = (oldMode, newMode, status, paths) =>
  [`:${oldMode} ${newMode} ${OLD_OID} ${NEW_OID} ${status}`, ...paths].join(
    '\0',
  );

/** @param {string[]} records */
const rawText = records => `${records.join('\0')}\0`;

test('parseRawDiff reads NUL-delimited records, including rename targets', t => {
  const text = rawText([
    rawRecord('100644', '100644', 'M', ['tab\there.txt']),
    rawRecord('100644', '100755', 'R087', ['before.txt', 'after.txt']),
  ]);
  t.deepEqual(parseRawDiff(text), [
    {
      oldMode: '100644',
      newMode: '100644',
      letter: 'M',
      path: 'tab\there.txt',
    },
    {
      oldMode: '100644',
      newMode: '100755',
      letter: 'R',
      path: 'before.txt',
      destinationPath: 'after.txt',
    },
  ]);
  t.deepEqual(parseRawDiff(''), []);
  t.throws(() => parseRawDiff('garbage\0'), {
    message: /Unexpected git diff --raw field/,
  });
});

test('parsePatchSections counts hunk lines and tolerates blank context', t => {
  const patch = [
    'diff --git a/f b/f',
    'index 1111111..2222222 100644',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,3 @@ heading',
    ' one',
    // `diff.suppressBlankEmpty` renders a blank context line as empty.
    '',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '@@ -9 +9 @@',
    '--- looks like a header',
    '+++ looks like a header',
    'diff --git a/bin b/bin',
    'index 1111111..2222222 100644',
    'Binary files a/bin and b/bin differ',
    '',
  ].join('\n');
  t.deepEqual(parsePatchSections(patch), [
    {
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: 'context', text: 'one' },
            { kind: 'context', text: '' },
            { kind: 'remove', text: 'old' },
            { kind: 'add', text: 'new' },
          ],
        },
        {
          oldStart: 9,
          oldLines: 1,
          newStart: 9,
          newLines: 1,
          lines: [
            { kind: 'remove', text: '-- looks like a header' },
            { kind: 'add', text: '++ looks like a header' },
          ],
        },
      ],
    },
    { binary: true, hunks: [] },
  ]);
});

test('parsePatchSections rejects a hunk that ends before its counts', t => {
  const patch = ['diff --git a/f b/f', '@@ -1,2 +1,2 @@', ' one', ''].join(
    '\n',
  );
  t.throws(() => parsePatchSections(patch), { message: /ends early/ });
});

test('parseGitDiff joins raw records with their patch sections', t => {
  const raw = rawText([
    rawRecord('000000', '100644', 'A', ['added.txt']),
    rawRecord('100644', '000000', 'D', ['deleted.txt']),
    rawRecord('100644', '100755', 'R100', ['g', 'h']),
  ]);
  const patch = [
    'diff --git a/added.txt b/added.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/deleted.txt b/deleted.txt',
    'deleted file mode 100644',
    '--- a/deleted.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/g b/h',
    'old mode 100644',
    'new mode 100755',
    'similarity index 100%',
    'rename from g',
    'rename to h',
    '',
  ].join('\n');
  t.deepEqual(parseGitDiff(raw, patch), {
    files: [
      {
        status: 'added',
        newPath: 'added.txt',
        newMode: 0o10_0644,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: 'add', text: 'hello' }],
          },
        ],
      },
      {
        status: 'deleted',
        oldPath: 'deleted.txt',
        oldMode: 0o10_0644,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 0,
            newLines: 0,
            lines: [{ kind: 'remove', text: 'bye' }],
          },
        ],
      },
      {
        status: 'renamed',
        oldPath: 'g',
        newPath: 'h',
        oldMode: 0o10_0644,
        newMode: 0o10_0755,
        hunks: [],
      },
    ],
  });
});

test('parseGitDiff folds a type change and an unmerged path', t => {
  const raw = rawText([
    `:000000 100644 ${ZERO_OID} ${ZERO_OID} U\0conflict.txt`,
    `:100644 100644 ${OLD_OID} ${ZERO_OID} M\0conflict.txt`,
    rawRecord('100644', '120000', 'T', ['link']),
  ]);
  const patch = [
    'diff --cc conflict.txt',
    'index 1111111,2222222..0000000',
    '--- a/conflict.txt',
    '+++ b/conflict.txt',
    '@@@ -1,1 -1,1 +1,5 @@@',
    '++<<<<<<< HEAD',
    ' +ours',
    '++=======',
    '+ theirs',
    '++>>>>>>> side',
    'diff --git a/link b/link',
    'deleted file mode 100644',
    '--- a/link',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-was a file',
    'diff --git a/link b/link',
    'new file mode 120000',
    '--- /dev/null',
    '+++ b/link',
    '@@ -0,0 +1 @@',
    '+target',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  t.deepEqual(parseGitDiff(raw, patch), {
    files: [
      {
        status: 'unmerged',
        oldPath: 'conflict.txt',
        newPath: 'conflict.txt',
        hunks: [],
      },
      {
        status: 'modified',
        oldPath: 'link',
        newPath: 'link',
        oldMode: 0o10_0644,
        newMode: 0o12_0000,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 0,
            newLines: 0,
            lines: [{ kind: 'remove', text: 'was a file' }],
          },
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: 'add', text: 'target' }],
          },
        ],
      },
    ],
  });
});

test('parseGitDiff refuses raw and patch renderings that disagree', t => {
  const raw = rawText([rawRecord('100644', '100644', 'M', ['f'])]);
  t.throws(() => parseGitDiff(raw, ''), { message: /fewer files/ });
  const twoSections = 'diff --git a/f b/f\ndiff --git a/g b/g\n';
  t.throws(() => parseGitDiff(raw, twoSections), { message: /more files/ });
});

test('parseRawDiff refuses a record without its paths', t => {
  const header = `:100644 100644 ${OLD_OID} ${NEW_OID}`;
  t.throws(() => parseRawDiff(`${header} M\0`), { message: /names no path/ });
  t.throws(() => parseRawDiff(`${header} R100\0before.txt\0`), {
    message: /names no target/,
  });
});

test('parsePatchSections refuses malformed sections and hunks', t => {
  t.throws(() => parsePatchSections('index 1..2\n'), {
    message: /Unexpected git diff line/,
  });
  const header = ['diff --git a/f b/f', '@@ -1,2 +1,2 @@'];
  t.throws(() => parsePatchSections([...header, ' one', '?two'].join('\n')), {
    message: /Unexpected line/,
  });
  t.throws(() => parsePatchSections([...header, '-a', '-b', '-c'].join('\n')), {
    message: /overruns its counts/,
  });
});

test('parseGitDiff refuses an unsupported raw status letter', t => {
  const raw = rawText([rawRecord('100644', '100644', 'X', ['f'])]);
  t.throws(() => parseGitDiff(raw, 'diff --git a/f b/f\n'), {
    message: /Unsupported git diff status/,
  });
});

test('splitDiffOutput separates one run into raw records and patch', t => {
  const modify = `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M`;
  const rename = `:100644 100644 ${'3'.repeat(40)} ${'3'.repeat(40)} R100`;
  const rawPart = `${modify}\0a.txt\0${rename}\0old name\0new name\0`;
  const patchPart = [
    'diff --git a/a.txt b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    'diff --git a/old name b/new name',
    'similarity index 100%',
    'rename from old name',
    'rename to new name',
    '',
  ].join('\n');
  t.deepEqual(splitDiffOutput(`${rawPart}\0${patchPart}`), {
    rawText: rawPart,
    patchText: patchPart,
  });
  t.deepEqual(splitDiffOutput(''), { rawText: '', patchText: '' });
  t.deepEqual(splitDiffOutput(rawPart), { rawText: rawPart, patchText: '' });
  t.deepEqual(
    parseDiffOutput(`${rawPart}\0${patchPart}`).files.map(
      ({ status, newPath }) => [status, newPath],
    ),
    [
      ['modified', 'a.txt'],
      ['renamed', 'new name'],
    ],
  );
  const unmerged = `::100644 100644 100644 ${'4'.repeat(40)} ${'5'.repeat(40)} ${'0'.repeat(40)} MM`;
  t.deepEqual(
    parseDiffOutput(`${unmerged}\0f.txt\0\0diff --cc f.txt\nindex 4,5..0\n`)
      .files,
    [{ status: 'unmerged', oldPath: 'f.txt', newPath: 'f.txt', hunks: [] }],
  );
  t.throws(() => splitDiffOutput(`${modify}`), { message: /ends early/ });
});
