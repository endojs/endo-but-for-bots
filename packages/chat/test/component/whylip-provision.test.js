// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { provisionBook } from '../../../space-whylip/src/book-client.js';
import { makeBookSession } from '../../../space-whylip/src/book-session.js';
/* eslint-enable import/no-relative-packages */

for (const failurePoint of ['author-binding', 'book-introduction']) {
  test.serial(
    `book provisioning resumes after ${failurePoint} fails`,
    async t => {
      /** @type {Map<string, any>} */
      const persisted = new Map();
      const book = await makeBookSession(
        Far('ProvisionStorage', {
          list: async () => harden([...persisted.keys()]),
          lookup: async name => persisted.get(name),
          storeValue: async (value, name) => {
            persisted.set(name, value);
          },
        }),
        'provision-test',
      );
      await E(book).initialize(
        '({h}) => h("p", {}, "Existing chapter")',
        harden({ chapter: 'river' }),
      );
      let hostCreations = 0;
      let agentCreations = 0;
      let factoryCalls = 0;
      let failOnce = true;
      /** @type {string | undefined} */
      let createdName;
      const bindings = new Set(['book']);
      const agentLocator = `endo://${'c'.repeat(64)}/${'d'.repeat(64)}?type=guest`;
      const agent = Far('ProvisionAuthor', {
        storeLocator: (name, locator) => {
          t.is(name, 'book');
          t.is(locator, 'book-locator');
          if (failurePoint === 'book-introduction' && failOnce) {
            failOnce = false;
            throw Error('Temporary book introduction failure');
          }
        },
      });
      const profile = Far('ProvisionProfile', {
        has: name => bindings.has(name),
        lookup: name => (name === 'book' ? book : agent),
        locate: name =>
          name === '@self'
            ? `endo://${'a'.repeat(64)}/${'b'.repeat(64)}?type=host`
            : 'book-locator',
        storeLocator: (name, locator) => {
          if (name === 'fae') {
            t.is(
              locator,
              agentLocator,
              'use returned locator, not a factory-local profile name',
            );
            if (failurePoint === 'author-binding' && failOnce) {
              failOnce = false;
              throw Error('Temporary author binding failure');
            }
          }
          bindings.add(name);
        },
      });
      const factory = Far('ProvisionFactory', {
        createAgentCapability: (name, options) => {
          factoryCalls += 1;
          t.true(options.pin);
          t.is(options.maxSubagentDepth, 0);
          t.regex(options.systemPrompt, /living interactive storybook/);
          if (createdName === undefined) {
            createdName = name;
            agentCreations += 1;
          } else
            t.is(
              name,
              createdName,
              'retry addresses the same dedicated author',
            );
          return harden({ locator: agentLocator, agent });
        },
      });
      const root = Far('ProvisionRoot', {
        has: name => name === 'whylip-forest' && hostCreations > 0,
        lookup: name => {
          if (name === 'factory') return factory;
          if (name === 'whylip-forest') return profile;
          throw Error('Factory profiles are not in this host namespace');
        },
        provideHost: (name, options) => {
          t.is(name, 'forest');
          t.is(options.agentName, 'whylip-forest');
          hostCreations += 1;
          return profile;
        },
        locate: name => {
          t.is(name, 'factory');
          return 'factory-locator';
        },
      });

      await t.throwsAsync(() => provisionBook(root, 'forest', 'factory'), {
        message: /Temporary/,
      });
      const result = await provisionBook(root, 'forest', 'factory');
      t.deepEqual(result.profilePath, ['whylip-forest']);
      t.is(hostCreations, 1);
      t.is(agentCreations, 1);
      t.is(factoryCalls, failurePoint === 'author-binding' ? 2 : 1);
      t.true(bindings.has('fae-factory'));
      const snapshot = await E(book).getSnapshot();
      t.is(snapshot.source, '({h}) => h("p", {}, "Existing chapter")');
      t.deepEqual(snapshot.state, { chapter: 'river' });
      t.regex(
        createdName || '',
        /^whylip-[0-9a-f]{56}$/,
        'author name fits the Fae identity limit',
      );
    },
  );
}
