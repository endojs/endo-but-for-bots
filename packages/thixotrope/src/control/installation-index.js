// @ts-check
/** @import { SyncStringAtom } from '../store/sync-string-atom.js' */
import { Fail, q } from '@endo/errors';
import { Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * The host's own record of what the registry vat holds: one entry per
 * installed name with its kind, code digest, grants, allocation key, vat and
 * status. The registry vat is the authority and writes it at every step;
 * this copy lets the host list installations and retire their vats when the
 * registry vat cannot run, and keeps installed vats and stored bundles
 * accounted for without any user's workspace.
 *
 * Manually persisted: a versioned JSON record in one atom, rewritten whole
 * on each change.
 *
 * @typedef {object} IndexEntry
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

const INDEX_VERSION = 1;

/**
 * @param {SyncStringAtom} storage
 */
export const makeInstallationIndex = storage => {
  /** @param {string} name */
  const assertName = name => {
    (typeof name === 'string' && name.length > 0) ||
      Fail`Expected an installation name`;
  };
  /** @param {unknown} entry */
  const assertEntry = entry => {
    const record = /** @type {IndexEntry} */ (entry);
    (typeof record === 'object' &&
      record !== null &&
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
    if (typeof version !== 'number')
      throw Fail`Invalid installation index version`;
    if (version > INDEX_VERSION)
      throw Error(
        `Installation index is from a newer version: ${version} exceeds supported version ${INDEX_VERSION}; use that build or migrate to a fresh state directory`,
      );
    version === INDEX_VERSION ||
      Fail`Installation index version ${q(version)} needs migration`;
    stored === undefined ||
      (typeof stored === 'object' && stored !== null) ||
      Fail`Invalid installation index entries`;
    entries = new Map(
      Object.entries(/** @type {Record<string, unknown>} */ (stored ?? {})).map(
        ([name, entry]) => {
          assertName(name);
          return [name, harden({ ...assertEntry(entry) })];
        },
      ),
    );
  }
  const save = () => {
    storage.write(
      `${JSON.stringify({
        version: INDEX_VERSION,
        entries: Object.fromEntries(entries),
      })}\n`,
    );
  };
  const index = harden({
    /**
     * @param {string} name
     * @param {IndexEntry} entry
     */
    record: (name, entry) => {
      assertName(name);
      entries.set(name, harden({ ...assertEntry(entry) }));
      save();
    },
    /** @param {string} name */
    forget: name => {
      assertName(name);
      if (!entries.delete(name)) return false;
      save();
      return true;
    },
    /** @param {string} name */
    get: name => entries.get(name),
    list: () =>
      harden([...entries].map(([name, entry]) => harden({ name, ...entry }))),
    /**
     * The facet the registry vat writes through; the host keeps `get` and
     * `list` to itself.
     */
    resource: () =>
      Far('InstallationIndex', {
        help: () =>
          "The host's record of installations: record(name, entry) and forget(name).",
        record: index.record,
        forget: index.forget,
      }),
  });
  return index;
};
harden(makeInstallationIndex);
