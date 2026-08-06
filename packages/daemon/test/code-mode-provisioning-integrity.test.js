// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/eventual-send';

/* eslint-disable import/no-relative-packages */
import {
  normalizeEndoProvisionSpec,
  provisionEndoCodeMode,
} from '../../agentry/code-mode-provisioning.js';
/* eslint-enable import/no-relative-packages */

import { makeProvisioningFixture } from './_code-mode-provisioning-fixture.js';

test.serial(
  'code-mode provisioning rejects incomplete or changed state',
  async t => {
    t.timeout(120_000);
    const fixture = await makeProvisioningFixture(t);
    const host = await fixture.connectHost('integrity-host');
    const interrupted = await normalizeEndoProvisionSpec(
      { fs: 'readOnly' },
      {
        harness: 'test',
        sessionId: 'interrupted-provision',
        cwd: fixture.workspace,
      },
    );
    const controllerPath = interrupted.guestHandlePath.slice(0, -1);

    await E(host).makeDirectory(['interrupted-seed']);
    await E(host).provideGuest(['interrupted-seed', 'handle'], {
      agentName: ['interrupted-seed', 'agent'],
    });
    const interruptedAgentId = await E(host).identify(
      'interrupted-seed',
      'agent',
    );
    await E(host).makeDirectory(['code-mode']);
    await E(host).makeDirectory(['code-mode', 'test']);
    await E(host).makeDirectory(controllerPath);
    await E(host).storeIdentifier(
      [...controllerPath, 'guest-agent'],
      interruptedAgentId,
    );

    await t.throwsAsync(
      () =>
        provisionEndoCodeMode({
          harness: 'test',
          sessionId: 'interrupted-provision',
          cwd: fixture.workspace,
          sockPath: fixture.sockPath,
          spec: { fs: 'readOnly' },
        }),
      { message: /handle and agent paths disagree/ },
    );

    await E(host).storeValue(
      'interrupted guest handle',
      interrupted.guestHandlePath,
    );
    await t.throwsAsync(
      () =>
        provisionEndoCodeMode({
          harness: 'test',
          sessionId: 'interrupted-provision',
          cwd: fixture.workspace,
          sockPath: fixture.sockPath,
          spec: { fs: 'readWrite' },
        }),
      { message: /cannot widen or change/ },
    );
  },
);
