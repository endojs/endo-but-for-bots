// @ts-check

/** @import { GitRemote } from '@endo/exo-git' */
/** @import { EndoProvisionSpec } from '../../agentry/src/code-mode-provisioning-types.js' */

import '@endo/init/debug.js';

import test from 'ava';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { E } from '@endo/eventual-send';

/* eslint-disable import/no-relative-packages */
import {
  EndoCredentialUnavailableError,
  provisionEndoCodeMode,
  reconstructEndoCodeMode,
} from '../../agentry/code-mode-provisioning.js';
/* eslint-enable import/no-relative-packages */

import { makeProvisioningFixture } from './_code-mode-provisioning-fixture.js';

const execFileAsync = promisify(execFile);

test.serial(
  'code-mode provisioning validates and rotates credentials',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    await execFileAsync('git', ['init', '-q', '-b', 'main'], {
      cwd: fixture.workspace,
    });
    const host = await fixture.connectHost('credential-host');
    await E(host).makeDirectory(['credentials']);
    await E(host).provideBearerCredential(['credentials', 'github'], {
      audience: 'https://github.com',
      token: 'ephemeral-test-token',
    });
    await E(host).provideBearerCredential(['credentials', 'wrong'], {
      audience: 'https://gitlab.com',
      token: 'ephemeral-test-token',
    });

    /** @type {EndoProvisionSpec} */
    const spec = harden({
      fs: 'readWrite',
      git: 'readWrite',
      gitRemotes: {
        upstream: {
          url: 'https://github.com/endojs/endo.git',
          credential: ['credentials', 'github'],
        },
      },
    });
    const credentialSession = fixture.trackSession(
      await provisionEndoCodeMode({
        harness: 'test',
        sessionId: 'credential-remote',
        cwd: fixture.workspace,
        sockPath: fixture.sockPath,
        spec,
      }),
    );
    const oldRemote = /** @type {GitRemote} */ (
      await E(credentialSession.powers).lookup('upstream')
    );
    const oldRemoteId = await E(credentialSession.powers).identify('upstream');

    await E(host).provideBearerCredential(['credentials', 'github'], {
      audience: 'https://github.com',
      token: 'reprovisioned-test-token',
    });
    const reprovisioned = fixture.trackSession(
      await provisionEndoCodeMode({
        harness: 'test',
        sessionId: 'credential-remote',
        cwd: fixture.workspace,
        sockPath: fixture.sockPath,
        spec,
      }),
    );
    const newRemoteId = await E(reprovisioned.powers).identify('upstream');
    t.not(oldRemoteId, newRemoteId);
    await t.throwsAsync(E(oldRemote).inspect(), {
      message: /has been revoked/,
    });
    t.truthy(await E(reprovisioned.powers).lookup('upstream'));

    await t.throwsAsync(
      () =>
        provisionEndoCodeMode({
          harness: 'test',
          sessionId: 'missing-credential',
          cwd: fixture.workspace,
          sockPath: fixture.sockPath,
          spec: {
            fs: 'readWrite',
            git: 'readWrite',
            gitRemotes: {
              upstream: {
                url: 'https://github.com/endojs/endo.git',
                credential: ['credentials', 'missing'],
              },
            },
          },
        }),
      {
        instanceOf: EndoCredentialUnavailableError,
        message: /reprovision the credential on the host and retry/,
      },
    );
    await t.throwsAsync(
      () =>
        provisionEndoCodeMode({
          harness: 'test',
          sessionId: 'wrong-audience',
          cwd: fixture.workspace,
          sockPath: fixture.sockPath,
          spec: {
            fs: 'readWrite',
            git: 'readWrite',
            gitRemotes: {
              upstream: {
                url: 'https://github.com/endojs/endo.git',
                credential: ['credentials', 'wrong'],
              },
            },
          },
        }),
      { message: /does not match.*audience/ },
    );

    await fixture.restartDaemon();
    await t.throwsAsync(
      () =>
        reconstructEndoCodeMode({
          persistence: credentialSession.persistence,
          sockPath: fixture.sockPath,
        }),
      {
        instanceOf: EndoCredentialUnavailableError,
        message: /reprovision the credential on the host and retry/,
      },
    );
  },
);
