// @ts-check

/** @import { EndoGuest, EndoHost } from '@endo/daemon' */

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { provideEndoCodeModeGuest } from '../src/code-mode-provision-host.js';
import { normalizeEndoProvisionSpec } from '../src/code-mode-provision-policy.js';

/**
 * @param {string[]} [presentNames]
 * @param {Partial<EndoHost>} [overrides]
 */
const makeHost = (presentNames = [], overrides = {}) => {
  /** @type {Array<{ name: any, options: any }>} */
  const provideCalls = [];
  const values = new Map();
  const guest = /** @type {EndoGuest} */ (
    /** @type {unknown} */ (
      harden({
        has: async (...path) => presentNames.includes(path.join('/')),
      })
    )
  );
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ ({
      provideGuest: async (name, options) => {
        provideCalls.push({ name, options });
        return guest;
      },
      has: async (...path) => values.has(path.join('/')),
      lookup: async path =>
        values.get((Array.isArray(path) ? path : [path]).join('/')),
      storeValue: async (value, path) => {
        values.set((Array.isArray(path) ? path : [path]).join('/'), value);
      },
      ...overrides,
    })
  );
  return { host, guest, provideCalls, values };
};

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-host-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('adapter stores policy projection in host state, not caller persistence', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost(['workspace', 'repo', 'calendar']);
  const request = await normalizeEndoProvisionSpec(
    {
      mount: { workspace: { path: '.', mode: 'readWrite' } },
      git: {
        repo: { mount: 'workspace', path: [], mode: 'readWrite' },
      },
      introducedNames: { 'calendar-service': 'calendar' },
    },
    { harness: 'test', sessionId: 'pinned-grant', cwd: root },
  );

  const projection = await provideEndoCodeModeGuest(
    fixture.host,
    request.persistence,
    { request },
  );

  t.is(projection.guest, fixture.guest);
  t.deepEqual(
    projection.globals.map(({ name }) => name),
    ['workspace', 'repo', 'calendar'],
  );
  t.deepEqual(fixture.provideCalls, [
    {
      name: request.persistence.guestName,
      options: {
        authority: request.authority,
        introducedNames: { 'calendar-service': 'calendar' },
      },
    },
  ]);
  t.deepEqual(Object.keys(request.persistence), ['version', 'guestName']);
  t.is(fixture.values.size, 1);
  t.deepEqual(Object.keys([...fixture.values.values()][0]), [
    'version',
    'authority',
    'introducedNames',
  ]);
});

test('opaque reconstruction reacquires guest and host-owned globals', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost(['workspace']);
  const request = await normalizeEndoProvisionSpec(
    { mount: { workspace: { path: '.', mode: 'readOnly' } } },
    { harness: 'test', sessionId: 'reconstruct', cwd: root },
  );
  const first = await provideEndoCodeModeGuest(
    fixture.host,
    request.persistence,
    { request },
  );
  const reconstructed = await provideEndoCodeModeGuest(
    fixture.host,
    request.persistence,
  );

  t.deepEqual(reconstructed.globals, first.globals);
  t.deepEqual(fixture.provideCalls[1], {
    name: request.persistence.guestName,
    options: undefined,
  });
});

test('missing introduced sources are ignored and projected when later present', async t => {
  const root = await makeWorkspace(t);
  const presentNames = [];
  const fixture = makeHost(presentNames);
  const request = await normalizeEndoProvisionSpec(
    { introducedNames: { missing: 'optionalTool' } },
    { harness: 'test', sessionId: 'missing-source', cwd: root },
  );

  const projection = await provideEndoCodeModeGuest(
    fixture.host,
    request.persistence,
    { request },
  );

  t.deepEqual(projection.globals, []);
  t.deepEqual(fixture.provideCalls[0].options.introducedNames, {
    missing: 'optionalTool',
  });

  presentNames.push('optionalTool');
  const reconstructed = await provideEndoCodeModeGuest(
    fixture.host,
    request.persistence,
  );
  t.deepEqual(
    reconstructed.globals.map(({ name }) => name),
    ['optionalTool'],
  );
});

test('fork inherits daemon-owned parent state under a new opaque name', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost(['workspace']);
  const parent = await normalizeEndoProvisionSpec(
    { mount: { workspace: { path: '.', mode: 'readOnly' } } },
    { harness: 'test', sessionId: 'fork-parent', cwd: root },
  );
  const child = await normalizeEndoProvisionSpec(undefined, {
    harness: 'test',
    sessionId: 'fork-child',
    cwd: root,
  });
  await provideEndoCodeModeGuest(fixture.host, parent.persistence, {
    request: parent,
  });
  const forked = await provideEndoCodeModeGuest(
    fixture.host,
    child.persistence,
    { forkFrom: parent.persistence },
  );

  t.deepEqual(
    forked.globals.map(({ name }) => name),
    ['workspace'],
  );
  t.deepEqual(fixture.provideCalls[1].options.authority, parent.authority);
});

test('host provisioning failures pass through untouched', async t => {
  const root = await makeWorkspace(t);
  const failure = Error('daemon rejected the record');
  const fixture = makeHost([], {
    provideGuest: async () => {
      throw failure;
    },
  });
  const request = await normalizeEndoProvisionSpec(undefined, {
    harness: 'test',
    sessionId: 'provision-failure',
    cwd: root,
  });

  const error = await t.throwsAsync(() =>
    provideEndoCodeModeGuest(fixture.host, request.persistence, { request }),
  );
  t.is(error, failure);
});
