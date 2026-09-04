// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { make } from '../caplet.js';

/**
 * Instantiate the caplet over a fresh spool directory, torn down with the test.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} [env]
 */
const makeCaplet = async (t, env = {}) => {
  const deployDir = await mkdtemp(join(tmpdir(), 'endo-mgmt-'));
  t.teardown(() => rm(deployDir, { recursive: true, force: true }));
  const controller = await make(undefined, undefined, {
    env: { ENDO_DEPLOY_DIR: deployDir, ...env },
  });
  return { controller, deployDir };
};

/**
 * @param {string} deployDir
 * @returns {Promise<any>}
 */
const readRequest = async deployDir =>
  JSON.parse(await readFile(join(deployDir, 'request.json'), 'utf8'));

test('getStatus reports the configured host settings', async t => {
  const { controller } = await makeCaplet(t, {
    ENDO_MGMT_REPO_URL: 'https://example.invalid/endo.git',
    ENDO_MGMT_DEFAULT_BRANCH: 'main',
  });

  const { config, status } = await controller.getStatus();
  t.true(config.configured);
  t.is(config.repoUrl, 'https://example.invalid/endo.git');
  t.is(config.defaultBranch, 'main');
  t.is(status, null, 'no status file yet');
});

test('getStatus surfaces the deployer status and tolerates a torn file', async t => {
  const { controller, deployDir } = await makeCaplet(t);
  const statusPath = join(deployDir, 'status.json');

  await writeFile(statusPath, JSON.stringify({ phase: 'ok', rev: 'abc123' }));
  t.like(await controller.getStatus(), { status: { phase: 'ok' } });

  // The deployer writes this file concurrently; a half-written read must not
  // take the whole view down.
  await writeFile(statusPath, '{"phase": "buil');
  t.is((await controller.getStatus()).status, null);
});

test('requestUpdate spools a deploy request for the default branch', async t => {
  const { controller, deployDir } = await makeCaplet(t, {
    ENDO_MGMT_DEFAULT_BRANCH: 'main',
  });

  await controller.requestUpdate();
  const request = await readRequest(deployDir);
  t.is(request.action, 'deploy');
  t.is(request.branch, 'main');
  t.truthy(request.nonce);
});

test('requestUpdate accepts an explicit branch and trims it', async t => {
  const { controller, deployDir } = await makeCaplet(t);

  await controller.requestUpdate('  feature/some-work  ');
  t.is((await readRequest(deployDir)).branch, 'feature/some-work');
});

test('each request carries a distinct nonce', async t => {
  const { controller, deployDir } = await makeCaplet(t);

  await controller.requestUpdate('main');
  const first = await readRequest(deployDir);
  await controller.requestUpdate('main');
  const second = await readRequest(deployDir);
  t.not(first.nonce, second.nonce, 'the deployer must see a changed request');
});

test('requestRestart spools a restart request', async t => {
  const { controller, deployDir } = await makeCaplet(t);

  await controller.requestRestart();
  const request = await readRequest(deployDir);
  t.is(request.action, 'restart');
  t.truthy(request.nonce);
});

test('the spool never retains a scratch file', async t => {
  const { controller, deployDir } = await makeCaplet(t);

  await Promise.all([
    controller.requestUpdate('main'),
    controller.requestUpdate('main'),
    controller.requestRestart(),
  ]);

  const entries = await readdir(deployDir);
  t.deepEqual(
    entries.filter(name => name.endsWith('.tmp')),
    [],
    'write-then-rename leaves no partial request behind',
  );
  // Whichever request won the rename, the published file is whole.
  t.truthy((await readRequest(deployDir)).action);
});

test('requestUpdate rejects branch names that could be read as git options', async t => {
  const { controller, deployDir } = await makeCaplet(t);

  await t.throwsAsync(controller.requestUpdate('--upload-pack'), {
    message: /must not start with/,
  });
  await t.throwsAsync(controller.requestUpdate('-x'), {
    message: /must not start with/,
  });

  await t.throwsAsync(readRequest(deployDir), {
    message: /ENOENT/,
    instanceOf: Error,
  });
});

test('requestUpdate rejects branch names that escape a directory', async t => {
  const { controller } = await makeCaplet(t);

  for (const branch of ['../etc/passwd', 'a/../../b', '..']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(controller.requestUpdate(branch), {
      message: /must not contain/,
      instanceOf: Error,
    });
  }
});

test('requestUpdate rejects otherwise malformed refs', async t => {
  const { controller } = await makeCaplet(t);

  /** @type {Array<[string, RegExp]>} */
  const cases = [
    ['has space', /may only contain/],
    ['semi;colon', /may only contain/],
    ['branch=value', /may only contain/],
    ['a//b', /empty path component/],
    ['/leading', /empty path component/],
    ['trailing/', /empty path component/],
    ['.hidden', /must not start with/],
    ['feature/.hidden', /must not start with/],
    ['feature/x.lock', /must not end with/],
    ['x'.repeat(256), /1 to 255 characters/],
  ];

  for (const [branch, message] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      controller.requestUpdate(branch),
      { message, instanceOf: Error },
      `expected ${branch} to be rejected`,
    );
  }
});

test.serial(
  'an unconfigured daemon reports itself and refuses to act',
  async t => {
    // `readEnv` falls back to the ambient environment for any key it is handed
    // empty, so clear the real variable rather than assuming the test host has
    // none set.
    const saved = process.env.ENDO_DEPLOY_DIR;
    delete process.env.ENDO_DEPLOY_DIR;
    t.teardown(() => {
      if (saved !== undefined) {
        process.env.ENDO_DEPLOY_DIR = saved;
      }
    });

    const controller = await make(undefined, undefined, {
      env: { ENDO_DEPLOY_DIR: '' },
    });

    const { config, status } = await controller.getStatus();
    t.false(config.configured);
    t.is(status, null);
    t.is(await controller.getLog(), '');

    await t.throwsAsync(controller.requestUpdate('main'), {
      message: /not configured/,
      instanceOf: Error,
    });
    await t.throwsAsync(controller.requestRestart(), {
      message: /not configured/,
      instanceOf: Error,
    });
  },
);

test('getLog returns only the tail of the log', async t => {
  const { controller, deployDir } = await makeCaplet(t);
  const body = `${'a'.repeat(1000)}${'b'.repeat(1000)}`;
  await writeFile(join(deployDir, 'deploy.log'), body);

  const tail = await controller.getLog(500);
  t.is(tail.length, 500);
  t.is(tail, 'b'.repeat(500), 'the tail, not the head');

  t.is(await controller.getLog(10_000), body, 'a short log comes back whole');
});

test('getLog clamps a nonsensical size instead of trusting it', async t => {
  const { controller, deployDir } = await makeCaplet(t);
  await writeFile(join(deployDir, 'deploy.log'), 'hello');

  t.is(await controller.getLog(0), '');
  t.is(await controller.getLog(-1), '');
  t.is(await controller.getLog(Number.NaN), '');
  t.is(await controller.getLog(Number.POSITIVE_INFINITY), 'hello');
});

test('getLog is empty when there is no log yet', async t => {
  const { controller } = await makeCaplet(t);
  t.is(await controller.getLog(), '');
});
