// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

/** @param {string} sessionId */
const privatePrefix = sessionId => {
  (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) ||
    Fail`Invalid journal session ID`;
  // The length disambiguates IDs that are prefixes of other session IDs.
  return `floot-private-turn-${sessionId.length}-${sessionId}-`;
};

/**
 * Create a new journal namespace, never adopt or overwrite an existing one.
 * The factory must reserve this ID and check registry/guest aliases first.
 * These checks require one factory writer, not concurrent independent factories.
 * A rejected write may have committed: retain that namespace for inspection,
 * and use a new ID for the next creation attempt.
 *
 * @param {any} host
 * @param {string} sessionId
 */
export const createPrivateTurnStorage = async (host, sessionId) => {
  const prefix = privatePrefix(sessionId);
  const names = await E(host).list();
  !names.some(name => name.startsWith(prefix)) ||
    Fail`Private journal namespace already exists`;
  await E(host).storeValue(
    harden({ version: 1, sessionId }),
    `${prefix}schema`,
  );
};
harden(createPrivateTurnStorage);

/** @param {unknown} name */
const assertJournalName = name => {
  (typeof name === 'string' &&
    /^floot-turn-(event-\d{20}|content-\d{20}-[a-z]+|snapshot-\d{20}|archive-\d{20})$/.test(
      name,
    )) ||
    Fail`Invalid private journal value name`;
  return /** @type {string} */ (name);
};

/**
 * @param {any} schema
 * @param {string} sessionId
 */
const assertSchema = (schema, sessionId) => {
  (schema !== null &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    Reflect.ownKeys(schema).length === 2 &&
    Object.hasOwn(schema, 'version') &&
    Object.hasOwn(schema, 'sessionId') &&
    schema.version === 1 &&
    schema.sessionId === sessionId) ||
    Fail`Invalid private journal schema; session reset required`;
};

/**
 * Terminal deletion only, after the factory has durably recorded deletion
 * intent and stopped all writers/backends and closed their storage facets.
 * The schema is removed last, so partial removal can be retried. This function
 * is not a writer fence and must never be used by ordinary incarnation cleanup.
 * Unknown or ownerless data is retained for operator inspection.
 * @param {any} host
 * @param {string} sessionId
 */
export const retirePrivateTurnStorage = async (host, sessionId) => {
  const prefix = privatePrefix(sessionId);
  const names = (await E(host).list()).filter(name => name.startsWith(prefix));
  if (names.length === 0) return;
  const schemaName = `${prefix}schema`;
  names.includes(schemaName) ||
    Fail`Private journal retirement requires its schema`;
  assertSchema(await E(host).lookup(schemaName), sessionId);
  const values = names.filter(name => name !== schemaName);
  // Validate the whole namespace before removing any of it.
  for (const name of values) assertJournalName(name.slice(prefix.length));
  for (const name of values) {
    // eslint-disable-next-line no-await-in-loop
    await E(host).remove(name);
  }
  await E(host).remove(schemaName);
};
harden(retirePrivateTurnStorage);

/**
 * Open factory-owned journal storage. Never introduce this facet into a guest.
 * Full-control administrators holding the factory host remain trusted: this
 * separates ordinary guests, not principals deliberately granted that host.
 * Opening never imports guest history or creates missing schema.
 * One factory writer per session is required.
 *
 * @param {any} host
 * @param {string} sessionId
 */
export const providePrivateTurnStorage = async (host, sessionId) => {
  const prefix = privatePrefix(sessionId);
  const names = new Set(await E(host).list());
  ![...names].some(name => name.startsWith(`${prefix}migration-`)) ||
    Fail`Legacy private journal requires session reset`;
  const schemaName = `${prefix}schema`;
  names.has(schemaName) ||
    Fail`Private journal schema missing; session reset required`;
  const schema = await E(host).lookup(schemaName);
  assertSchema(schema, sessionId);
  let poisoned = false;
  let closed = false;
  let queue = Promise.resolve();
  /** @param {() => Promise<any>} operation */
  const serialized = operation => {
    !closed || Fail`Private journal incarnation is closed`;
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
  return Far('FactoryPrivateTurnStorage', {
    close: async () => {
      closed = true;
      await queue;
      !poisoned || Fail`Private journal unavailable after uncertain storage`;
    },
    list: () =>
      serialized(async () =>
        harden(
          [...names]
            .filter(name => name.startsWith(`${prefix}floot-turn-`))
            .map(name => name.slice(prefix.length)),
        ),
      ),
    lookup: name =>
      serialized(async () =>
        E(host).lookup(`${prefix}${assertJournalName(name)}`),
      ),
    storeValue: (value, name) =>
      serialized(async () => {
        const target = `${prefix}${assertJournalName(name)}`;
        !names.has(target) || Fail`Private journal values are immutable`;
        try {
          await E(host).storeValue(value, target);
          names.add(target);
        } catch (error) {
          poisoned = true;
          throw error;
        }
      }),
    // The journal removes only what a durable snapshot already covers. A
    // failure costs a stray value, not ambiguous history, and does not poison.
    remove: name =>
      serialized(async () => {
        const target = `${prefix}${assertJournalName(name)}`;
        names.has(target) || Fail`Unknown private journal value`;
        await E(host).remove(target);
        names.delete(target);
      }),
  });
};
harden(providePrivateTurnStorage);
