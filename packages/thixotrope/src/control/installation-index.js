// @ts-check
/** @import { SyncStringAtom } from '../store/sync-string-atom.js' */
import { Fail } from '@endo/errors';
import { Far } from '@endo/far';
import harden from '@endo/harden';

import { assertRecordVersion } from '../store/versioned-record.js';

/**
 * The host's own record of what the registry vat holds: one entry per
 * installed name, in a workspace or daemon-wide, with its kind, code
 * digest, grants, allocation key, vat and status. The registry vat is the authority and writes it at every step;
 * this copy lets the host list installations and retire their vats when the
 * registry vat cannot run, and keeps installed vats and stored bundles
 * accounted for without any user's workspace.
 *
 * Manually persisted: a versioned JSON record in one atom, rewritten whole
 * on each change.
 *
 * @typedef {object} IndexEntry
 * @property {string} [workspace] the workspace the installation belongs to;
 *   absent for one the daemon holds for every workspace
 * @property {'application' | 'native'} kind
 * @property {string} digest
 * @property {Array<[string, string]>} grants
 * @property {string} allocationKey
 * @property {string} [workerId]
 * @property {string} [bundleDigest]
 * @property {string} [durableDigest]
 * @property {string} [ephemeralDigest]
 * @property {'pending' | 'ready' | 'failed'} status
 * @property {string} [error]
 * @property {boolean} [provisional] recorded by the host before the registry
 *   received the request; the registry's own records replace it
 */

const INDEX_VERSION = 2;

/**
 * @param {string | undefined} workspace
 * @param {string} name
 */
const keyOf = (workspace, name) => JSON.stringify([workspace ?? null, name]);

/**
 * @param {SyncStringAtom} storage
 */
export const makeInstallationIndex = storage => {
  /** @param {string} name */
  const assertName = name => {
    (typeof name === 'string' && name.length > 0) ||
      Fail`Expected an installation name`;
  };
  /** @param {string | undefined} workspace */
  const assertWorkspace = workspace => {
    workspace === undefined ||
      (typeof workspace === 'string' && workspace.length > 0) ||
      Fail`Expected a workspace name`;
  };
  /** @param {unknown} entry */
  const assertEntry = entry => {
    const record = /** @type {IndexEntry} */ (entry);
    (typeof record === 'object' &&
      record !== null &&
      (record.workspace === undefined ||
        (typeof record.workspace === 'string' &&
          record.workspace.length > 0)) &&
      (record.kind === 'application' || record.kind === 'native') &&
      typeof record.digest === 'string' &&
      Array.isArray(record.grants) &&
      typeof record.allocationKey === 'string' &&
      ['pending', 'ready', 'failed'].includes(record.status)) ||
      Fail`Invalid installation index entry`;
    return record;
  };
  /** @type {Map<string, IndexEntry>} */
  let entries = new Map();
  const text = storage.read();
  if (text !== undefined) {
    const parsed = /** @type {{version?: unknown, entries?: unknown}} */ (
      JSON.parse(text)
    );
    (typeof parsed === 'object' && parsed !== null) ||
      Fail`Invalid installation index`;
    const { version, entries: stored } = parsed;
    assertRecordVersion('installation index', version, INDEX_VERSION);
    stored === undefined ||
      Array.isArray(stored) ||
      Fail`Invalid installation index entries`;
    entries = new Map(
      /** @type {unknown[]} */ (stored ?? []).map(item => {
        const { name, ...entry } = /** @type {{name: string}} */ (item);
        assertName(name);
        const record = assertEntry(entry);
        return [keyOf(record.workspace, name), harden({ ...record })];
      }),
    );
  }
  const save = () => {
    storage.write(
      `${JSON.stringify({
        version: INDEX_VERSION,
        entries: [...entries].map(([key, entry]) => {
          const [, name] = JSON.parse(key);
          return { name, ...entry };
        }),
      })}\n`,
    );
  };
  const index = harden({
    /**
     * @param {string | undefined} workspace
     * @param {string} name
     * @param {IndexEntry} entry
     */
    record: (workspace, name, entry) => {
      assertWorkspace(workspace);
      assertName(name);
      const record = assertEntry(entry);
      entries.set(
        keyOf(workspace, name),
        harden({
          ...record,
          ...(workspace === undefined ? {} : { workspace }),
        }),
      );
      save();
    },
    /**
     * @param {string | undefined} workspace
     * @param {string} name
     */
    forget: (workspace, name) => {
      assertWorkspace(workspace);
      assertName(name);
      if (!entries.delete(keyOf(workspace, name))) return false;
      save();
      return true;
    },
    /**
     * @param {string | undefined} workspace
     * @param {string} name
     */
    get: (workspace, name) => entries.get(keyOf(workspace, name)),
    list: () =>
      harden(
        [...entries].map(([key, entry]) => {
          const [, name] = JSON.parse(key);
          return harden({ name, ...entry });
        }),
      ),
    /**
     * The facet the registry vat writes through; the host keeps `get` and
     * `list` to itself.
     */
    resource: () =>
      Far('InstallationIndex', {
        help: () =>
          "The host's record of installations: record(workspace, name, entry) and forget(workspace, name).",
        record: index.record,
        forget: index.forget,
      }),
  });
  return index;
};
harden(makeInstallationIndex);
