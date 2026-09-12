// @ts-check
import '@endo/init';
import test from 'ava';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from '../src/current-specifier.js';

const RELATIVE_MODULE =
  'packages/opencode-sandbox/src/managed-credentials-module.js';

/**
 * Lay out `<stateDir>/releases/<id>/<RELATIVE_MODULE>` and (optionally) the
 * `<stateDir>/current -> releases/<id>` symlink the hosted deploy maintains.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ id: string, withCurrent: boolean }} options
 */
const layout = async (t, { id, withCurrent }) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'endo-current-'));
  t.teardown(() => rm(stateDir, { recursive: true, force: true }));
  const modulePath = path.join(stateDir, 'releases', id, RELATIVE_MODULE);
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(modulePath, '// module\n');
  if (withCurrent) {
    await symlink(path.join('releases', id), path.join(stateDir, 'current'));
  }
  return { stateDir, modulePath };
};

test('reroutes a release-pinned URL through the current symlink', async t => {
  const id = '20260728-132501-64fba72e1165';
  const { stateDir, modulePath } = await layout(t, { id, withCurrent: true });
  const releaseUrl = pathToFileURL(modulePath).href;
  const expected = pathToFileURL(
    path.join(stateDir, 'current', RELATIVE_MODULE),
  ).href;
  t.is(toCurrentSpecifier(releaseUrl), expected);
});

test('returns the URL unchanged when it has no releases/<id>/ segment', t => {
  const url = pathToFileURL(
    '/home/dev/endo/packages/opencode-sandbox/src/managed-credentials-module.js',
  ).href;
  t.is(toCurrentSpecifier(url), url);
});

test('keeps the release path when the current twin does not resolve', async t => {
  const id = '20260728-132501-deadbeefcafe';
  const { modulePath } = await layout(t, { id, withCurrent: false });
  const releaseUrl = pathToFileURL(modulePath).href;
  t.is(toCurrentSpecifier(releaseUrl), releaseUrl);
});

test('assertCurrentSpecifier passes a dev-checkout or current-rerouted URL', async t => {
  const devUrl = pathToFileURL(
    '/home/dev/endo/packages/opencode-sandbox/src/managed-credentials-module.js',
  ).href;
  t.is(assertCurrentSpecifier(devUrl, 'test'), devUrl);

  const id = '20260728-132501-64fba72e1165';
  const { modulePath } = await layout(t, { id, withCurrent: true });
  const rerouted = toCurrentSpecifier(pathToFileURL(modulePath).href);
  t.not(rerouted, pathToFileURL(modulePath).href, 'layout actually rerouted');
  t.is(assertCurrentSpecifier(rerouted, 'test'), rerouted);
});

test('assertCurrentSpecifier fails closed on an unrouted release-pinned URL', async t => {
  const id = '20260728-132501-deadbeefcafe';
  const { modulePath } = await layout(t, { id, withCurrent: false });
  const releaseUrl = pathToFileURL(modulePath).href;
  // toCurrentSpecifier keeps the concrete release here; setup must abort
  // rather than store a path that dangles once the release is pruned.
  t.is(toCurrentSpecifier(releaseUrl), releaseUrl);
  t.throws(() => assertCurrentSpecifier(releaseUrl, 'managed-credentials'), {
    message: /pinned to a concrete release/,
  });
});
