// @ts-check

/** @import { EndoGuest, EndoHost } from '@endo/daemon' */

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeEndoProvisionSpec } from '../src/code-mode-provision-policy.js';
import { provideEndoCodeModeGuest } from '../src/code-mode-provision-host.js';

/**
 * The host adapter only needs the daemon host's `provision` exo method; all
 * realization internals (alias pinning, retained-policy checks, recovery)
 * are daemon-owned and covered by the daemon's own tests.
 *
 * @param {Partial<EndoHost>} [overrides]
 */
const makeHost = (overrides = {}) => {
  /** @type {Array<{ name: any, options: any }>} */
  const provideCalls = [];
  const guest = /** @type {EndoGuest} */ (
    /** @type {unknown} */ (harden({ fake: 'guest' }))
  );
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ ({
      provideGuest: async (name, options) => {
        provideCalls.push({ name, options });
        return guest;
      },
      has: async () => true,
      lookup: async () => harden({}),
      ...overrides,
    })
  );
  return { host, guest, provideCalls };
};

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-host-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('adapter provides named authority on an existing host', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost();
  const persistence = await normalizeEndoProvisionSpec(
    {
      introducedNames: { 'calendar-service': 'calendar' },
    },
    { harness: 'test', sessionId: 'pinned-grant', cwd: root },
  );

  const guest = await provideEndoCodeModeGuest(fixture.host, persistence);

  t.is(guest, fixture.guest);
  t.is(fixture.provideCalls.length, 1);
  const [{ name, options }] = fixture.provideCalls;
  t.is(name, persistence.guestName);
  t.deepEqual(options.authority, persistence.authority);
  t.deepEqual(options.introducedNames, {
    'calendar-service': 'calendar',
  });
  // Code-mode prompt context never enters the daemon policy record.
});

test('adapter backs read-only root Git with an unintroduced internal mount', async t => {
  const root = await makeWorkspace(t);
  /** @type {unknown[][]} */
  const mountCalls = [];
  /** @type {unknown[][]} */
  const gitCalls = [];
  const mount = harden({});
  const names = new Set();
  const fixture = makeHost({
    has: async name => names.has(/** @type {string} */ (name)),
    provideMount: async (...args) => {
      mountCalls.push(args);
      names.add(/** @type {string} */ (args[1]));
      return /** @type {any} */ (mount);
    },
    provideGit: async (...args) => {
      gitCalls.push(args);
      names.add(/** @type {string} */ (args[1]));
      return /** @type {any} */ (harden({}));
    },
  });
  const persistence = await normalizeEndoProvisionSpec(
    { git: 'readOnly' },
    { harness: 'test', sessionId: 'git-only-host', cwd: root },
  );
  const { internalGit } = persistence;
  if (internalGit === undefined) {
    throw Error('expected internal Git backing');
  }

  await provideEndoCodeModeGuest(fixture.host, persistence);
  await provideEndoCodeModeGuest(fixture.host, persistence);

  t.deepEqual(mountCalls, [
    [await realpath(root), internalGit.mountName, { readOnly: true }],
  ]);
  t.deepEqual(gitCalls, [
    [
      mount,
      internalGit.gitName,
      {
        readOnly: true,
        allowHistoryRewrite: false,
      },
    ],
  ]);
  t.deepEqual(fixture.provideCalls[0].options.introducedNames, {
    [internalGit.gitName]: 'git',
  });
  t.is(fixture.provideCalls.length, 2);
});

test('fork options project the parent record and pin session context', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost();
  const spec = {
    introducedNames: { service: 'calendar' },
  };
  const parent = await normalizeEndoProvisionSpec(spec, {
    harness: 'test',
    sessionId: 'fork-parent',
    cwd: root,
  });
  const child = await normalizeEndoProvisionSpec(spec, {
    harness: 'test',
    sessionId: 'fork-child',
    cwd: root,
  });

  await provideEndoCodeModeGuest(fixture.host, child, { forkFrom: parent });
  t.is(fixture.provideCalls.length, 1);
  t.is(fixture.provideCalls[0].name, child.guestName);

  await provideEndoCodeModeGuest(fixture.host, child, {
    forkFrom: parent,
  });
  t.is(fixture.provideCalls.length, 2);
});

test('host provisioning failures pass through untouched', async t => {
  const root = await makeWorkspace(t);
  const failure = Error('daemon rejected the record');
  const fixture = makeHost({
    provideGuest: async () => {
      throw failure;
    },
  });
  const persistence = await normalizeEndoProvisionSpec(undefined, {
    harness: 'test',
    sessionId: 'provision-failure',
    cwd: root,
  });

  const error = await t.throwsAsync(() =>
    provideEndoCodeModeGuest(fixture.host, persistence),
  );
  t.is(error, failure);
});

test('adapter classifies daemon credential availability failures', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost({
    provideGuest: async () => {
      throw Error('ENDO_CREDENTIAL_UNAVAILABLE: credential is unavailable');
    },
  });
  const persistence = await normalizeEndoProvisionSpec(undefined, {
    harness: 'test',
    sessionId: 'credential-failure',
    cwd: root,
  });
  const error = await t.throwsAsync(() =>
    provideEndoCodeModeGuest(fixture.host, persistence),
  );
  t.is(
    /** @type {{ code?: string }} */ (error).code,
    'ENDO_CREDENTIAL_UNAVAILABLE',
  );
});

test('adapter requires introduced sources before retaining the guest', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost({ has: async () => false });
  const persistence = await normalizeEndoProvisionSpec(
    { introducedNames: { missing: 'tool' } },
    { harness: 'test', sessionId: 'missing-source', cwd: root },
  );
  await t.throwsAsync(
    () => provideEndoCodeModeGuest(fixture.host, persistence),
    { message: /introduced source.*is unavailable/ },
  );
  t.deepEqual(fixture.provideCalls, []);
});
