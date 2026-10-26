// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  makeClaudeCliAgentDriverMaker,
  makeClaudeSdkAgentDriverMaker,
} from '../src/agent-driver-maker.js';
import {
  makeCredentialSource,
  makeManualTimers,
  makeMemoryScratch,
  makeProjection,
} from './_backend-fixtures.js';

const VERSION = '2.1.268';

/** @param {any} maker */
const install = async maker => {
  const agent = Far('Agent', {});
  const stored = new Map();
  const driverGuest = Far('DriverGuest', {
    storeValue: (value, name) => stored.set(name, value),
  });
  const descriptor = await E(maker).installDriver(
    harden({ agent, driverGuest, lifecycle: Far('Lifecycle', {}) }),
  );
  return { descriptor, stored };
};

const commonBackendOptions = () => ({
  credentialSource: makeCredentialSource().credentialSource,
  executablePath: '/opt/claude/bin/claude',
  version: VERSION,
  getVersion: () => VERSION,
  makeScratchDirectory: makeMemoryScratch().makeScratchDirectory,
  timers: makeManualTimers().timers,
  pathValue: '/usr/bin',
});

test('Claude CLI maker composes the generic inference driver', async t => {
  const maker = makeClaudeCliAgentDriverMaker({
    backend: {
      ...commonBackendOptions(),
      stdioProjection: () => {
        throw Error('not reached');
      },
      spawn: () => {
        throw Error('not reached');
      },
      kill: () => {},
    },
    makeGuestToolProjection: () => makeProjection().guest,
    driverSpecifier: 'file:///claude-cli-driver.js',
    environment: { MODEL: 'claude-test' },
  });
  const { descriptor, stored } = await install(maker);
  t.deepEqual(descriptor, {
    specifier: 'file:///claude-cli-driver.js',
    env: { MODEL: 'claude-test' },
  });
  t.deepEqual([...stored.keys()].sort(), ['agent', 'inference']);
});

test('Claude SDK maker defaults to the generic inference driver module', async t => {
  const maker = makeClaudeSdkAgentDriverMaker({
    backend: {
      ...commonBackendOptions(),
      query: () => {
        throw Error('not reached');
      },
    },
    makeGuestToolProjection: () => makeProjection().guest,
  });
  const { descriptor, stored } = await install(maker);
  t.regex(
    descriptor.specifier,
    /exo-agent-factory\/src\/inference-driver\.js$/,
  );
  t.false('env' in descriptor);
  t.deepEqual([...stored.keys()].sort(), ['agent', 'inference']);
});
