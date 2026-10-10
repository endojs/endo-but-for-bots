// @ts-check
// The PRNG and bounded payload identifiers deliberately use 32-bit arithmetic.
/* eslint-disable no-bitwise */
// Each fault transition must finish before the next model transition begins.
/* eslint-disable no-await-in-loop */
import test from '@endo/ses-ava/test.js';

import {
  greet,
  headerOf,
  makeNetwork,
  makeNode,
  makeState,
  onlyRecord,
} from './_delivery-network.js';

// xorshift32: the seed is a 32-bit PRNG state, not a protocol quantity.
/** @param {number} seed */
const makeRandom = seed => {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
};

for (const seed of [1, 42, 0xdead_beef, 0x1234_5678]) {
  test(`delivery state machine converges after adversarial trace, seed ${seed}`, async t => {
    t.timeout(15_000);
    const random = makeRandom(seed);
    const network = makeNetwork();
    const states = [makeState(), makeState()];
    const names = ['a', 'b'];
    const nodes = [
      await makeNode(network, 'a', states[0]),
      await makeNode(network, 'b', states[1]),
    ];
    t.teardown(() => {
      for (const node of nodes) node.layer.shutdown();
      network.disconnect();
    });
    nodes[0].layer.connect({ name: 'b' });
    greet(network);
    /** The model records accepted sends, independently of transport state. */
    /** @type {number[][][]} */
    const sent = [[], []];
    /** @type {string[]} */
    const trace = [];
    /** @param {number} side */
    const restart = async side => {
      network.disconnect();
      nodes[side].layer.shutdown();
      nodes[side] = await makeNode(network, names[side], states[side]);
      nodes[side].layer.start();
    };
    const check = () => {
      for (const side of [0, 1]) {
        // Each received prefix must exactly match accepted sends from the peer.
        // This catches duplicates, reordering, and fabricated payloads at every
        // step, rather than merely comparing the final message count.
        const actual = states[side].delivered.map(({ bytes }) => bytes);
        t.deepEqual(
          states[side].delivered.map(({ n }) => n),
          actual.map((bytes, index) => BigInt(index + 1)),
        );
        t.deepEqual(actual, sent[1 - side].slice(0, actual.length));
        const record = onlyRecord(states[side]);
        t.true(BigInt(record.ackSeq) <= BigInt(record.sendSeq));
        t.is(
          record.frames.length,
          Number(BigInt(record.sendSeq) - BigInt(record.ackSeq)),
        );
      }
    };
    try {
      for (let step = 0; step < 400; step += 1) {
        const action = random() % 10;
        trace.push(`${step}:${action}`);
        if (action < 4) {
          const side = action % 2;
          // The two-byte identifier is bounded by this test's 400-step trace.
          const id = sent[side].length + 1;
          const bytes = [side, id >>> 8, id & 255];
          t.true(
            nodes[side].connections[0].write(new Uint8Array(bytes), String(id)),
          );
          sent[side].push(bytes);
        } else if (action < 6 && network.queue.length) {
          const budget = action === 5 ? 8 : 1;
          for (let i = 0; i < budget && network.queue.length; i += 1) {
            network.pumpOne();
          }
        } else if (action === 6 && network.queue.length) {
          const entry = network.queue[0];
          const type = headerOf(entry.bytes).t;
          if (type === 'f' || type === 'ack') {
            // Duplicate adjacent messages without violating stream ordering.
            network.queue.splice(1, 0, { ...entry, after: undefined });
          }
        } else if (action === 7 && network.queue.length) {
          // Loss of stream data means the remaining stream is unusable.
          // Dropping its entire suffix avoids inventing datagram semantics.
          network.disconnect();
        } else if (action === 8) {
          await restart(random() % 2);
        } else if (action === 9) {
          network.setRejectDials((random() & 1) === 1);
          await restart(0);
        }
        check();
      }

      // Stop injecting faults and explicitly restart the dialing peer. The
      // harness has no real reconnect timers; convergence has a bounded pump.
      network.setRejectDials(false);
      await restart(0);
      let pumps = 0;
      while (network.queue.length && pumps < 2000) {
        network.pumpOne();
        pumps += 1;
      }
      t.is(
        network.queue.length,
        0,
        'recovery converges within the pump budget',
      );
      check();
      for (const side of [0, 1]) {
        t.deepEqual(
          states[side].delivered.map(({ bytes }) => bytes),
          sent[1 - side],
        );
        t.is(onlyRecord(states[side]).frames.length, 0);
        t.is(onlyRecord(states[side]).inbox.length, 0);
        t.true(
          sent[side].length > 30,
          'trace exercised substantial bidirectional traffic',
        );
      }

      // Freeze the effects oracle, then accept a new bidirectional suffix
      // without pumping either invocation. Retirement terminally disposes of
      // these obligations; it must not dispatch them during recovery.
      const effectsBeforeRetirement = states.map(state =>
        state.delivered.map(({ n, bytes }) => ({ n, bytes: [...bytes] })),
      );
      const originalTokens = states.map(state => [...state.records.keys()]);
      const originalConnections = nodes.map(node => node.connections[0]);
      for (const side of [0, 1]) {
        const id = sent[side].length + 1;
        t.true(
          originalConnections[side].write(
            new Uint8Array([side, 255, 255]),
            String(id),
          ),
        );
        t.is(onlyRecord(states[side]).frames.length, 1);
      }
      t.is(
        network.queue.filter(entry => headerOf(entry.bytes).t === 'f').length,
        2,
        'both accepted invocations are still in flight',
      );
      // Lose the queued frames and terminal notice, then restart both roles.
      const retiringSide = seed % 2;
      originalConnections[retiringSide].end();
      t.is(onlyRecord(states[retiringSide]).frames.length, 0);
      t.is(onlyRecord(states[1 - retiringSide]).frames.length, 1);
      network.disconnect();
      await restart(1);
      await restart(0);
      pumps = 0;
      while (network.queue.length && pumps < 20) {
        network.pumpOne();
        pumps += 1;
      }
      t.is(network.queue.length, 0, 'retirement converges');
      for (const side of [0, 1]) {
        t.true(onlyRecord(states[side]).retired);
        t.is(onlyRecord(states[side]).frames.length, 0);
        t.is(onlyRecord(states[side]).inbox.length, 0);
        t.deepEqual([...states[side].records.keys()], originalTokens[side]);
        t.false(originalConnections[side].write(new Uint8Array([99]), '999'));
        t.is(
          states[side].records.size,
          1,
          'recovery cannot create a fresh session',
        );
        if (nodes[side].connections.length) {
          t.false(
            nodes[side].connections[0].write(new Uint8Array([99]), '999'),
          );
        }
        t.deepEqual(states[side].delivered, effectsBeforeRetirement[side]);
      }
    } catch (error) {
      t.log(`Replay seed ${seed}; trace: ${trace.join(' ')}`);
      throw error;
    }
  });
}
