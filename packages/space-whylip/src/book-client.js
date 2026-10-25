// @ts-check

import { E } from '@endo/eventual-send';

import { makeAuthorName } from './author-name.js';
import { WHYLIP_SYSTEM_PROMPT } from './prompt.js';
import { STARTER_SCENE, STARTER_STATE } from './starter-scene.js';

/** @import { WhylipEnvironment } from './environment-types.js' */

/** @type {WeakMap<object, Promise<any>>} */
const connections = new WeakMap();

/**
 * Provision a book in its own host profile and introduce only the book facet
 * to its Fae guest. Reopening an existing book preserves its files and state.
 *
 * @param {any} powers
 * @param {string} [moduleUrl]
 * @returns {Promise<any>}
 */
export const ensureBook = (
  powers,
  moduleUrl = /** @type {WhylipEnvironment | undefined} */ (import.meta.env)
    ?.WHYLIP_BOOK_PATH,
) => {
  const existing = connections.get(powers);
  if (existing) return existing;
  const connect = async () => {
    let book;
    if (await E(powers).has('book')) {
      book = await E(powers).lookup('book');
    } else {
      if (!moduleUrl) {
        throw Error(
          'The book runtime is unavailable. Rebuild the chat application to enable Whylip.',
        );
      }
      book = await E(powers).makeUnconfined('@node', moduleUrl, {
        powersName: '@agent',
        resultName: 'book',
        env: harden({ bookId: 'main' }),
      });
    }
    await E(book).initialize(STARTER_SCENE, STARTER_STATE);
    const agent = await E(powers).lookup('fae');
    const locator = await E(powers).locate('book');
    await E(agent).storeLocator('book', locator);
    return book;
  };
  const result = connect().catch(error => {
    connections.delete(powers);
    throw error;
  });
  connections.set(powers, result);
  return result;
};
harden(ensureBook);

/**
 * Resume book creation after any partial failure. The durable book profile
 * anchors the author identity, independently of the factory's namespace.
 * @param {any} powers
 * @param {string} name
 * @param {string} factoryPetName
 * @param {string} [moduleUrl]
 */
export const provisionBook = async (
  powers,
  name,
  factoryPetName,
  moduleUrl,
) => {
  const profileName = `whylip-${name}`;
  const hasProfile = await E(powers).has(profileName);
  const profile = hasProfile
    ? await E(powers).lookup(profileName)
    : await E(powers).provideHost(name, { agentName: profileName });

  if (!(await E(profile).has('fae'))) {
    const factory = await E(powers).lookup(factoryPetName);
    const agentName = makeAuthorName(await E(profile).locate('@self'), 'story');
    const created = await E(factory).createAgentCapability(
      agentName,
      harden({
        systemPrompt: WHYLIP_SYSTEM_PROMPT,
        pin: true,
        maxSubagentDepth: 0,
      }),
    );
    await E(profile).storeLocator('fae', created.locator);
  }
  await E(profile).storeLocator(
    'fae-factory',
    await E(powers).locate(factoryPetName),
  );
  await ensureBook(profile, moduleUrl);
  return harden({ profilePath: [profileName] });
};
harden(provisionBook);
