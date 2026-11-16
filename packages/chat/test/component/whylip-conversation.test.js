// @ts-nocheck - Hook integration tests with happy-dom.
import '@endo/init/debug.js';
import test from 'ava';
import { h, render } from 'preact';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
// Hook is intentionally private; exercise it without expanding package exports.
// eslint-disable-next-line import/no-relative-packages
import { useConversation } from '../../../space-whylip/src/hooks/useConversation.js';
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

const { document } = createDOM();
const node = 'a'.repeat(64);
const self = 'b'.repeat(64);
const agent = 'c'.repeat(64);
const locator = (number, hint = '') =>
  `endo://${node}/${number}${hint}?type=handle`;
const scene = text =>
  JSON.stringify({
    narrative: text,
    scene: { title: text, html: '<p>Hello</p>' },
  });
const message = (id, number, from, text, replyTo) =>
  harden({
    type: 'package',
    messageId: id,
    number,
    from: locator(from),
    strings: [text],
    ...(replyTo ? { replyTo } : {}),
  });

const mailbox = ({ history = [], historyPromise, failSend = false } = {}) => {
  const queued = [...history];
  let pending;
  let closed = 0;
  let follows = 0;
  let listed = 0;
  const sends = [];
  const push = value => {
    if (pending) {
      pending.resolve(harden({ done: false, value }));
      pending = undefined;
    } else queued.push(value);
  };
  const iterator = {
    next() {
      if (queued.length) return harden({ done: false, value: queued.shift() });
      pending = makePromiseKit();
      return pending.promise;
    },
    return() {
      closed += 1;
      pending?.resolve(harden({ done: true, value: undefined }));
      return harden({ done: true, value: undefined });
    },
  };
  const reader = readerFromIterator(iterator, {
    cancelPending: () => iterator.return(),
  });
  const powers = Far('book mailbox', {
    locate: () => locator(self, '@tcp%2Bnetstring%3A%2F%2Flocalhost%3A1234'),
    listMessages: () => {
      listed += 1;
      return historyPromise || harden(history);
    },
    followMessages: () => {
      follows += 1;
      return reader;
    },
    send: (...args) => {
      sends.push(args);
      if (failSend) throw Error('delivery failed');
    },
  });
  return {
    powers,
    push,
    sends,
    get closed() {
      return closed;
    },
    get follows() {
      return follows;
    },
    get listed() {
      return listed;
    },
  };
};
const mount = (t, powers) => {
  const container = document.createElement('div');
  document.body.append(container);
  let current;
  const Harness = props => {
    current = useConversation(props.powers);
    return null;
  };
  const update = next => render(h(Harness, { powers: next }), container);
  update(powers);
  t.teardown(() => {
    render(null, container);
    container.remove();
  });
  return {
    update,
    get state() {
      return current;
    },
    unmount: () => render(null, container),
  };
};

test.serial(
  'mailbox identity ignores hints and snapshot replay preserves roles and reply links',
  async t => {
    const user = message('u1', 1n, self, 'Hello');
    const reply = message('a1', 2n, agent, scene('Welcome'), 'u1');
    const box = mailbox({ history: [user, reply] });
    const ui = mount(t, box.powers);
    await waitFor(() => box.follows && ui.state.nodes.length === 2);
    box.push(reply);
    await tick(50);
    t.deepEqual(
      ui.state.nodes.map(n => n.role),
      ['user', 'assistant'],
    );
    t.is(ui.state.nodes[1].parentId, ui.state.nodes[0].id);
    t.is(ui.state.activeNarrative, 'Welcome');
    t.is(ui.state.activeScene.title, 'Welcome');
    ui.unmount();
    await waitFor(() => box.closed);
    t.true(box.closed > 0);
  },
);

test.serial(
  'own live messages are authoritative, deduplicated, and thread replies and branches',
  async t => {
    const box = mailbox();
    const ui = mount(t, box.powers);
    await waitFor(() => box.follows);
    await ui.state.send('Start');
    t.is(
      ui.state.nodes.length,
      0,
      'no speculative node before mailbox acknowledgement',
    );
    const user = message('u1', 1n, self, 'Start');
    const reply = message('a1', 2n, agent, scene('First'), 'u1');
    box.push(user);
    box.push(user);
    box.push(reply);
    box.push(reply);
    await waitFor(() => ui.state.nodes.length === 2 && !ui.state.sending);
    await tick(30);
    t.deepEqual(
      ui.state.nodes.map(n => n.role),
      ['user', 'assistant'],
    );
    t.is(ui.state.nodes[1].parentId, ui.state.nodes[0].id);
    await ui.state.send('Continue');
    t.is(box.sends[1][4], 2n, 'reply uses local mailbox number, not a tree id');
    await ui.state.navigateTo(ui.state.nodes[0].id);
    await tick();
    await ui.state.send('Branch');
    t.is(box.sends[2][4], 1n);
  },
);

test.serial(
  'failed sends leave no ghost user node and clear sending',
  async t => {
    const box = mailbox({ failSend: true });
    const ui = mount(t, box.powers);
    await waitFor(() => box.follows);
    await ui.state.send('Failed');
    await tick();
    t.deepEqual(ui.state.nodes, []);
    t.false(ui.state.sending);
  },
);

test.serial(
  'switching books clears prior state and closes the previous live subscription',
  async t => {
    const old = mailbox({ history: [message('old', 1n, agent, scene('Old'))] });
    const fresh = mailbox();
    const ui = mount(t, old.powers);
    await waitFor(() => old.follows && ui.state.activeScene);
    ui.update(fresh.powers);
    await waitFor(() => fresh.follows && old.closed);
    t.deepEqual(ui.state.nodes, []);
    t.is(ui.state.activeScene, null);
    t.is(ui.state.activeNodeId, null);
    t.is(ui.state.activeNarrative, '');
  },
);

test.serial(
  'late initialization of a previous book cannot populate the new book',
  async t => {
    const delayed = makePromiseKit();
    const old = mailbox({ historyPromise: delayed.promise });
    const fresh = mailbox({
      history: [message('new', 1n, agent, scene('New'))],
    });
    const ui = mount(t, old.powers);
    await waitFor(() => old.listed);
    ui.update(fresh.powers);
    await waitFor(() => ui.state.activeNarrative === 'New');
    delayed.resolve(harden([message('old', 1n, agent, scene('Old'))]));
    await tick(50);
    t.is(ui.state.nodes.length, 1);
    t.is(ui.state.activeNarrative, 'New');
    t.is(old.follows, 0);
  },
);

test.serial(
  'format retry replies to the malformed mailbox message and corrected reply recovers',
  async t => {
    const box = mailbox();
    const ui = mount(t, box.powers);
    await waitFor(() => box.follows);
    await ui.state.send('Start');
    box.push(message('u1', 1n, self, 'Start'));
    box.push(message('a1', 2n, agent, '{"narrative":', 'u1'));
    await waitFor(() => box.sends.length === 2);
    t.is(box.sends[1][4], 2n);
    const correction = message('u2', 3n, self, box.sends[1][1][0], 'a1');
    box.push(correction);
    box.push(message('a2', 4n, agent, scene('Corrected'), 'u2'));
    await waitFor(
      () => ui.state.activeNarrative === 'Corrected' && !ui.state.sending,
    );
    t.deepEqual(
      ui.state.nodes.map(n => n.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    t.is(ui.state.nodes[3].parentId, ui.state.nodes[2].id);
    t.is(ui.state.activeScene.title, 'Corrected');
  },
);
