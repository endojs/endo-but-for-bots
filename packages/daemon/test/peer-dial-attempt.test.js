// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';

import { makePeerDialAttempt } from '../src/manager.js';
import { makeRemoteControlProvider } from '../src/remote-control.js';

/** @import { EndoGateway, FarContext, FormulaIdentifier } from '../src/types.js' */

const flushJobs = async () => {
  // Flush remote E sends plus the chained cancellation/disposal reactions.
  for (let turn = 0; turn < 12; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

const makeParent = () => {
  const { promise, reject } = makePromiseKit();
  promise.catch(() => {});
  return {
    context: harden({
      id: /** @type {FormulaIdentifier} */ ('peer:test'),
      cancelled: /** @type {Promise<never>} */ (promise),
    }),
    cancel: reject,
  };
};

const gateway = /** @type {EndoGateway} */ (
  /** @type {unknown} */ (Far('Gateway', {}))
);

test('network dial rejection resets remote control and disposes its peer incarnation', async t => {
  t.timeout(2000);
  const parent = makeParent();
  t.teardown(() => parent.cancel(Error('test finished')));
  const failed = Error('TCP dial refused');
  const attempt = makePeerDialAttempt(parent.context, async () => {
    throw failed;
  });
  const remote = makeRemoteControlProvider('z-node')('a-node');
  let disposed = 0;
  await t.throwsAsync(
    () =>
      Promise.resolve(
        remote.connect(
          attempt.getRemoteGateway,
          attempt.cancel,
          attempt.cancelled,
          () => {
            disposed += 1;
          },
        ),
      ),
    { is: failed },
  );
  await flushJobs();
  t.is(remote.getStateName(), 'start');
  t.is(disposed, 1);
});

test('network-reported connection loss reaches remote control cancellation', async t => {
  t.timeout(2000);
  const parent = makeParent();
  t.teardown(() => parent.cancel(Error('test finished')));
  /** @type {FarContext | undefined} */
  let networkContext;
  const attempt = makePeerDialAttempt(parent.context, async context => {
    networkContext = context;
    return gateway;
  });
  const remote = makeRemoteControlProvider('z-node')('a-node');
  let disposed = 0;
  await remote.connect(
    attempt.getRemoteGateway,
    attempt.cancel,
    attempt.cancelled,
    () => {
      disposed += 1;
    },
  );
  if (!networkContext) throw Error('Network context was not supplied');
  await E(networkContext).cancel(Error('TCP socket closed'));
  await flushJobs();
  t.is(remote.getStateName(), 'start');
  t.is(disposed, 1);
});

test('remote-control cancellation reaches the pending network dial without cancelling the peer parent', async t => {
  t.timeout(2000);
  const parent = makeParent();
  t.teardown(() => parent.cancel(Error('test finished')));
  let parentLost = false;
  parent.context.cancelled.catch(() => {
    parentLost = true;
  });
  /** @type {unknown} */
  let networkReason;
  const attempt = makePeerDialAttempt(parent.context, async context => {
    E(context)
      .whenCancelled()
      .catch(reason => {
        networkReason = reason;
      });
    return new Promise(() => {});
  });
  const pending = attempt.getRemoteGateway();
  pending.catch(() => {});
  const abandoned = Error('Connection abandoned: accepted new connection');
  attempt.cancel(abandoned);
  await flushJobs();
  t.is(networkReason, abandoned);
  t.false(parentLost);
  await t.throwsAsync(() => pending, { is: abandoned });
});

test('crossed hello closes the losing dial while the accepted winner keeps the peer alive', async t => {
  t.timeout(2000);
  const parent = makeParent();
  t.teardown(() => parent.cancel(Error('test finished')));
  let parentLost = false;
  parent.context.cancelled.catch(() => {
    parentLost = true;
  });
  let networkClosed = false;
  const attempt = makePeerDialAttempt(parent.context, async context => {
    E(context)
      .whenCancelled()
      .catch(() => {
        networkClosed = true;
      });
    return new Promise(() => {});
  });
  const remote = makeRemoteControlProvider('a-node')('z-node');
  let peerDisposals = 0;
  const pending = Promise.resolve(
    remote.connect(
      attempt.getRemoteGateway,
      attempt.cancel,
      attempt.cancelled,
      () => {
        peerDisposals += 1;
        parent.cancel(Error('peer connection lost'));
      },
    ),
  );
  pending.catch(() => {});
  const inbound = makePromiseKit();
  const observer = makePromiseKit();
  t.teardown(() => {
    inbound.reject(Error('test finished'));
    observer.reject(Error('test finished'));
  });
  remote.accept(
    gateway,
    inbound.reject,
    /** @type {Promise<never>} */ (inbound.promise),
  );
  await t.throwsAsync(() => pending, { message: /Connection abandoned/ });
  await flushJobs();
  t.true(networkClosed, 'losing network transport observes cancellation');
  t.false(
    parentLost,
    'replacing the transport must not destroy the peer formula',
  );
  t.is(peerDisposals, 0);
  t.is(remote.getStateName(), 'accepted');
  const accepted = await remote.connect(
    () => {
      throw Error('Must reuse accepted transport');
    },
    observer.reject,
    /** @type {Promise<never>} */ (observer.promise),
  );
  t.is(accepted, gateway);
  inbound.reject(Error('accepted transport closed'));
  await flushJobs();
  t.true(parentLost, 'losing the winning connection disposes the peer');
  t.is(peerDisposals, 1);
  t.is(remote.getStateName(), 'start');
});
