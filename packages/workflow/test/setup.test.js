// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { main } from '../setup.js';

/**
 * Records what the setup asked the host to do.
 *
 * @param {object} [options]
 * @param {boolean} [options.installed] - whether `workflow-service` is
 *   already bound in the inventory
 */
const makeAgent = ({ installed = false } = {}) => {
  /** @type {{ guests: any[], unconfined: any[], copies: any[] }} */
  const calls = { guests: [], unconfined: [], copies: [] };
  const agent = {
    async has(name) {
      return name === 'workflow-service' && installed;
    },
    async provideGuest(handleName, options) {
      calls.guests.push({ handleName, ...options });
    },
    async makeUnconfined(workerName, specifier, options) {
      calls.unconfined.push({ workerName, specifier, ...options });
    },
    async copy(from, to) {
      calls.copies.push({ from, to });
    },
  };
  return { agent, calls };
};

test('a fresh inventory gets a dedicated guest, the service, and its pin', async t => {
  const { agent, calls } = makeAgent();

  await main(agent);

  t.deepEqual(calls.guests, [
    { handleName: 'workflow-powers', agentName: 'workflow-agent' },
  ]);
  t.is(calls.unconfined.length, 1);
  const [provisioned] = calls.unconfined;
  t.is(provisioned.workerName, undefined);
  t.true(provisioned.specifier.endsWith('/src/index.js'));
  t.is(provisioned.powersName, 'workflow-agent');
  t.is(provisioned.resultName, 'workflow-service');
  t.deepEqual(calls.copies, [
    { from: ['workflow-service'], to: ['@pins', 'workflow-service'] },
  ]);
});

// The service formula's identity is what factory grants derived from it
// hang off, so a re-run must never re-create it; the pin, by contrast, is
// what wakes it (and every stored run) at boot, so a re-run always heals it.
test('a re-run keeps the installed service and only refreshes its pin', async t => {
  const { agent, calls } = makeAgent({ installed: true });

  await main(agent);

  t.deepEqual(calls.guests, []);
  t.deepEqual(calls.unconfined, []);
  t.deepEqual(calls.copies, [
    { from: ['workflow-service'], to: ['@pins', 'workflow-service'] },
  ]);
});
