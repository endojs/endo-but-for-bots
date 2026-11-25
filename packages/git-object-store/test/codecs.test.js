// @ts-check

import '@endo/init/debug.js';

import { wrapTest } from '@endo/ses-ava';
import rawTest from 'ava';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  frameObject,
  hashObject,
  parseBlob,
  parseCommit,
  parseTag,
  parseTree,
  serializeBlob,
  serializeCommit,
  serializeTag,
  serializeTree,
} from '../index.js';
import { nodeDigest } from '../src/node-digest.js';

const test = wrapTest(rawTest);

/**
 * Ask native git for the oid of a loose object written into a temp repo.
 *
 * @param {'blob' | 'tree' | 'commit' | 'tag'} type
 * @param {Uint8Array} content
 * @param {'sha1' | 'sha256'} [algorithm]
 */
const gitHashObject = (type, content, algorithm = 'sha1') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-codec-'));
  try {
    const initArgs =
      algorithm === 'sha256' ? ['init', '--object-format=sha256'] : ['init'];
    const initResult = spawnSync('git', initArgs, {
      cwd: dir,
      encoding: 'utf8',
    });
    if (initResult.status !== 0) {
      // Older git may lack --object-format; skip sha256 cross-check.
      if (algorithm === 'sha256') {
        return undefined;
      }
      throw Error(`git init failed: ${initResult.stderr}`);
    }
    const hashResult = spawnSync(
      'git',
      ['hash-object', '-t', type, '--stdin', '-w'],
      { cwd: dir, input: Buffer.from(content) },
    );
    if (hashResult.status !== 0) {
      throw Error(
        `git hash-object failed: ${hashResult.stderr && hashResult.stderr.toString()}`,
      );
    }
    return hashResult.stdout.toString('utf8').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('blob codec is identity and oid matches framing', t => {
  const content = bytesFromText('hello\n');
  t.deepEqual(parseBlob(content), content);
  t.deepEqual(serializeBlob(content), content);

  const oid = hashObject('sha1', nodeDigest, 'blob', content);
  const framed = frameObject('blob', content);
  const expected = createHash('sha1').update(framed).digest('hex');
  t.is(oid, expected);

  const gitOid = gitHashObject('blob', content);
  t.truthy(gitOid);
  t.is(oid, /** @type {string} */ (gitOid));
});

test('tree codec round-trips and matches git oid', t => {
  const blobOid = hashObject('sha1', nodeDigest, 'blob', bytesFromText('hi\n'));
  const entries = [
    { mode: '100644', name: 'a.txt', oid: blobOid },
    { mode: '100644', name: 'b.txt', oid: blobOid },
  ];
  const content = serializeTree(entries, 'sha1');
  const parsed = parseTree(content, 'sha1');
  t.is(parsed.length, 2);
  t.is(parsed[0].name, 'a.txt');
  t.is(parsed[1].name, 'b.txt');
  t.is(parsed[0].oid, blobOid);

  // Re-serialize parsed entries.
  const again = serializeTree(
    parsed.map(e => ({ mode: e.mode, name: e.name, oid: e.oid })),
    'sha1',
  );
  t.deepEqual(again, content);

  const oid = hashObject('sha1', nodeDigest, 'tree', content);
  const gitOid = gitHashObject('tree', content);
  t.truthy(gitOid);
  t.is(oid, /** @type {string} */ (gitOid));
});

test('tree sort puts tree entries after blob with same prefix', t => {
  // Git sorts as if tree names have a trailing '/'.
  const oid = 'ab'.repeat(20);
  const content = serializeTree(
    [
      { mode: '40000', name: 'a', oid },
      { mode: '100644', name: 'a.txt', oid },
      { mode: '100644', name: 'b', oid },
    ],
    'sha1',
  );
  const parsed = parseTree(content, 'sha1');
  t.deepEqual(
    parsed.map(e => e.name),
    ['a.txt', 'a', 'b'],
  );
});

test('tree sort follows native UTF-8 byte order for astral names', t => {
  const oid = 'ab'.repeat(20);
  const content = serializeTree(
    [
      { mode: '100644', name: '\u{10000}', oid },
      { mode: '100644', name: '\uE000', oid },
    ],
    'sha1',
  );
  t.deepEqual(
    parseTree(content, 'sha1').map(entry => entry.name),
    ['\uE000', '\u{10000}'],
  );
});

test('commit codec round-trips and matches git oid', t => {
  const treeOid = 'a'.repeat(40);
  const parentOid = 'b'.repeat(40);
  const commit = {
    tree: treeOid,
    parents: [parentOid],
    author: {
      name: 'Ada',
      email: 'ada@example.com',
      when: '1000000000',
      tz: '+0000',
    },
    committer: {
      name: 'Ada',
      email: 'ada@example.com',
      when: '1000000001',
      tz: '+0000',
    },
    message: 'initial\n',
  };
  const content = serializeCommit(commit);
  const parsed = parseCommit(content);
  t.is(parsed.tree, treeOid);
  t.deepEqual(parsed.parents, [parentOid]);
  t.is(parsed.author.name, 'Ada');
  t.is(parsed.message, 'initial\n');

  const again = serializeCommit(parsed);
  t.deepEqual(again, content);

  const oid = hashObject('sha1', nodeDigest, 'commit', content);
  const gitOid = gitHashObject('commit', content);
  t.truthy(gitOid);
  t.is(oid, /** @type {string} */ (gitOid));
});

test('tag codec round-trips and matches git oid', t => {
  const objectOid = 'c'.repeat(40);
  const tagObject = {
    object: objectOid,
    type: /** @type {const} */ ('commit'),
    tag: 'v1.0.0',
    tagger: {
      name: 'Ada',
      email: 'ada@example.com',
      when: '1000000002',
      tz: '+0000',
    },
    message: 'release\n',
  };
  const content = serializeTag(tagObject);
  const parsed = parseTag(content);
  t.is(parsed.tag, 'v1.0.0');
  t.is(parsed.object, objectOid);
  const again = serializeTag(parsed);
  t.deepEqual(again, content);

  const oid = hashObject('sha1', nodeDigest, 'tag', content);
  const gitOid = gitHashObject('tag', content);
  t.truthy(gitOid);
  t.is(oid, /** @type {string} */ (gitOid));
});

test('sha256 framing length and digest path', t => {
  const content = bytesFromText('sha256 blob\n');
  const oid = hashObject('sha256', nodeDigest, 'blob', content);
  t.is(oid.length, 64);
  const framed = frameObject('blob', content);
  const expected = createHash('sha256').update(framed).digest('hex');
  t.is(oid, expected);

  const gitOid = gitHashObject('blob', content, 'sha256');
  if (gitOid !== undefined) {
    t.is(oid, gitOid);
  } else {
    t.pass('git lacks sha256 object-format; skipped native cross-check');
  }
});
