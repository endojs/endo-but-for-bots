// @ts-check

import path from 'path';
import '@endo/init';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

import {
  formatGitRemoteInspection,
  makeGitRemoteProfile,
} from '../src/commands/git-remote.js';

const directory = url.fileURLToPath(new URL('.', import.meta.url));
const endoBin = path.join(directory, '..', 'bin', 'endo.cjs');

test('fetch-only profile can update remote-tracking branches but cannot push', t => {
  t.deepEqual(
    makeGitRemoteProfile(
      'upstream',
      'https://github.com/endojs/endo.git',
      'fetch-only',
    ),
    {
      name: 'upstream',
      url: 'https://github.com/endojs/endo.git',
      allowedDirections: ['fetch'],
      fetchRefspecs: ['+refs/heads/*:refs/remotes/upstream/*'],
      pushRefspecs: [],
      allowForcePush: false,
      allowTags: false,
      allowDelete: false,
    },
  );
});

test('agent profile defaults to the bounded agent branch namespace', t => {
  const profile = makeGitRemoteProfile(
    'origin',
    'https://github.com/endojs/endo.git',
    'agent',
  );
  t.deepEqual(profile.allowedDirections, ['fetch', 'push']);
  t.deepEqual(profile.allowedBranches, ['refs/heads/agent/*']);
  t.false(profile.allowForcePush);
  t.false(profile.allowTags);
  t.false(profile.allowDelete);
});

test('agent profile accepts explicit review branches', t => {
  const profile = makeGitRemoteProfile(
    'origin',
    'https://github.com/endojs/endo.git',
    'agent',
    ['review/one', 'refs/heads/review/two'],
  );
  t.deepEqual(profile.allowedBranches, [
    'refs/heads/review/one',
    'refs/heads/review/two',
  ]);
});

test('fetch-only profile rejects push branches', t => {
  t.throws(
    () =>
      makeGitRemoteProfile(
        'origin',
        'https://github.com/endojs/endo.git',
        'fetch-only',
        ['agent/change'],
      ),
    { message: '--branch requires the agent profile' },
  );
});

test('inspection spells out endpoint and granted push targets', t => {
  const output = formatGitRemoteInspection({
    policy: {
      name: 'origin',
      url: 'https://github.com/endojs/endo.git',
      revoked: false,
      allowedDirections: ['fetch', 'push'],
      fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
      pushRefspecs: ['refs/heads/agent/*:refs/heads/agent/*'],
      allowForcePush: false,
      allowTags: false,
      allowDelete: false,
    },
    credential: {
      required: true,
      kind: 'bearer',
      audience: 'https://github.com',
      available: true,
      revoked: false,
    },
  });
  t.regex(output, /endpoint: https:\/\/github\.com\/endojs\/endo\.git/);
  t.regex(
    output,
    /push targets:\n {4}refs\/heads\/agent\/\*:refs\/heads\/agent\/\*/,
  );
  t.regex(output, /force push: denied/);
  t.regex(output, /credential: bearer for https:\/\/github\.com \(available\)/);
});

test('git-remote help advertises provisioning and inspection', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'git-remote',
    '--help',
  ]);
  t.regex(stdout, /provision/);
  t.regex(stdout, /inspect/);
});

test('git-remote provision help names both bounded profiles', async t => {
  const { stdout } = await execa(process.execPath, [
    endoBin,
    'git-remote',
    'provision',
    '--help',
  ]);
  t.regex(stdout, /fetch-only or agent/);
  t.regex(stdout, /defaults to refs\/heads\/agent\/\*/);
  t.regex(stdout, /interactive approval prompt/);
  t.regex(stdout, /--credential <name>/);
});
