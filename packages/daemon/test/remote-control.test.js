import test from '@endo/ses-ava/prepare-endo.js';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit as _makePromiseKit } from '@endo/promise-kit';
import { makeRemoteControlProvider } from '../src/remote-control.js';

/** @import { PromiseKit } from '@endo/promise-kit' */

// The RemoteControl cancellation promises only reject and never fulfill.
/** @type {<T = never>() => PromiseKit<T>} */
const makePromiseKit = _makePromiseKit;

/** @returns {any} */
const makeFakeGateway = () =>
  makeExo(
    'FakeGateway',
    M.interface('FakeGateway', {}, { defaultGuards: 'passable' }),
    {
      provide() {
        throw new Error('Fake gateway provides nothing');
      },
    },
  );

test('remote control connects from initial state and propagates cancellation', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');
  const bobGateway = makeFakeGateway();
  const { promise: bobCancelled, reject: cancelBob } = makePromiseKit();

  const receivedBobGateway = bobRemoteControl.connect(
    () => bobGateway,
    cancelBob,
    bobCancelled,
  );
  t.is(receivedBobGateway, bobGateway);

  cancelBob(new Error('Peer cancelled'));
  await t.throwsAsync(() => bobCancelled);
});

test('remote control accepts from initial state and propagates cancellation', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');
  const bobGateway = makeFakeGateway();
  const { promise: bobCancelled, reject: cancelBob } = makePromiseKit();

  bobRemoteControl.accept(bobGateway, cancelBob, bobCancelled);

  cancelBob(new Error('Peer cancelled'));
  await t.throwsAsync(() => bobCancelled);
});

test('remote control connect uses existing connection after accept', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');
  const bobGateway1 = makeFakeGateway();
  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();

  bobRemoteControl.accept(bobGateway1, cancelBob1, bob1Cancelled);

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const finalBobGateway = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob2,
    bob2Cancelled,
  );
  t.is(finalBobGateway, bobGateway1);

  cancelBob1(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob1Cancelled);
  await t.throwsAsync(() => bob2Cancelled);
});

test('remote control drops outbound connect when accepting from lower id', async t => {
  const provideRemoteControl = makeRemoteControlProvider('bob');
  const bobRemoteControl = provideRemoteControl('alice');

  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();
  const bobGateway1 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob1,
    bob1Cancelled,
  );

  const bobGateway2 = makeFakeGateway();
  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  bobRemoteControl.accept(bobGateway2, cancelBob2, bob2Cancelled);

  const { promise: bob3Cancelled, reject: cancelBob3 } = makePromiseKit();
  const finalBobGateway = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob3,
    bob3Cancelled,
  );
  t.is(finalBobGateway, bobGateway1);

  cancelBob3(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob1Cancelled);
  await t.throwsAsync(() => bob2Cancelled);
  await t.throwsAsync(() => bob3Cancelled);
});

test('remote control keeps outbound connect when accepting from higher id', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');

  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();
  bobRemoteControl.connect(() => makeFakeGateway(), cancelBob1, bob1Cancelled);

  const bobGateway2 = makeFakeGateway();
  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  bobRemoteControl.accept(bobGateway2, cancelBob2, bob2Cancelled);
  await t.throwsAsync(() => bob1Cancelled);

  const { promise: bob3Cancelled, reject: cancelBob3 } = makePromiseKit();
  const finalBobGateway = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob3,
    bob3Cancelled,
  );
  t.is(finalBobGateway, bobGateway2);

  // Cancelling the unused outbound peer incarnation must not tear down the
  // accepted transport.
  let bob2Settled = false;
  bob2Cancelled.catch(() => {
    bob2Settled = true;
  });
  cancelBob3(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob3Cancelled);
  await Promise.resolve();
  await Promise.resolve();
  t.false(bob2Settled, 'accepted transport survives incarnation disposal');

  // The surviving transport still serves subsequent connects, and losing it
  // still cancels the incarnations that ride on it.
  const { promise: bob4Cancelled, reject: cancelBob4 } = makePromiseKit();
  const laterBobGateway = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob4,
    bob4Cancelled,
  );
  t.is(laterBobGateway, bobGateway2);

  cancelBob2(new Error('Connection lost'));
  await t.throwsAsync(() => bob2Cancelled);
  await t.throwsAsync(() => bob4Cancelled);
});

test('remote control reuses existing connection when reconnecting', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');

  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();
  const bobGateway1 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob1,
    bob1Cancelled,
  );

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const bobGateway2 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob2,
    bob2Cancelled,
  );
  t.is(bobGateway2, bobGateway1);

  cancelBob1(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob1Cancelled);
  await t.throwsAsync(() => bob2Cancelled);
});

test('remote control establishes new connection when reconnecting after disconnect', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');

  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();
  const { promise: bob1Disposed, resolve: disposeBob1 } = makePromiseKit();
  const bobGateway1 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob1,
    bob1Cancelled,
    /** @type {() => void} */ (disposeBob1),
  );
  cancelBob1(new Error('Disconnect'));
  await t.throwsAsync(() => bob1Cancelled);
  // Depending on the interleaving of events, it is possible that we need to
  // wait for the remote control to asynchronously transition to the initial
  // unconnected state before attempting another connection.
  // In practice, this does not appear to be necessary but explicit causal
  // relationships are more robust in the face of change.
  await bob1Disposed;

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const bobGateway2 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob2,
    bob2Cancelled,
  );
  t.not(bobGateway2, bobGateway1);

  const { promise: bob3Cancelled, reject: cancelBob3 } = makePromiseKit();
  const bobGateway3 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob3,
    bob3Cancelled,
  );
  t.is(bobGateway3, bobGateway2);

  cancelBob2(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob2Cancelled);
  await t.throwsAsync(() => bob3Cancelled);
});

test('remote control accept after accept', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');

  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();
  const bobGateway1 = makeFakeGateway();
  bobRemoteControl.accept(bobGateway1, cancelBob1, bob1Cancelled);

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const bobGateway2 = makeFakeGateway();
  bobRemoteControl.accept(bobGateway2, cancelBob2, bob2Cancelled);

  const { promise: bob3Cancelled, reject: cancelBob3 } = makePromiseKit();
  const bobGateway3 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob3,
    bob3Cancelled,
  );
  t.is(bobGateway3, bobGateway2);

  // bob1 was already cancelled when the second accept replaced it.
  await t.throwsAsync(() => bob1Cancelled);
  // Cancelling the outbound peer incarnation must not tear down the accepted
  // transport it rode on.
  let bob2Settled = false;
  bob2Cancelled.catch(() => {
    bob2Settled = true;
  });
  cancelBob3(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob3Cancelled);
  await Promise.resolve();
  await Promise.resolve();
  t.false(bob2Settled, 'accepted transport survives incarnation cancellation');

  // Losing the transport still cancels the incarnations that ride on it.
  const { promise: bob4Cancelled, reject: cancelBob4 } = makePromiseKit();
  const bobGateway4 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob4,
    bob4Cancelled,
  );
  t.is(bobGateway4, bobGateway2);

  cancelBob2(new Error('Connection lost'));
  await t.throwsAsync(() => bob2Cancelled);
  await t.throwsAsync(() => bob4Cancelled);
});

test('remote control connects first, ignores second, entagles cancellation of second peer incarnations', async t => {
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');
  const bobGateway1 = makeFakeGateway();
  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();

  const receivedBobGateway1 = bobRemoteControl.connect(
    () => bobGateway1,
    cancelBob1,
    bob1Cancelled,
  );
  t.is(receivedBobGateway1, bobGateway1);

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const receivedBobGateway2 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob2,
    bob2Cancelled,
  );
  t.is(receivedBobGateway2, bobGateway1);

  cancelBob2(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob1Cancelled);
  await t.throwsAsync(() => bob2Cancelled);
});

test('remote control connects first, ignores second, entagles cancellation of first peer incarnations', async t => {
  // This should not occur, but provided for completeness.
  // The reason this should not occur is that every new incarnation of a peer
  // should only occur after the previous incarnation is cancelled.
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');
  const bobGateway1 = makeFakeGateway();
  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();

  const receivedBobGateway1 = bobRemoteControl.connect(
    () => bobGateway1,
    cancelBob1,
    bob1Cancelled,
  );
  t.is(receivedBobGateway1, bobGateway1);

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const receivedBobGateway2 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob2,
    bob2Cancelled,
  );
  t.is(receivedBobGateway2, bobGateway1);

  cancelBob1(new Error('Peer cancelled'));
  await t.throwsAsync(() => bob1Cancelled);
  await t.throwsAsync(() => bob2Cancelled);
});

test('remote control connects first, ignores second and third, entagles cancellation of first peer incarnations', async t => {
  // This should not occur, but provided for completeness.
  // The reason this should not occur is that every new incarnation of a peer
  // should only occur after the previous incarnation is cancelled.
  const provideRemoteControl = makeRemoteControlProvider('alice');
  const bobRemoteControl = provideRemoteControl('bob');
  const bobGateway1 = makeFakeGateway();
  const { promise: bob1Cancelled, reject: cancelBob1 } = makePromiseKit();

  const receivedBobGateway1 = bobRemoteControl.connect(
    () => bobGateway1,
    cancelBob1,
    bob1Cancelled,
  );
  t.is(receivedBobGateway1, bobGateway1);

  const { promise: bob2Cancelled, reject: cancelBob2 } = makePromiseKit();
  const receivedBobGateway2 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob2,
    bob2Cancelled,
  );
  t.is(receivedBobGateway2, bobGateway1);

  const { promise: bob3Cancelled, reject: cancelBob3 } = makePromiseKit();
  const receivedBobGateway3 = bobRemoteControl.connect(
    () => makeFakeGateway(),
    cancelBob3,
    bob3Cancelled,
  );
  t.is(receivedBobGateway3, bobGateway1);

  cancelBob1(new Error('Peer cancelled'));

  await t.throwsAsync(() => bob1Cancelled);
  await t.throwsAsync(() => bob2Cancelled);
  await t.throwsAsync(() => bob3Cancelled);
});

test('remote control does not retain idle handles or disconnected ephemeral peers', async t => {
  await null;
  for (const localNode of ['a', 'z']) {
    const provide = makeRemoteControlProvider(localNode);
    for (let index = 0; index < 32; index += 1) {
      const remoteNode = `m-${index}`;
      const control = provide(remoteNode);
      t.is(control.getStateName(), 'start');
      t.deepEqual(provide.getConnectionStates(), {});

      const transport = makePromiseKit();
      const incarnation = makePromiseKit();
      const gateway = makeFakeGateway();
      if (index % 2 === 0) {
        control.accept(gateway, transport.reject, transport.promise);
      } else {
        control.connect(() => gateway, transport.reject, transport.promise);
      }
      // Exercise replacement state objects as well as the initial connected
      // state. Both node orderings must observe their latest incarnation.
      t.is(
        control.connect(
          () => makeFakeGateway(),
          incarnation.reject,
          incarnation.promise,
        ),
        gateway,
      );
      t.is(Object.keys(provide.getConnectionStates()).length, 1);
      transport.reject(new Error('Tab closed'));
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        t.throwsAsync(() => transport.promise),
        t.throwsAsync(() => incarnation.promise),
      ]);
      t.is(control.getStateName(), 'start');
      t.deepEqual(provide.getConnectionStates(), {});
    }
  }
});

test('retained handles share a replacement controller and ignore old cancellation', async t => {
  const provide = makeRemoteControlProvider('alice');
  const oldHandle = provide('bob');
  const initial = makePromiseKit();
  oldHandle.connect(() => makeFakeGateway(), initial.reject, initial.promise);
  initial.reject(new Error('First transport closed'));
  await t.throwsAsync(() => initial.promise);
  t.deepEqual(provide.getConnectionStates(), {});

  const newHandle = provide('bob');
  const replaced = makePromiseKit();
  let replacedCancelled = false;
  newHandle.accept(
    makeFakeGateway(),
    () => {
      replacedCancelled = true;
    },
    replaced.promise,
  );
  const active = makePromiseKit();
  const gateway = makeFakeGateway();
  oldHandle.accept(gateway, active.reject, active.promise);
  t.true(
    replacedCancelled,
    'old handle must replace the new handle’s current controller',
  );

  // The superseded transport's actual close can arrive after the replacement
  // is installed; it must not remove that replacement from the provider map.
  replaced.reject(new Error('Delayed old transport close'));
  await t.throwsAsync(() => replaced.promise);
  t.deepEqual(provide.getConnectionStates(), { bob: 'accepted' });
  const incarnation = makePromiseKit();
  let dialed = false;
  const received = newHandle.connect(
    () => {
      dialed = true;
      return makeFakeGateway();
    },
    incarnation.reject,
    incarnation.promise,
  );
  t.false(dialed);
  t.is(received, gateway);

  active.reject(new Error('Replacement transport closed'));
  await Promise.all([
    t.throwsAsync(() => active.promise),
    t.throwsAsync(() => incarnation.promise),
  ]);
  t.is(oldHandle.getStateName(), 'start');
  t.is(newHandle.getStateName(), 'start');
  t.deepEqual(provide.getConnectionStates(), {});
});

test('synchronous dial failure leaves no cached idle controller', t => {
  const provide = makeRemoteControlProvider('alice');
  const lifetime = makePromiseKit();
  t.throws(
    () =>
      provide('bob').connect(
        () => {
          throw new Error('Dial failed');
        },
        lifetime.reject,
        lifetime.promise,
      ),
    { message: 'Dial failed' },
  );
  t.deepEqual(provide.getConnectionStates(), {});
});
