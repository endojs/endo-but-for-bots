// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { readFaeWorkloadConfig } from '../src/workload-config.js';
import { make as makeFactory } from '../agent.js';
import { make as makeDriver } from '../driver.js';
import { main as setup } from '../fae-factory-setup.js';
import { provisionFaeAgent } from '../src/subagent-host.js';

test('Fae workload configuration shares defaults and validates overrides', t => {
  const defaults = readFaeWorkloadConfig({});
  t.is(defaults.maxToolRounds, 1024);
  t.is(defaults.maxDepth, 32);
  t.is(defaults.maxSubagents, 1024);
  const configured = readFaeWorkloadConfig({
    FAE_MAX_TOOL_ROUNDS: '2000',
    FAE_PROVIDER_REQUEST_TIMEOUT_MS: '9000',
    FAE_MAX_SUBAGENTS: '4',
    FAE_MAX_SUBAGENT_DEPTH: '0',
    FAE_SUBAGENT_TIMEOUT_SECONDS: '2',
    FAE_SUBAGENT_MAX_TIMEOUT_SECONDS: '3',
  });
  t.is(configured.maxToolRounds, 2000);
  t.is(configured.requestTimeoutMs, 9000);
  t.is(configured.maxSubagents, 4);
  t.is(configured.maxDepth, 0);
  t.is(configured.subagentLimits.replyTimeoutSeconds, 2);
  t.is(configured.subagentLimits.maxTimeoutSeconds, 3);
});

test('malformed retained workload settings fail before factory, driver or setup host calls', async t => {
  await null;
  let calls = 0;
  const touch = () => {
    calls += 1;
    throw Error('host touched');
  };
  const powers = Far('untouched host', {
    lookup: touch,
    locate: touch,
    identify: touch,
    has: touch,
  });
  for (const env of [
    { FAE_MAX_TOOL_ROUNDS: 'invalid' },
    { FAE_PROVIDER_REQUEST_TIMEOUT_MS: '2147483648' },
    { FAE_SUBAGENT_MAX_TIMEOUT_SECONDS: '2147484' },
  ]) {
    // Each constructor must reject synchronously with respect to capability use.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(makeFactory(powers, undefined, { env }), {
      message: /Invalid/,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(makeDriver(powers, undefined, { env }), {
      message: /Invalid/,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(setup(powers, env), { message: /Invalid/ });
  }
  t.is(calls, 0);
});

test('overlong derived names are refused before host inspection or provisioning', async t => {
  let calls = 0;
  const hostAgent = Far('untouched host', {
    has: () => {
      calls += 1;
      return false;
    },
  });
  await t.throwsAsync(
    provisionFaeAgent({
      hostAgent,
      name: Array(4).fill('a'.repeat(63)).join('.sub.'),
      providerLocator: 'unused',
      hostAgentLocator: 'unused',
      driverSpecifier: 'unused',
      spawnerSpecifier: 'unused',
      depth: 3,
      maxDepth: 32,
    }),
    { message: /255-character/ },
  );
  t.is(calls, 0);
});
