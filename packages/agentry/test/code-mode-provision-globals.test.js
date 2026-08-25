// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeEndoProvisionGlobals } from '../src/code-mode-provision-globals.js';

test('globals project every singular object-key binding', t => {
  const globals = makeEndoProvisionGlobals(
    harden({
      authority: {
        mount: {
          workspace: {
            path: '/workspace',
            readOnly: false,
          },
          docs: { path: '/workspace/docs', readOnly: true },
        },
        git: {
          repo: { mount: 'workspace', path: [], readOnly: false },
          docsHistory: { mount: 'docs', path: [], readOnly: true },
        },
        gitRemote: {
          originCap: {
            git: 'repo',
            name: 'origin',
            url: 'https://example.test/repo.git',
          },
          mirrorCap: {
            git: 'repo',
            name: 'mirror',
            url: 'https://mirror.example.test/repo.git',
          },
        },
      },
      introducedNames: { 'calendar-service': 'calendar' },
    }),
  );
  t.deepEqual(
    globals.map(({ name }) => name),
    [
      'workspace',
      'docs',
      'repo',
      'docsHistory',
      'originCap',
      'mirrorCap',
      'calendar',
    ],
  );
  for (const global of globals.slice(0, 6)) {
    t.truthy(global.declaration);
  }
  t.is(globals[6].declaration, undefined);
});

test('introduced names retain host-key to guest-value direction', t => {
  const globals = makeEndoProvisionGlobals(
    harden({ authority: {}, introducedNames: { service: 'calendar' } }),
  );
  t.deepEqual(globals, [
    { name: 'calendar', petName: 'calendar', description: undefined },
  ]);
});
