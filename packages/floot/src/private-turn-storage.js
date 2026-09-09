// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

const EVENT_PREFIX = 'floot-turn-event-';

/**
 * Factory-owned journal storage. Never introduce this facet into a guest.
 * Full-control administrators holding the factory host remain trusted: this
 * separates ordinary guests, not principals deliberately granted that host.
 * Migration preserves already-copied values, but legacy provenance is untrusted;
 * a names-only manifest cannot freeze source edits across interrupted copies.
 * One factory writer per session is required.
 *
 * @param {any} host
 * @param {string} sessionId
 * @param {any} legacyGuest
 * @param {{ legacyRequired?: boolean }} [options] - Set for every preexisting
 * guest, even if its model-writable journal has been erased completely.
 */
export const providePrivateTurnStorage = async (
  host,
  sessionId,
  legacyGuest,
  { legacyRequired = false } = {},
) => {
  typeof legacyRequired === 'boolean' ||
    Fail`Invalid legacy journal provenance`;
  /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || Fail`Invalid journal session ID`;
  // The length disambiguates IDs that are prefixes of other session IDs.
  const prefix = `floot-private-turn-${sessionId.length}-${sessionId}-`;
  const manifestName = `${prefix}migration-manifest`;
  const readyName = `${prefix}migration-ready`;
  const resolutionName = `${prefix}migration-resolution`;
  const names = new Set(await E(host).list());
  /** @param {unknown} name */
  const assertEventName = name => {
    (typeof name === 'string' && /^floot-turn-event-\d{20}$/.test(name)) ||
      Fail`Invalid private journal event name`;
    return /** @type {string} */ (name);
  };
  /** @type {{ names: string[], required: boolean }} */
  let anchor;
  if (names.has(manifestName)) {
    anchor = await E(host).lookup(manifestName);
  } else {
    // Orphaned private writes without a manifest cannot safely establish a new
    // migration baseline. Fail closed instead of adopting them.
    ![...names].some(name => name.startsWith(prefix)) ||
      Fail`Private journal migration anchor missing`;
    /** @type {string[]} */
    const importedNames = (await E(legacyGuest).list())
      .filter(name => typeof name === 'string' && name.startsWith(EVENT_PREFIX))
      .sort();
    anchor = {
      names: importedNames,
      required: legacyRequired || importedNames.length > 0,
    };
  }
  (anchor && typeof anchor.required === 'boolean') ||
    Fail`Invalid private journal migration provenance`;
  const manifest = anchor.names;
  (Array.isArray(manifest) && manifest.length <= 10_000) ||
    Fail`Invalid private journal migration manifest`;
  anchor.required ||
    manifest.length === 0 ||
    Fail`Legacy journal evidence requires migration acknowledgment`;
  manifest.forEach((name, index) => {
    name === `${EVENT_PREFIX}${`${index + 1}`.padStart(20, '0')}` ||
      Fail`Legacy turn journal sequence is missing or malformed`;
  });
  if (!names.has(manifestName)) {
    await E(host).storeValue(harden(anchor), manifestName);
    names.add(manifestName);
  }
  if (!names.has(readyName)) {
    for (const name of manifest) {
      const target = `${prefix}${name}`;
      if (!names.has(target)) {
        // A lost acknowledgement is recovered by testing target presence on
        // the next incarnation; never replace an immutable copied event.
        // Sequential copying bounds memory and makes the durable prefix clear.
        // eslint-disable-next-line no-await-in-loop
        const value = await E(legacyGuest).lookup(name);
        // eslint-disable-next-line no-await-in-loop
        await E(host).storeValue(value, target);
        names.add(target);
      }
    }
    await E(host).storeValue(true, readyName);
    names.add(readyName);
  } else {
    (await E(host).lookup(readyName)) === true ||
      Fail`Invalid private journal migration anchor`;
    manifest.every(name => names.has(`${prefix}${name}`)) ||
      Fail`Private journal migration lost an imported event`;
  }
  let resolution = names.has(resolutionName)
    ? await E(host).lookup(resolutionName)
    : undefined;
  const assertNote = note => {
    (typeof note === 'string' &&
      note.trim().length > 0 &&
      note.length <= 8192) ||
      Fail`Migration resolution requires a nonempty note of at most 8192 characters`;
  };
  if (resolution !== undefined) assertNote(resolution);
  let poisoned = false;
  let queue = Promise.resolve();
  /** @param {() => Promise<any>} operation */
  const serialized = operation => {
    const result = queue.then(async () => {
      !poisoned || Fail`Private journal unavailable after uncertain storage`;
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  /**
   * @param {unknown} value
   * @param {string} name
   */
  const store = async (value, name) => {
    try {
      await E(host).storeValue(value, name);
      names.add(name);
    } catch (error) {
      poisoned = true;
      throw error;
    }
  };
  const storage = Far('FactoryPrivateTurnStorage', {
    list: () =>
      serialized(async () =>
        harden(
          [...names]
            .filter(name => name.startsWith(`${prefix}${EVENT_PREFIX}`))
            .map(name => name.slice(prefix.length)),
        ),
      ),
    lookup: name =>
      serialized(async () =>
        E(host).lookup(`${prefix}${assertEventName(name)}`),
      ),
    storeValue: (value, name) =>
      serialized(async () => {
        const target = `${prefix}${assertEventName(name)}`;
        !names.has(target) || Fail`Private journal events are immutable`;
        await store(value, target);
      }),
  });
  const migration = harden({
    status: () =>
      serialized(async () =>
        harden({
          required: anchor.required,
          ...(resolution === undefined ? {} : { resolution }),
        }),
      ),
    resolve: note =>
      serialized(async () => {
        assertNote(note);
        anchor.required || Fail`No legacy journal migration to resolve`;
        resolution === undefined ||
          Fail`Legacy journal migration already resolved`;
        await store(note, resolutionName);
        resolution = note;
      }),
  });
  return harden({ storage, migration });
};
harden(providePrivateTurnStorage);
