// @ts-check

import { Fail } from '@endo/errors';

import { assertPrivateDirectory } from './private-directory.js';
import {
  assertNativeProducerManifest,
  assertNativeProducerText,
} from './native-producer-lifecycle.js';

/** @import { ProducerManifest, ProducerProof, ProducerRecord, ProducerStore } from './native-producer-lifecycle.js' */

/**
 * Append-only filesystem CAS for one immutable producer incarnation.
 * The host must pre-create this private directory outside all guest authority.
 * Published revisions are never removed or reused. Orphan .pending-* files are
 * not publications and are preserved for host-private maintenance, not adopted.
 * Filesystem operations must support exclusive links and directory fsync;
 * unsupported filesystems fail closed. This store supplies no producer barrier.
 * Revision filenames use at most 64 decimal digits. Each JSON record is limited
 * to 8 MiB, reserving 256 KiB in active records for terminal proofs. Cumulative
 * admission snapshots currently have quadratic total storage cost; per-operation
 * journaling/compaction is required before claiming production-scale operation.
 *
 * @param {{directory: string, manifest: ProducerManifest}} options
 * @param {{fs?: typeof import('node:fs/promises'),
 * syncDirectory?: (directory: string) => Promise<void>}} [powers]
 * @returns {Promise<ProducerStore>}
 */
export const makeNativeProducerStore = async (
  { directory, manifest },
  { fs: fsPower, syncDirectory: syncPower } = {},
) => {
  assertNativeProducerManifest(manifest);
  const recordLimit = 8 * 1024 * 1024;
  const terminalReserve = 256 * 1024;
  const fs = fsPower ?? (await import('node:fs/promises'));
  const { dirname, join, resolve } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { constants } = await import('node:fs');
  typeof constants.O_NOFOLLOW === 'number' ||
    Fail`Producer store requires no-follow file opens`;
  const root = await assertPrivateDirectory(directory, fs);
  root === resolve(directory) ||
    Fail`Producer store path must not contain symlinks`;
  const identity = await fs.lstat(root, { bigint: true });
  const expectedManifest = JSON.stringify(manifest);
  const syncDirectory =
    syncPower ??
    (async path => {
      const handle = await fs.open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  const checkDirectory = async () => {
    const now = await fs.lstat(root, { bigint: true });
    (now.isDirectory() &&
      now.dev === identity.dev &&
      now.ino === identity.ino) ||
      Fail`Producer store directory identity changed`;
    let ancestor = root;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.lstat(ancestor);
      stat.isDirectory() || Fail`Producer store ancestry changed`;
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  };
  const flush = async () => {
    await checkDirectory();
    let ancestor = root;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await syncDirectory(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    await checkDirectory();
  };
  /** @param {string} revision */
  const revisionNumber = revision => {
    /^(0|[1-9][0-9]{0,63})$/u.test(revision) ||
      Fail`Invalid producer store revision`;
    return BigInt(revision);
  };
  /** @param {ProducerRecord} record @param {string} revision */
  const validate = (record, revision) => {
    (record.revision === revision &&
      JSON.stringify(record.manifest) === expectedManifest) ||
      Fail`Producer store record identity changed`;
    const phases = ['active', 'retiring', 'stopped', 'retired'];
    const phase = phases.indexOf(record.phase);
    phase >= 0 || Fail`Invalid producer store phase`;
    Array.isArray(record.admissions) || Fail`Invalid producer store admissions`;
    const ids = new Set();
    for (const admission of record.admissions) {
      assertNativeProducerText(admission.operationId);
      (manifest.roles.includes(admission.role) &&
        typeof admission.operationId === 'string' &&
        admission.operationId.length > 0 &&
        !ids.has(admission.operationId)) ||
        Fail`Invalid producer admission`;
      ids.add(admission.operationId);
    }
    /**
     * @param {ProducerProof | undefined} proof
     * @param {boolean} required
     */
    const checkProof = (proof, required) => {
      if (required) {
        if (!proof) throw Error('Missing producer store proof');
        assertNativeProducerText(proof.evidence);
        (proof &&
          JSON.stringify(proof.manifest) === expectedManifest &&
          typeof proof.evidence === 'string' &&
          proof.evidence.length > 0) ||
          Fail`Invalid producer store proof`;
      } else {
        proof === undefined || Fail`Premature producer store proof`;
      }
    };
    checkProof(record.shutdown, phase >= 2);
    checkProof(record.receipt, phase === 3);
    return harden(record);
  };
  /**
   * @param {ProducerRecord | undefined} previous
   * @param {ProducerRecord} next
   */
  const validateTransition = (previous, next) => {
    const phases = ['active', 'retiring', 'stopped', 'retired'];
    const phase = phases.indexOf(next.phase);
    phase >= 0 || Fail`Invalid producer store phase`;
    Array.isArray(next.admissions) || Fail`Invalid producer store admissions`;
    if (!previous) {
      (phase === 0 && next.admissions.length === 0) ||
        Fail`Invalid initial producer record`;
      return;
    }
    const before = phases.indexOf(previous.phase);
    (before === 0 && phase === 0) ||
      phase === before + 1 ||
      Fail`Invalid producer lifecycle transition`;
    const prefix = next.admissions.slice(0, previous.admissions.length);
    JSON.stringify(prefix) === JSON.stringify(previous.admissions) ||
      Fail`Producer admission history changed`;
    if (phase !== 0) {
      next.admissions.length === previous.admissions.length ||
        Fail`Producer admission after fence`;
    }
    if (previous.shutdown) {
      JSON.stringify(next.shutdown) === JSON.stringify(previous.shutdown) ||
        Fail`Producer shutdown proof changed`;
    }
  };
  const read = async () => {
    await checkDirectory();
    const names = await fs.readdir(root);
    const revisions = names
      .filter(name => !name.startsWith('.pending-'))
      .map(name => {
        /^revision-(0|[1-9][0-9]{0,63})\.json$/u.test(name) ||
          Fail`Unknown producer store entry`;
        return revisionNumber(name.slice(9, -5));
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let expected = 0n;
    /** @type {ProducerRecord | undefined} */
    let latest;
    for (const revision of revisions) {
      revision === expected || Fail`Producer store revision gap`;
      const file = join(root, `revision-${revision}.json`);
      // Ancestry is host-owned. O_NOFOLLOW refuses a substituted leaf symlink.
      // eslint-disable-next-line no-await-in-loop
      const handle = await fs.open(
        file,
        // eslint-disable-next-line no-bitwise
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        // eslint-disable-next-line no-await-in-loop
        const stat = await handle.stat();
        stat.isFile() || Fail`Producer store record is not a file`;
        stat.size <= recordLimit ||
          Fail`Producer store record exceeds size limit`;
        // eslint-disable-next-line no-await-in-loop
        const text = await handle.readFile('utf8');
        new TextEncoder().encode(text).length <= recordLimit ||
          Fail`Producer store record exceeds size limit`;
        const next = validate(JSON.parse(text), `${revision}`);
        validateTransition(latest, next);
        latest = next;
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await handle.close();
      }
      expected += 1n;
    }
    // A concurrent append can linearize after the directory snapshot. Published
    // files never change; flush before returning also repairs a lost flush ack.
    await flush();
    return latest;
  };
  /** @param {string | undefined} expected @param {ProducerRecord} next */
  const compareAndAppend = async (expected, next) => {
    const revision =
      expected === undefined ? 0n : revisionNumber(expected) + 1n;
    revisionNumber(`${revision}`);
    validate(next, `${revision}`);
    const found = await read();
    found?.revision === expected || Fail`Producer store revision conflict`;
    validateTransition(found, next);
    const text = JSON.stringify(next);
    const limit =
      next.phase === 'active' ? recordLimit - terminalReserve : recordLimit;
    new TextEncoder().encode(text).length <= limit ||
      Fail`Producer store record exceeds size limit`;
    const temporary = join(root, `.pending-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkDirectory();
    // Concurrent writers for the same expected revision contend on this exact
    // no-replace publication, not on a racy read-then-rename overwrite.
    await fs.link(temporary, join(root, `revision-${revision}.json`));
    await flush();
    await fs.unlink(temporary);
    await flush();
  };
  await flush();
  return harden({ read, compareAndAppend });
};
harden(makeNativeProducerStore);
