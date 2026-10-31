// @ts-check

import path from 'path';
import '@endo/init';
import test from 'ava';
import url from 'url';
import { execa } from 'execa';

import {
  formatGitRemoteInspection,
  formatGitRemotePreview,
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

test('unknown profile names the bounded alternatives', t => {
  t.throws(
    () =>
      makeGitRemoteProfile(
        'origin',
        'https://github.com/endojs/endo.git',
        'admin',
      ),
    {
      message:
        'Unknown Git remote profile "admin"; expected fetch-only or agent',
    },
  );
});

test('inspection reports revoked remotes, empty targets, and unavailable credentials', t => {
  const output = formatGitRemoteInspection({
    policy: {
      name: 'upstream',
      url: 'https://github.com/endojs/endo.git',
      revoked: true,
      allowedDirections: ['fetch'],
      fetchRefspecs: [],
      pushRefspecs: [],
      allowForcePush: true,
      allowTags: false,
      allowDelete: false,
    },
    credential: {
      required: true,
      kind: 'bearer',
      audience: 'https://github.com',
      available: true,
      revoked: true,
    },
  });
  t.regex(output, /state: revoked/);
  t.regex(output, /fetch targets:\n {4}\(none\)/);
  t.regex(output, /push targets:\n {4}\(none\)/);
  t.regex(output, /force push: allowed/);
  t.regex(
    output,
    /credential: bearer for https:\/\/github\.com \(unavailable\)/,
  );
});

test('inspection notes when no credential is required', t => {
  const output = formatGitRemoteInspection({
    policy: {
      name: 'upstream',
      url: 'https://github.com/endojs/endo.git',
      revoked: false,
      allowedDirections: ['fetch'],
      fetchRefspecs: ['+refs/heads/*:refs/remotes/upstream/*'],
      pushRefspecs: [],
      allowForcePush: false,
      allowTags: false,
      allowDelete: false,
    },
    credential: { required: false },
  });
  t.regex(output, /state: active/);
  t.regex(output, /credential: not required/);
});

const endpoint = 'https://github.com/endojs/endo.git';

test('agent profile rejects branch selectors that widen the grant', t => {
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    ['', /not a valid branch selector/],
    ['*', /would grant every branch/],
    ['refs/heads/*', /would grant every branch/],
    ['refs/tags/*', /must name a ref under refs\/heads\//],
    ['refs/remotes/*', /must name a ref under refs\/heads\//],
    ['refs/*', /must name a ref under refs\/heads\//],
    ['../main', /not a valid branch selector/],
    ['/agent/x', /not a valid branch selector/],
    ['agent/', /not a valid branch selector/],
    ['agent//x', /not a valid branch selector/],
    [' agent/x', /not a valid branch selector/],
    ['agent x', /not a valid branch selector/],
    ['+agent/x', /not a valid branch selector/],
    ['agent:main', /not a valid branch selector/],
    ['agent@{1}', /not a valid branch selector/],
    ['agent/*/x', /single \/\* under a fixed parent/],
    ['agent*', /single \/\* under a fixed parent/],
    ['agent/*/*', /single \/\* under a fixed parent/],
  ];
  for (const [branch, message] of cases) {
    t.throws(
      () => makeGitRemoteProfile('origin', endpoint, 'agent', [branch]),
      { message },
      `branch ${JSON.stringify(branch)}`,
    );
  }
});

test('agent profile accepts rooted wildcard namespaces and drops duplicates', t => {
  const profile = makeGitRemoteProfile('origin', endpoint, 'agent', [
    'review/*',
    'refs/heads/review/*',
    'review/one',
  ]);
  t.deepEqual(profile.allowedBranches, [
    'refs/heads/review/*',
    'refs/heads/review/one',
  ]);
});

test('fetch-only profile rejects every --branch, not just the first', t => {
  t.throws(
    () =>
      makeGitRemoteProfile('origin', endpoint, 'fetch-only', [
        'agent/one',
        'agent/two',
      ]),
    { message: '--branch requires the agent profile' },
  );
});

test('remote name must be a single plain segment', t => {
  for (const remoteName of [
    '',
    'a/b',
    'a:b',
    'a*',
    '..',
    'a..b',
    '.hidden',
    '-x',
    'origin.lock',
    'has space',
  ]) {
    t.throws(
      () => makeGitRemoteProfile(remoteName, endpoint, 'fetch-only'),
      { message: /must be a single segment/ },
      `remote name ${JSON.stringify(remoteName)}`,
    );
  }
  t.deepEqual(
    makeGitRemoteProfile('my_remote-2.x', endpoint, 'fetch-only').fetchRefspecs,
    ['+refs/heads/*:refs/remotes/my_remote-2.x/*'],
  );
});

test('endpoint must be HTTPS without embedded credentials', t => {
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    ['', /is not a valid URL/],
    ['github.com/endojs/endo', /is not a valid URL/],
    ['http://github.com/endojs/endo.git', /must use https:/],
    ['file:///tmp/repo', /must use https:/],
    ['ssh://git@github.com/endojs/endo.git', /must use https:/],
    ['git://github.com/endojs/endo.git', /must use https:/],
    ['https://user:secret@github.com/endojs/endo.git', /must not embed/],
    ['https://token@github.com/endojs/endo.git', /must not embed/],
  ];
  for (const [candidate, message] of cases) {
    t.throws(
      () => makeGitRemoteProfile('origin', candidate, 'fetch-only'),
      { message },
      `url ${JSON.stringify(candidate)}`,
    );
  }
});

test('preview derives push targets per branch and does not vouch for the credential', t => {
  const output = formatGitRemotePreview(
    makeGitRemoteProfile('origin', endpoint, 'agent', [
      'review/*',
      'review/one',
    ]),
    'github-token',
  );
  t.regex(
    output,
    /push targets:\n {4}refs\/heads\/review\/\*:refs\/heads\/review\/\*\n {4}refs\/heads\/review\/one:refs\/heads\/review\/one\n/,
  );
  t.regex(output, /directions: fetch, push/);
  t.regex(output, /credential: github-token \(unverified/);
  t.notRegex(output, /\(available\)/);
});

test('fetch-only preview grants no push target', t => {
  const output = formatGitRemotePreview(
    makeGitRemoteProfile('upstream', endpoint, 'fetch-only'),
    'github-token',
  );
  t.regex(output, /push targets:\n {4}\(none\)/);
  t.regex(output, /directions: fetch\n/);
});

test('inspection reports a revoked-but-available credential as unavailable and empty directions', t => {
  const output = formatGitRemoteInspection({
    policy: {
      name: 'origin',
      url: endpoint,
      revoked: false,
      allowedDirections: [],
      fetchRefspecs: [],
      pushRefspecs: [],
      allowForcePush: false,
      allowTags: false,
      allowDelete: false,
    },
    credential: {
      required: true,
      kind: 'bearer',
      audience: 'https://github.com',
      available: true,
      revoked: true,
    },
  });
  t.regex(output, /directions: \(none\)/);
  t.regex(output, /\(unavailable\)/);
});

test('provision --yes without --url fails instead of prompting', async t => {
  const result = await execa(
    process.execPath,
    [
      endoBin,
      'git-remote',
      'provision',
      'repo-git',
      'origin',
      '--credential',
      'github-token',
      '--yes',
    ],
    { reject: false, input: '' },
  );
  t.not(result.exitCode, 0);
  t.regex(result.stderr, /--yes requires --url/);
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
