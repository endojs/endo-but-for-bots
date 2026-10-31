// @ts-check
// spell-out-exempt: XDG_RUNTIME_DIR and ENDO_ADDR are external environment
// variable names, not identifiers this test coins.

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

testSerial('provision, inspect, and revoke a Git remote', async t => {
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
    // `--yes` skips the prompt but still shows the grant it approves.
    t.regex(
      provisioned.stderr,
      /endpoint: https:\/\/github\.com\/endojs\/endo\.git/,
    );
    t.regex(
      provisioned.stderr,
      /push targets:\n {4}refs\/heads\/review\/change:refs\/heads\/review\/change\n/,
    );
    t.regex(
      provisioned.stderr,
      /credential: github-token \(unverified; health is reported after provisioning\)/,
    );
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

    // Without --url the endpoint is prompted for; the answer keeps its case,
    // and the preview and prompts stay off stdout so --json parses whole.
    const interactivelyProvisioned = await execa({
      input: 'https://github.com/EndoJS/Endo-Mixed.git\nyes\n',
    })`endo git-remote provision repo-git upstream --profile fetch-only --credential github-token --json`;
    const interactiveInspection = JSON.parse(interactivelyProvisioned.stdout);
    t.is(
      interactiveInspection.policy.url,
      'https://github.com/EndoJS/Endo-Mixed.git',
    );
    t.deepEqual(interactiveInspection.policy.allowedDirections, ['fetch']);
    t.deepEqual(interactiveInspection.policy.pushRefspecs, []);
    t.regex(
      interactivelyProvisioned.stderr,
      /endpoint: https:\/\/github\.com\/EndoJS\/Endo-Mixed\.git\n/,
    );
    t.regex(interactivelyProvisioned.stderr, /push targets:\n {4}\(none\)/);
    t.regex(
      interactivelyProvisioned.stderr,
      /credential: github-token \(unverified; health is reported after provisioning\)\n/,
    );
    // The preview precedes the approval question.
    t.true(
      interactivelyProvisioned.stderr.indexOf('endpoint:') <
        interactivelyProvisioned.stderr.indexOf('Provision this remote?'),
    );
    t.regex(interactivelyProvisioned.stderr, /Provision this remote\?/);
    const reinspected = await execa`endo git-remote inspect upstream --json`;
    t.is(
      JSON.parse(reinspected.stdout).policy.url,
      'https://github.com/EndoJS/Endo-Mixed.git',
    );

    // A revoked remote rejects credentialHealth(); inspection still reports
    // the revoked policy through the host-held controller.
    await execa`endo eval ${'E(E(host).getGitRemoteController(remote)).revoke().then(() => "ok")'} host:@agent remote:upstream`;
    const revoked = await execa`endo git-remote inspect upstream --json`;
    const revokedInspection = JSON.parse(revoked.stdout);
    t.true(revokedInspection.policy.revoked);
    t.false('credential' in revokedInspection);
    const revokedText = await execa`endo git-remote inspect upstream`;
    t.regex(revokedText.stdout, /state: revoked/);
    t.regex(revokedText.stdout, /credential: not checked \(remote revoked\)/);

    const formula = await execa`endo inspect origin --json`;
    const formulaRecord = JSON.parse(formula.stdout);
    t.deepEqual(formulaRecord.properties.allowedBranches.value, [
      'refs/heads/review/change',
    ]);
    t.deepEqual(formulaRecord.properties.pushRefspecs.value, [
      'refs/heads/review/change:refs/heads/review/change',
    ]);
    t.is(formulaRecord.properties.credential.kind, 'reference');
  } finally {
    await execa`endo purge -f`;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
