// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeEndoProvisionSpec } from '../src/code-mode-provision-policy.js';

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-policy-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  return root;
};

test('normalization uses singular object-keyed authority categories', async t => {
  const root = await makeWorkspace(t);
  const request = await normalizeEndoProvisionSpec(
    {
      mount: {
        workspace: { path: '.', mode: 'readWrite' },
        docs: { path: 'docs', mode: 'readOnly' },
      },
      git: {
        repo: { mount: 'workspace', path: [], mode: 'readWrite' },
        docsHistory: { mount: 'docs', path: [], mode: 'readOnly' },
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
    { harness: 'test', sessionId: 'stable', cwd: root },
  );

  t.deepEqual(Object.keys(request.authority.mount ?? {}), [
    'workspace',
    'docs',
  ]);
  t.deepEqual(Object.keys(request.authority.git ?? {}), [
    'repo',
    'docsHistory',
  ]);
  t.deepEqual(Object.keys(request.authority.gitRemote ?? {}), [
    'originCap',
    'mirrorCap',
  ]);
  t.is(request.authority.mount?.workspace.path, await realpath(root));
  t.true(request.authority.mount?.docs.readOnly);
  t.is(request.authority.git?.repo.mount, 'workspace');
});

test('normalization rejects removed compatibility and plural fields', async t => {
  const root = await makeWorkspace(t);
  for (const spec of [
    { workspace: { path: '.', mode: 'readOnly' } },
    { mounts: {} },
    { gits: {} },
    { gitRemotes: {} },
    { git: 'readOnly' },
  ]) {
    // Each legacy form must fail independently.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        normalizeEndoProvisionSpec(/** @type {any} */ (spec), {
          harness: 'test',
          sessionId: JSON.stringify(spec),
          cwd: root,
        }),
      { message: /unknown field|ordinary copy record/ },
    );
  }
});

test('introducedNames validates direction but leaves missing-source behavior to provideGuest', async t => {
  const root = await makeWorkspace(t);
  const request = await normalizeEndoProvisionSpec(
    { introducedNames: { 'calendar-service': 'calendar', absent: 'optional' } },
    { harness: 'test', sessionId: 'introduced', cwd: root },
  );
  t.deepEqual(request.introducedNames, {
    'calendar-service': 'calendar',
    absent: 'optional',
  });
  t.true(Object.isFrozen(request.introducedNames));

  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { introducedNames: { 'tools/calendar': 'calendar' } },
        { harness: 'test', sessionId: 'bad-host', cwd: root },
      ),
    { message: /host names to guest names/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        { introducedNames: { first: 'tool', second: 'tool' } },
        { harness: 'test', sessionId: 'duplicate-guest', cwd: root },
      ),
    { message: /distinct guest binding/ },
  );
});

test('closed grant schemas reject unknown fields and embedded credentials', async t => {
  const root = await makeWorkspace(t);
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          mount: {
            workspace: /** @type {any} */ ({
              path: '.',
              mode: 'readOnly',
              ignored: true,
            }),
          },
        },
        { harness: 'test', sessionId: 'unknown', cwd: root },
      ),
    { message: /unknown field.*ignored/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          gitRemote: {
            origin: {
              git: 'repo',
              name: 'origin',
              url: 'https://user:password@example.test/repo.git',
            },
          },
        },
        { harness: 'test', sessionId: 'embedded-credential', cwd: root },
      ),
    { message: /must not embed credentials/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          gitRemote: {
            origin: /** @type {any} */ ({
              git: 'repo',
              name: 'origin',
              url: 'https://example.test/repo.git',
              allowedDirections: ['clone'],
            }),
          },
        },
        { harness: 'test', sessionId: 'bad-direction', cwd: root },
      ),
    { message: /allowedDirections/ },
  );
  await t.throwsAsync(
    () =>
      normalizeEndoProvisionSpec(
        {
          gitRemote: {
            origin: /** @type {any} */ ({
              git: 'repo',
              name: 'origin',
              url: 'https://example.test/repo.git',
              credential: { token: 'not-a-reference' },
            }),
          },
        },
        { harness: 'test', sessionId: 'credential-record', cwd: root },
      ),
    { message: /credential.*host pet name or name path/ },
  );
});

test('harmless secret-like query keys remain valid metadata', async t => {
  const root = await makeWorkspace(t);
  const request = await normalizeEndoProvisionSpec(
    {
      gitRemote: {
        origin: {
          git: 'repo',
          name: 'origin',
          url: 'https://example.test/repo?token_count=2&password_policy=strict',
        },
      },
    },
    { harness: 'test', sessionId: 'query-metadata', cwd: root },
  );
  t.regex(
    request.authority.gitRemote?.origin.url ?? '',
    /token_count=2&password_policy=strict/,
  );
});

test('normalization preserves an own __proto__ binding', async t => {
  const root = await makeWorkspace(t);
  const mount = JSON.parse('{"__proto__":{"path":"docs","mode":"readOnly"}}');
  const request = await normalizeEndoProvisionSpec(
    { mount },
    { harness: 'test', sessionId: 'own-proto', cwd: root },
  );
  t.true(Object.hasOwn(request.authority.mount ?? {}, '__proto__'));
});
