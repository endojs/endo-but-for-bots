// @ts-check
/// <reference types="ses"/>

// Host-side adoption of a git capability URL, per
// designs/daemon-git-remote-capability-urls.md.

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify as nodePromisify } from 'node:util';

import { E } from '@endo/eventual-send';
import { splitGitCapabilityUrl } from '@endo/exo-git/src/git-remote-policy.js';

import { makeProvisioningFixture } from './_code-mode-provisioning-fixture.js';
import { quiesceGitMaintenance } from './_git-fixture.js';

const execFileAsync = nodePromisify(execFile);

const TOKEN = 'mtcap-7f3e1d2c9b8a-SECRET';
const CAPABILITY_URL = `https://x-access-token:${TOKEN}@git.minion.town/p/0123abcd`;

/**
 * A bare repository with one commit on `main`, under `root`.
 *
 * @param {string} root
 */
const provisionBareRemote = async root => {
  const source = path.join(root, 'source');
  await fs.promises.mkdir(source);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: source });
  await quiesceGitMaintenance(source);
  await fs.promises.writeFile(path.join(source, 'artifact.txt'), 'artifact\n');
  await execFileAsync('git', ['add', 'artifact.txt'], { cwd: source });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
    { cwd: source },
  );
  const bare = path.join(root, 'remote.git');
  await execFileAsync('git', ['clone', '-q', '--bare', source, bare]);
  await quiesceGitMaintenance(bare);
  return bare;
};

/**
 * @param {string} bare
 */
const remoteRefs = async bare => {
  const { stdout } = await execFileAsync('git', [
    '--git-dir',
    bare,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
  ]);
  return stdout;
};

/**
 * Every regular file path under `directory`.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
const listFiles = async directory => {
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(entry => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return nested.flat();
};

/**
 * @param {ExecutionContext} t
 * @param {Promise<unknown>} promise
 * @param {RegExp} message
 */
const rejectsWithoutToken = async (t, promise, message) => {
  const error = await t.throwsAsync(promise, { message });
  t.false(String(error?.message).includes(TOKEN), 'message leaks the token');
  t.false(String(error?.stack).includes(TOKEN), 'stack leaks the token');
};

test.serial(
  'EndoHost adopts a split capability URL and narrows a clone origin to fetch-only across restart',
  async t => {
    const fixture = await makeProvisioningFixture(t);
    const bare = await provisionBareRemote(fixture.root);
    const host = await fixture.connectHost('capability-host');

    // Passing the whole capability URL to the daemon is refused, and the
    // rejection that crosses CapTP carries no token.
    const destMount = await E(host).provideScratchMount('capability-scratch');
    await rejectsWithoutToken(
      t,
      E(host).provideGitClone({
        destMount,
        endpoint: { url: CAPABILITY_URL },
      }),
      /embedded credentials: "https:\/\/\*\*\*:\*\*\*@git\.minion\.town\/p\/0123abcd".*splitGitCapabilityUrl/,
    );
    await rejectsWithoutToken(
      t,
      E(host).provideGitClone({
        destMount,
        endpoint: { url: CAPABILITY_URL.replace(/^https:/u, 'http:') },
      }),
      /must use https: for the MVP transport, not "http:"/,
    );

    // Clone, then narrow the origin before it is named or granted.
    const namesBeforeClone = [...(await E(host).list())].sort();
    const { git, remote: origin } = await E(host).provideGitClone({
      destMount,
      endpoint: {
        url: pathToFileURL(bare).href,
        allowLocalFileTransport: true,
      },
    });
    // The interrupted-window rule: provideGitClone names nothing, so a host
    // that fails before narrowing leaves no grantable pet name for `origin`.
    t.deepEqual([...(await E(host).list())].sort(), namesBeforeClone);
    t.deepEqual([...(await E(origin).inspect()).allowedDirections].sort(), [
      'fetch',
      'push',
    ]);
    const originController = await E(host).getGitRemoteController(origin);
    await E(originController).setAllowedDirections(['fetch']);
    await E(host).storeValue(origin, 'ingest-remote');

    const refsBefore = await remoteRefs(bare);
    await E(origin).fetch();
    const gitFs = /** @type {any} */ (
      await E(E(git).readOnly()).filesystemAt('refs/remotes/origin/main')
    );
    const artifact = /** @type {any} */ (
      await E(E(gitFs).root()).lookup('artifact.txt')
    );
    t.is((await E(artifact).getQid()).type, 'file');
    await t.throwsAsync(
      E(origin).push({
        source: 'refs/heads/main',
        destination: 'refs/heads/main',
      }),
      { message: /does not permit "push"/ },
    );
    t.is(await remoteRefs(bare), refsBefore);

    // Adopt the capability URL the supported way: split on the host side.
    const { url, audience, username, password } =
      splitGitCapabilityUrl(CAPABILITY_URL);
    const credential = await E(host).provideBasicCredential('capability-cred', {
      audience,
      username,
      password,
    });
    const capabilityRemote = await E(host).provideGitRemote(
      git,
      'capability-remote',
      {
        name: 'partition',
        url,
        credential,
        fetchRefspecs: ['+refs/heads/*:refs/remotes/partition/*'],
      },
    );
    const snapshot = await E(capabilityRemote).inspect();
    t.is(snapshot.url, 'https://git.minion.town/p/0123abcd');
    t.deepEqual([...snapshot.allowedDirections], ['fetch']);
    t.false(JSON.stringify(snapshot).includes(TOKEN));
    t.like(await E(capabilityRemote).credentialHealth(), {
      required: true,
      kind: 'basic',
      audience: 'https://git.minion.town',
      available: true,
      revoked: false,
    });
    const capabilityController =
      await E(host).getGitRemoteController(capabilityRemote);
    t.false(
      JSON.stringify(await E(capabilityController).audit(), (_key, value) =>
        typeof value === 'bigint' ? `${value}` : value,
      ).includes(TOKEN),
    );

    // A credential for another origin is refused at construction.
    const strayCredential = await E(host).provideBasicCredential('stray-cred', {
      audience: 'https://elsewhere.example',
      username,
      password,
    });
    await rejectsWithoutToken(
      t,
      E(host).provideGitRemote(git, 'stray-remote', {
        name: 'stray',
        url,
        credential: strayCredential,
      }),
      /does not match remote origin/,
    );

    await fixture.restartDaemon();
    const restartedHost = await fixture.connectHost('capability-host-restart');

    // The narrowed origin policy is formula-owned and revives fetch-only.
    const revivedOrigin = await E(restartedHost).lookup('ingest-remote');
    t.deepEqual(
      [...(await E(revivedOrigin).inspect()).allowedDirections],
      ['fetch'],
    );
    await t.throwsAsync(
      E(revivedOrigin).push({
        source: 'refs/heads/main',
        destination: 'refs/heads/main',
      }),
      { message: /does not permit "push"/ },
    );
    t.is(await remoteRefs(bare), refsBefore);

    // Credential material is process-local: revoked until rotated back in.
    const revivedRemote = await E(restartedHost).lookup('capability-remote');
    t.like(await E(revivedRemote).credentialHealth(), {
      required: true,
      kind: 'basic',
      available: false,
      revoked: true,
    });
    await rejectsWithoutToken(t, E(revivedRemote).fetch(), /revoked/);
    const revivedCredential = await E(restartedHost).lookup('capability-cred');
    const credentialController =
      await E(restartedHost).getGitCredentialController(revivedCredential);
    await E(credentialController).rotate({ username, password });
    t.like(await E(revivedRemote).credentialHealth(), {
      available: true,
      revoked: false,
    });

    // Redaction against real serialization: formula records, the pet store,
    // the daemon log, and every other file the daemon wrote.
    await fixture.closeClients();
    const files = (
      await Promise.all(
        ['state', 'run', 'cache'].map(subdirectory =>
          listFiles(path.join(fixture.root, subdirectory)),
        ),
      )
    ).flat();
    const contents = await Promise.all(
      files.map(async file => ({
        file,
        bytes: await fs.promises.readFile(file),
      })),
    );
    const scanned = contents.length;
    // Positive control: the credential-free URL is persisted in the
    // GitRemote formula, so finding it proves the scan reads formula records.
    const sawEndpoint = contents.some(({ bytes }) =>
      bytes.includes('git.minion.town/p/0123abcd'),
    );
    const leaking = contents
      .filter(({ bytes }) => bytes.includes(TOKEN))
      .map(({ file }) => path.relative(fixture.root, file));
    t.true(scanned > 0, 'the daemon wrote state to scan');
    t.true(sawEndpoint, 'the scan covers the persisted GitRemote formula');
    t.deepEqual(leaking, [], 'no daemon file contains the token');
  },
);
