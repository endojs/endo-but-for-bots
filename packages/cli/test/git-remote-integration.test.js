// @ts-check

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import url from 'url';

import test from 'ava';
import { $ } from 'execa';

import { netListenAllowed } from './_net-permission.js';

const testSerial = netListenAllowed ? test.serial : test.serial.skip;
const packageDirectory = url.fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, '..', '..');
const cliBinaryDirectory = path.join(packageDirectory, 'bin');

testSerial('provision and inspect a bounded Git remote profile', async t => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'endo-git-remote-'),
  );
  const runtimeDirectory = path.join(temporaryRoot, 'run');
  const repositoryPath = path.join(temporaryRoot, 'repo');
  await Promise.all([
    fs.mkdir(path.join(temporaryRoot, 'state')),
    fs.mkdir(path.join(temporaryRoot, 'cache')),
    fs.mkdir(runtimeDirectory),
    fs.mkdir(repositoryPath),
  ]);
  const execa = $({
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: temporaryRoot,
      PATH: `${cliBinaryDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      XDG_STATE_HOME: path.join(temporaryRoot, 'state'),
      XDG_CACHE_HOME: path.join(temporaryRoot, 'cache'),
      XDG_RUNTIME_DIR: runtimeDirectory,
      ENDO_SOCK: path.join(runtimeDirectory, 'endo.sock'),
      ENDO_ADDR: '127.0.0.1:0',
    },
  });
  try {
    await execa`endo purge -f`;
    await execa`endo start`;
    await execa`git init --quiet ${repositoryPath}`;
    await execa`endo mount ${repositoryPath} --name worktree`;
    await execa`endo eval ${"E(host).provideGit(mount, 'repo-git').then(() => 'ok')"} host:@agent mount:worktree`;
    await execa`endo eval ${"E(host).provideBearerCredential('github-token', { audience: 'https://github.com', token: 'test-only' }).then(() => 'ok')"} host:@agent`;

    const provisioned =
      await execa`endo git-remote provision repo-git origin --url https://github.com/endojs/endo.git --profile agent --branch review/change --credential github-token --yes --json`;
    const inspection = JSON.parse(provisioned.stdout);
    t.deepEqual(inspection.policy.pushRefspecs, [
      'refs/heads/review/change:refs/heads/review/change',
    ]);
    t.false(inspection.policy.allowForcePush);
    t.false(inspection.policy.allowTags);
    t.false(inspection.policy.allowDelete);
    t.deepEqual(inspection.credential, {
      audience: 'https://github.com',
      available: true,
      kind: 'bearer',
      required: true,
      revoked: false,
    });

    const inspected = await execa`endo git-remote inspect origin --json`;
    t.deepEqual(JSON.parse(inspected.stdout), inspection);

    const interactivelyProvisioned = await execa({
      input: 'yes\n',
    })`endo git-remote provision repo-git upstream --url https://github.com/endojs/endo.git --profile fetch-only --credential github-token --json`;
    const interactiveInspection = JSON.parse(
      interactivelyProvisioned.stdout.slice(
        interactivelyProvisioned.stdout.lastIndexOf('\n{') + 1,
      ),
    );
    t.deepEqual(interactiveInspection.policy.allowedDirections, ['fetch']);
    t.deepEqual(interactiveInspection.policy.pushRefspecs, []);

    const formula = await execa`endo inspect origin --json`;
    const formulaRecord = JSON.parse(formula.stdout);
    t.deepEqual(formulaRecord.properties.allowedBranches.value, [
      'refs/heads/review/change',
    ]);
    t.is(formulaRecord.properties.credential.kind, 'reference');
  } finally {
    await execa`endo purge -f`;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
