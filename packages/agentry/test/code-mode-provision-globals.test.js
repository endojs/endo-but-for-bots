// @ts-check

/** @import { EndoCodeModeProvisionPersistence } from '../src/code-mode-provisioning-types.js' */

import test from '@endo/ses-ava/prepare-endo.js';

import { makeEndoProvisionGlobals } from '../src/code-mode-provision-globals.js';

/**
 * @param {EndoCodeModeProvisionPersistence['authority']} authority
 * @param {Record<string, string>} [introducedNames]
 * @param {EndoCodeModeProvisionPersistence['internalGit']} [internalGit]
 * @returns {EndoCodeModeProvisionPersistence}
 */
const makePersistence = (
  authority,
  introducedNames = {},
  internalGit = undefined,
) =>
  harden({
    version: /** @type {3} */ (3),
    guestName: 'code-mode-test-session',
    authority,
    introducedNames,
    ...(internalGit === undefined ? {} : { internalGit }),
    spec: {},
  });

test('globals project validated policy without looking up guest bindings', t => {
  const globals = makeEndoProvisionGlobals(
    makePersistence(
      {
        mount: {
          workspace: {
            path: '/workspace',
            readOnly: false,
            deniedSegments: [],
          },
        },
        git: {
          git: {
            mount: 'workspace',
            path: [],
            readOnly: false,
          },
        },
      },
      { 'calendar-service': 'calendar' },
    ),
  );
  t.deepEqual(
    globals.map(({ name }) => name),
    ['workspace', 'git', 'calendar'],
  );
  t.truthy(globals[0].declaration);
  t.truthy(globals[1].declaration);
  t.is(globals[2].declaration, undefined);
});

test('introduced names retain host-key to guest-value direction', t => {
  const globals = makeEndoProvisionGlobals(
    makePersistence({}, { service: 'calendar' }),
  );
  t.deepEqual(globals, [
    { name: 'calendar', petName: 'calendar', description: undefined },
  ]);
});

test('internal read-only Git projects its typed compatibility global', t => {
  const internalGit = harden({
    path: '/workspace',
    mountName: 'internal-mount',
    gitName: 'internal-git',
  });
  const globals = makeEndoProvisionGlobals(
    makePersistence({}, { 'internal-git': 'git' }, internalGit),
  );
  t.is(globals.length, 1);
  t.is(globals[0].name, 'git');
  const { description } = globals[0];
  if (description === undefined) throw Error('expected Git description');
  t.regex(description, /Read-only .*Git capability/);
  t.truthy(globals[0].declaration);
});
