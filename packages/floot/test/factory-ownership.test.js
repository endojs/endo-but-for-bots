// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from './_promise-kit.js';
import { makeFactoryOwnership } from '../src/factory-ownership.js';
import { make } from '../agent.js';

for (const cancels of [false, true]) {
  test(`factory registers disposal before revival: cancelled during registration=${cancels}`, async t => {
    const entered = makePromiseKit();
    const release = makePromiseKit();
    let touches = 0;
    /** @type {any} */
    let hook;
    const host = Far('IdleHost', {
      list: () => {
        touches += 1;
        return harden([]);
      },
      has: () => false,
    });
    const context = Far('RegistrationContext', {
      addDisposalHook: async callback => {
        hook = callback;
        entered.resolve(undefined);
        await release.promise;
      },
    });
    const creating = make(host, context);
    void creating.catch(() => {});
    await entered.promise;
    t.is(touches, 0);
    if (cancels) await E(hook)();
    release.resolve(undefined);
    if (cancels) {
      await t.throwsAsync(creating, { message: /closed/ });
      t.is(touches, 0);
    } else {
      const factory = await creating;
      await E(factory).listSessions();
      await E(hook)();
    }
  });
}

for (const fails of [false, true]) {
  test(`ownership fences synchronous methods and drains pending work: fails=${fails}`, async t => {
    const owner = makeFactoryOwnership();
    const pending = makePromiseKit();
    const methods = owner.methods({
      read: () => 'value',
      write: () => pending.promise,
    });
    t.is(methods.read(), 'value');
    const writing = methods.write();
    void writing.catch(() => {});
    owner.fence();
    t.throws(() => methods.read(), { message: /closed/ });
    let settled = false;
    const closing = owner.drain().finally(() => {
      settled = true;
    });
    void closing.catch(() => {});
    await Promise.resolve();
    t.false(settled);
    if (fails) {
      pending.reject(Error('Write uncertain'));
      await t.throwsAsync(closing, { message: /work failed/ });
      await t.throwsAsync(owner.drain(), { message: /work failed/ });
    } else {
      pending.resolve(undefined);
      await closing;
    }
  });
}
