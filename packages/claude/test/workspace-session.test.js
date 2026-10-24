// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { provisionEndoClaudeGuest } from '../src/workspace-session.js';

const grants = harden({
  workspace: 'host-workspace',
  git: 'host-git',
  remote: 'host-remote',
  shell: 'host-shell',
});

/**
 * @param {string} name
 * @param {Record<string, (...methodArguments: any[]) => any>} methods
 */
const makeFake = (name, methods) =>
  makeExo(
    name,
    M.interface(name, {}, { defaultGuards: 'passable' }),
    /** @type {any} */ (methods),
  );

/**
 * @param {'host' | 'sandbox'} engine
 */
const makeFixture = engine => {
  /** @type {unknown[]} */
  const provideCalls = [];
  const shell = makeFake('Shell', {
    inspect: () =>
      harden({
        allowedCommands: ['make'],
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        engine,
      }),
  });
  const capabilities = harden({
    'host-workspace': makeFake('Workspace', {}),
    'host-git': makeFake('Git', {}),
    'host-remote': makeFake('GitRemote', {}),
    'host-shell': shell,
  });
  const guest = makeFake('EndoGuest', {});
  const host = makeFake('EndoHost', {
    has: name => Object.hasOwn(capabilities, name),
    lookup: name => capabilities[name],
    provideGuest: (handleName, options) => {
      provideCalls.push(harden({ handleName, options }));
      return guest;
    },
  });
  return { guest, host, provideCalls };
};

test('a sandbox-backed Shell is bound with the other workspace grants', async t => {
  const { guest, host, provideCalls } = makeFixture('sandbox');
  const provisioned = await provisionEndoClaudeGuest(host, {
    handleName: 'claude-handle',
    agentName: 'claude-guest',
    grants,
  });

  t.is(provisioned, guest);
  t.deepEqual(provideCalls, [
    {
      handleName: 'claude-handle',
      options: {
        agentName: 'claude-guest',
        introducedNames: {
          'host-workspace': 'workspace',
          'host-git': 'git',
          'host-remote': 'remote',
          'host-shell': 'shell',
        },
      },
    },
  ]);
});

test('a host-engine Shell is refused before a guest is provisioned', async t => {
  const { host, provideCalls } = makeFixture('host');

  await t.throwsAsync(
    provisionEndoClaudeGuest(host, {
      handleName: 'claude-handle',
      agentName: 'claude-guest',
      grants,
    }),
    { message: /not sandbox-backed.*refusing/ },
  );
  t.deepEqual(provideCalls, []);
});

test('missing or aliased grants fail before a guest is provisioned', async t => {
  const { host, provideCalls } = makeFixture('sandbox');

  await t.throwsAsync(
    provisionEndoClaudeGuest(host, {
      handleName: 'claude-handle',
      agentName: 'claude-guest',
      grants: { ...grants, remote: 'missing-remote' },
    }),
    { message: /missing host grants.*remote/ },
  );
  await t.throwsAsync(
    provisionEndoClaudeGuest(host, {
      handleName: 'claude-handle',
      agentName: 'claude-guest',
      grants: { ...grants, remote: grants.git },
    }),
    { message: /distinct host capability/ },
  );
  t.deepEqual(provideCalls, []);
});
