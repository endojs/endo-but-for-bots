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

const makeConnection = () => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  const { promise: disposed, resolve } = _makePromiseKit();
  return { cancelled, cancel, disposed, dispose: () => resolve(undefined) };
};

for (const [local, remote] of [
  ['alice', 'bob'],
  ['bob', 'alice'],
]) {
  for (const cancelledIncarnation of [0, 2]) {
    test(`remote control ${local}→${remote} resets after repeated connect and cancellation of incarnation ${cancelledIncarnation}`, async t => {
      t.timeout(5000);
      const control = makeRemoteControlProvider(local)(remote);
      const gateway = makeFakeGateway();
      const connections = [
        makeConnection(),
        makeConnection(),
        makeConnection(),
      ];
      let dials = 0;
      for (const connection of connections) {
        const actual = control.connect(
          () => {
            dials += 1;
            return gateway;
          },
          connection.cancel,
          connection.cancelled,
          connection.dispose,
        );
        t.is(actual, gateway);
      }
      t.is(dials, 1, 'live connection is shared by later incarnations');
      connections[cancelledIncarnation].cancel(new Error('Transport closed'));
      await Promise.all(connections.map(connection => connection.disposed));
      t.is(
        control.getStateName(),
        'start',
        'current state releases the cancelled connection',
      );

      const next = makeConnection();
      const nextGateway = makeFakeGateway();
      const actual = control.connect(
        () => {
          dials += 1;
          return nextGateway;
        },
        next.cancel,
        next.cancelled,
        next.dispose,
      );
      t.is(
        actual,
        nextGateway,
        'retry must dial instead of returning the dead gateway',
      );
      t.is(dials, 2);
      t.is(control.getStateName(), 'connected');
      next.cancel(new Error('Test complete'));
      await next.disposed;
      t.is(control.getStateName(), 'start');
    });
  }

  test(`remote control ${local}→${remote} retains the winning connection across repeated accepts and resets when it closes`, async t => {
    t.timeout(5000);
    const control = makeRemoteControlProvider(local)(remote);
    const outgoing = makeConnection();
    const outgoingGateway = makeFakeGateway();
    control.connect(
      () => outgoingGateway,
      outgoing.cancel,
      outgoing.cancelled,
      outgoing.dispose,
    );
    const incoming1 = makeConnection();
    const incoming2 = makeConnection();
    const incomingGateway1 = makeFakeGateway();
    const incomingGateway2 = makeFakeGateway();
    control.accept(
      incomingGateway1,
      incoming1.cancel,
      incoming1.cancelled,
      incoming1.dispose,
    );
    control.accept(
      incomingGateway2,
      incoming2.cancel,
      incoming2.cancelled,
      incoming2.dispose,
    );
    const connectBias = local > remote;
    await Promise.all(
      connectBias
        ? [incoming1.disposed, incoming2.disposed]
        : [outgoing.cancelled.catch(() => {}), incoming1.disposed],
    );
    if (connectBias) {
      t.is(
        control.getStateName(),
        'connected',
        'rejected inbound cancellation must not reset the outbound state',
      );
    } else {
      t.is(
        control.getStateName(),
        'accepted',
        'superseded transport cancellation must not reset the winning inbound state',
      );
    }
    const rider = makeConnection();
    t.is(
      control.connect(
        () => makeFakeGateway(),
        rider.cancel,
        rider.cancelled,
        rider.dispose,
      ),
      connectBias ? outgoingGateway : incomingGateway2,
    );
    const winner = connectBias ? outgoing : incoming2;
    winner.cancel(new Error('Winning transport closed'));
    await Promise.all([winner.disposed, outgoing.disposed, rider.disposed]);
    t.is(control.getStateName(), 'start');

    const retry = makeConnection();
    const freshGateway = makeFakeGateway();
    t.is(
      control.connect(
        () => freshGateway,
        retry.cancel,
        retry.cancelled,
        retry.dispose,
      ),
      freshGateway,
    );
    retry.cancel(new Error('Test complete'));
    await retry.disposed;
  });
}

test('crossed hellos transfer all peer disposals to the winning accepted transport', async t => {
  t.timeout(5000);
  const control = makeRemoteControlProvider('alice')('bob');
  const peers = [makeConnection(), makeConnection(), makeConnection()];
  const disposalCounts = [0, 0, 0];
  const gateway = makeFakeGateway();
  for (const [index, peer] of peers.entries()) {
    control.connect(
      () => gateway,
      peer.cancel,
      peer.cancelled,
      () => {
        disposalCounts[index] += 1;
        peer.dispose();
      },
    );
  }
  const inbound1 = makeConnection();
  const pendingGateway = makePromiseKit();
  control.accept(
    pendingGateway.promise,
    inbound1.cancel,
    inbound1.cancelled,
    inbound1.dispose,
  );
  await Promise.all(peers.map(peer => peer.cancelled.catch(() => {})));
  t.deepEqual(
    disposalCounts,
    [0, 0, 0],
    'abandoned dial must not dispose attached peer formulas',
  );
  t.is(control.getStateName(), 'accepted');

  const inbound2 = makeConnection();
  const winningGateway = makeFakeGateway();
  control.accept(
    winningGateway,
    inbound2.cancel,
    inbound2.cancelled,
    inbound2.dispose,
  );
  await inbound1.disposed;
  t.deepEqual(
    disposalCounts,
    [0, 0, 0],
    'second replacement also preserves all peer formulas',
  );
  const retry = makeConnection();
  t.is(
    control.connect(
      () => {
        throw Error('Must reuse accepted gateway');
      },
      retry.cancel,
      retry.cancelled,
      retry.dispose,
    ),
    winningGateway,
  );
  inbound2.cancel(new Error('Winning transport lost'));
  await Promise.all([
    ...peers.map(peer => peer.disposed),
    retry.disposed,
    inbound2.disposed,
  ]);
  t.deepEqual(
    disposalCounts,
    [1, 1, 1],
    'every attached incarnation disposes exactly once',
  );
  t.is(control.getStateName(), 'start');
});

test('replacing an established gateway revokes its peer incarnation without resetting the accepted winner', async t => {
  t.timeout(5000);
  const control = makeRemoteControlProvider('alice')('bob');
  const outgoing = makeConnection();
  const gateway = makeFakeGateway();
  control.connect(
    () => gateway,
    outgoing.cancel,
    outgoing.cancelled,
    outgoing.dispose,
  );
  // Allow the gateway establishment observer to run before replacement.
  await Promise.resolve();
  const inbound = makeConnection();
  const winner = makeFakeGateway();
  control.accept(winner, inbound.cancel, inbound.cancelled, inbound.dispose);
  await outgoing.disposed;
  t.is(control.getStateName(), 'accepted');
  const rider = makeConnection();
  t.is(
    control.connect(
      () => {
        throw Error('Must reuse the accepted winner');
      },
      rider.cancel,
      rider.cancelled,
      rider.dispose,
    ),
    winner,
  );
  inbound.cancel(Error('Test complete'));
  await Promise.all([inbound.disposed, rider.disposed]);
  t.is(control.getStateName(), 'start');
});

test('disposal callbacks can reconnect after the current transport resets', async t => {
  t.timeout(5000);
  const control = makeRemoteControlProvider('bob')('alice');
  const first = makeConnection();
  const next = makeConnection();
  const nextGateway = makeFakeGateway();
  let actual;
  control.connect(
    () => makeFakeGateway(),
    first.cancel,
    first.cancelled,
    () => {
      actual = control.connect(
        () => nextGateway,
        next.cancel,
        next.cancelled,
        next.dispose,
      );
      first.dispose();
    },
  );
  first.cancel(Error('Lost transport'));
  await first.disposed;
  t.is(actual, nextGateway);
  t.is(control.getStateName(), 'connected');
  next.cancel(Error('Test complete'));
  await next.disposed;
  t.is(control.getStateName(), 'start');
});
