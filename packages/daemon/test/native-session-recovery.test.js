// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { makeHostedSessionSupervisor } from '@endo/hosted-agent/session-supervisor.js';
import { makeSessionOwner } from '../src/session-owner.js';
import { makeDirectory } from './_session-record-directory.js';

/** @import { SessionRecordDirectory } from '../src/session-record-store.js' */

for (const failure of [
  'missing-sandbox',
  'missing-broker',
  'rejected-sandbox',
  'rejected-close',
  'null-sandbox',
]) {
  test(`reconstructed native owner preserves records and storage after ${failure}`, async t => {
    t.timeout(5000);
    const directory = makeDirectory();
    let fault = true;
    let reclaims = 0;
    let removals = 0;
    let revocations = 0;
    const cancellations = [];
    const sandbox = Far('OriginalSandboxScope', {
      close: async () => {
        if (fault && failure === 'rejected-close')
          throw Error('Sandbox still running');
      },
    });
    const broker = Far('OriginalBrokerScope', {
      fence: async () => {},
      revoke: async () => {
        revocations += 1;
      },
    });
    const dependencies = {
      sandboxService: Far('SandboxService', {
        lookupScope: () => {
          if (fault && failure === 'null-sandbox') return null;
          if (fault && failure === 'rejected-sandbox')
            throw Error('Lookup failed');
          return fault && failure === 'missing-sandbox' ? undefined : sandbox;
        },
      }),
      brokerService: Far('BrokerService', {
        lookupScope: () =>
          fault && failure === 'missing-broker' ? undefined : broker,
      }),
      storage: Far('Storage', {
        remove: async () => {
          removals += 1;
        },
      }),
    };
    const original = Far('OriginalController', { activate: async () => {} });
    const rebuilt = makeHostedSessionSupervisor({
      name: 'RecoveryTest',
      readPlan: () => ({
        sandboxSessionId: 'one',
        workspaceMountPoint: '/recorded/workspace',
        mounterSocketDir: '/recorded/9p',
      }),
      start: async () => {
        throw Error('Recovery must not activate a replacement');
      },
      reclaimMount: async () => {
        reclaims += 1;
      },
    });
    const powers = {
      directory,
      provide: async id => dependencies[id],
      cancel: async () => {
        throw Error('Unexpected reviving cancellation');
      },
      native: {
        construct: (_name, publish) => ({
          value: Promise.resolve().then(async () => {
            await publish('worker', 'controller');
            return original;
          }),
          cancel: async () => {},
        }),
        provideClient: async () => rebuilt,
        cancel: async id => {
          cancellations.push(id);
        },
      },
    };
    await E(makeSessionOwner(powers)).create('one', 'recorded-plan', {
      sandboxService: 'sandboxService',
      brokerService: 'brokerService',
      storage: 'storage',
    });
    await E(makeSessionOwner(powers)).start('one');
    // Discard every in-memory owner/controller, retaining only the recorded
    // directory, as at reconstruction. This is an injected loss boundary,
    // not an actual process-restart or native-container test.
    const recovered = makeSessionOwner(powers);
    await t.throwsAsync(E(recovered).remove('one'), {
      message: /cleanup|proof/i,
    });
    const entry = /** @type {SessionRecordDirectory} */ (
      await E(directory).lookup('one')
    );
    t.not(await E(entry).maybeReadText('native-closed'), 'yes');
    t.is(removals, 0);
    t.deepEqual(cancellations, []);
    if (failure !== 'missing-broker') {
      t.is(reclaims, 0);
      t.is(revocations, 0);
    }
    t.false((await E(rebuilt).status()).stopped);
    fault = false;
    await E(recovered).remove('one');
    t.is(removals, 1);
    t.true((await E(rebuilt).status()).stopped);
  });
}

test('reconstructed mount reclamation waits for original sandbox closure', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const released = makePromiseKit();
  t.teardown(() => released.resolve(undefined));
  let reclaims = 0;
  const sandbox = Far('OriginalSandbox', {
    close: async () => {
      entered.resolve(undefined);
      await released.promise;
    },
  });
  const broker = Far('OriginalGrant', {
    fence: async () => {},
    revoke: async () => {},
  });
  const resolver = Far('Resolver', {
    get: role =>
      Far('Service', {
        lookupScope: () => (role === 'sandboxService' ? sandbox : broker),
      }),
  });
  const supervisor = makeHostedSessionSupervisor({
    name: 'RecoveryTest',
    readPlan: () => ({
      sandboxSessionId: 'one',
      workspaceMountPoint: '/recorded/workspace',
      mounterSocketDir: '/recorded/9p',
    }),
    start: async () => {
      throw Error('No replacement');
    },
    reclaimMount: async () => {
      reclaims += 1;
    },
  });
  const closing = E(supervisor).terminate('recorded-plan', resolver);
  await entered.promise;
  await E(supervisor).status();
  t.is(reclaims, 0);
  released.resolve(undefined);
  await closing;
  t.is(reclaims, 1);
});
