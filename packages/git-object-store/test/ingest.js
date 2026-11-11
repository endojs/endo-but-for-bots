// @ts-check

import { spawn } from 'node:child_process';

import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

/** @import { GitObjectStore, GitObjectType } from '../src/types.js' */

/**
 * Parse one `git cat-file --batch` record from a buffer starting at `offset`.
 * Present: `<oid> <type> <size>\n<content>\n`
 * Missing: `<oid> missing\n`
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ oid: string, type?: GitObjectType, content?: Uint8Array, missing: boolean, next: number } | undefined}
 */
const tryParseRecord = (buffer, offset) => {
  if (offset >= buffer.length) {
    return undefined;
  }
  const nl = buffer.indexOf(0x0a, offset);
  if (nl < 0) {
    return undefined;
  }
  const header = buffer.subarray(offset, nl).toString('utf8');
  if (header.endsWith(' missing')) {
    return {
      oid: header.slice(0, header.indexOf(' ')),
      missing: true,
      next: nl + 1,
    };
  }
  const parts = header.split(' ');
  if (parts.length < 3) {
    return undefined;
  }
  const oid = parts[0];
  const type = /** @type {GitObjectType} */ (parts[1]);
  const size = Number(parts[2]);
  Number.isInteger(size) || Fail`bad cat-file size in ${q(header)}`;
  const contentStart = nl + 1;
  const contentEnd = contentStart + size;
  // Content is followed by a trailing newline.
  if (contentEnd + 1 > buffer.length) {
    return undefined;
  }
  const content = new Uint8Array(buffer.subarray(contentStart, contentEnd));
  return {
    oid,
    type,
    content,
    missing: false,
    next: contentEnd + 1,
  };
};

/**
 * Ingest objects from a git repository into a GitObjectStore using native
 * `git cat-file --batch`. Allowed only for test-time loading; the store read
 * path never shells out.
 *
 * When `oids` is omitted, uses `git rev-list --objects HEAD` bounded by
 * `maxCommits` to select a reachable set from HEAD.
 *
 * @param {object} options
 * @param {string} options.repoPath
 * @param {GitObjectStore} options.store
 * @param {string[]} [options.oids]
 * @param {number} [options.maxCommits]
 * @returns {Promise<{ headOid: string, ingested: number, byType: Record<string, number> }>}
 */
export const ingestGitRepository = async options => {
  await null;
  const { repoPath, store, maxCommits = 30 } = options;
  let oids = options.oids;

  const headResult = await runGit(repoPath, ['rev-parse', 'HEAD']);
  const headOid = headResult.stdout.toString('utf8').trim();

  if (oids === undefined) {
    const revList = await runGit(repoPath, [
      'rev-list',
      `--max-count=${maxCommits}`,
      '--objects',
      'HEAD',
    ]);
    const lines = revList.stdout.toString('utf8').split('\n').filter(Boolean);
    /** @type {Set<string>} */
    const set = new Set();
    for (const line of lines) {
      const oid = line.split(' ', 1)[0];
      if (oid) {
        set.add(oid);
      }
    }
    // Ensure HEAD is present even if maxCommits is 0 somehow.
    set.add(headOid);
    oids = [...set];
  }

  if (oids.length === 0) {
    return harden({
      headOid,
      ingested: 0,
      byType: harden({}),
    });
  }

  const batch = await runGit(
    repoPath,
    ['cat-file', '--batch'],
    `${oids.join('\n')}\n`,
  );

  let offset = 0;
  let ingested = 0;
  /** @type {Record<string, number>} */
  const byType = { blob: 0, tree: 0, commit: 0, tag: 0 };
  const buffer = batch.stdout;

  while (offset < buffer.length) {
    const record = tryParseRecord(buffer, offset);
    if (record === undefined) {
      throw Fail`failed to parse cat-file record at offset ${q(offset)}`;
    }
    offset = record.next;
    if (record.missing) {
      throw Fail`git cat-file reported missing object ${q(record.oid)}`;
    }
    const type = /** @type {GitObjectType} */ (record.type);
    const content = /** @type {Uint8Array} */ (record.content);
    // Sequential ingest keeps memory bounded for large object sets.
    // eslint-disable-next-line no-await-in-loop
    const written = await store.writeObject(type, content);
    if (written !== record.oid) {
      throw Fail`ingest oid mismatch: git said ${q(record.oid)} but store computed ${q(written)}`;
    }
    byType[type] = (byType[type] || 0) + 1;
    ingested += 1;
  }

  return harden({
    headOid,
    ingested,
    byType: harden(byType),
  });
};
harden(ingestGitRepository);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string | Buffer} [input]
 * @returns {Promise<{ stdout: Buffer, stderr: Buffer, status: number }>}
 */
const runGit = (cwd, args, input = undefined) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr.on('data', chunk => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', status => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        status: status ?? 1,
      });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  }).then(result => {
    if (result.status !== 0) {
      throw Error(
        `git ${args.join(' ')} failed (${result.status}): ${result.stderr.toString('utf8')}`,
      );
    }
    return result;
  });
