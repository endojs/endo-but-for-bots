// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { formatLocator, formatLocatorWithHints } from '@endo/daemon/locator.js';

import {
  assertSubagentName,
  isSameFormula,
  makeSubagentDelegations,
  makeSubagentTools,
  messageText,
} from '../src/subagent.js';

const NODE = 'a'.repeat(64);
const PARENT = 'b'.repeat(64);
const CHILD = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

/**
 * @param {string} number
 * @param {string[]} [hints]
 */
const locatorFor = (number, hints = []) =>
  hints.length === 0
    ? formatLocator(`${number}:${NODE}`, 'handle')
    : formatLocatorWithHints(`${number}:${NODE}`, 'handle', hints);

/**
 * A mailbox stub that behaves like the daemon's: `send` posts the message to
 * the recipient and echoes it into the sender's own stream first, and `reply`
 * stamps the parent message's `messageId` as `replyTo`.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.names]
 */
const makeMailbox = ({ names = { subagents: 'directory' } } = {}) => {
  /** @type {any[]} */
  const stream = [];
  let nextNumber = 1n;
  let nextId = 0;
  /** @type {() => void} */
  let notifySent = () => {};
  /** Settles once the daemon has echoed a send into the sender's stream. */
  let whenSent = new Promise(resolve => {
    notifySent = () => resolve(undefined);
  });
  const powers = Far('Powers', {
    /** @param {string | string[]} path */
    locate: async path => {
      const key = Array.isArray(path) ? path.join('/') : path;
      const found = names[key];
      if (found === undefined) return undefined;
      return found;
    },
    has: async (...path) => names[path.join('/')] !== undefined,
    makeDirectory: async () => {},
    remove: async () => {},
    storeLocator: async (path, locator) => {
      names[Array.isArray(path) ? path.join('/') : path] = locator;
    },
    send: async (path, strings) => {
      const key = Array.isArray(path) ? path.join('/') : path;
      nextId += 1;
      stream.push(
        harden({
          type: 'package',
          from: locatorFor(PARENT),
          to: names[key],
          strings: harden([...strings]),
          names: harden([]),
          messageId: `out-${nextId}`,
          number: nextNumber,
        }),
      );
      nextNumber += 1n;
      notifySent();
      whenSent = new Promise(resolve => {
        notifySent = () => resolve(undefined);
      });
    },
  });
  /**
   * @param {object} options
   * @param {string} options.from
   * @param {string} options.replyTo
   * @param {string} options.text
   * @param {string[]} [options.edgeNames]
   */
  const deliverReply = ({ from, replyTo, text, edgeNames = [] }) => {
    const message = harden({
      type: 'package',
      from,
      to: locatorFor(PARENT),
      strings: harden([text, ...edgeNames.map(() => '')]),
      names: harden([...edgeNames]),
      messageId: `in-${nextNumber}`,
      replyTo,
      number: nextNumber,
    });
    nextNumber += 1n;
    stream.push(message);
    return message;
  };
  return {
    powers,
    stream,
    deliverReply,
    names,
    whenSent: () => whenSent,
  };
};

/** Timers that fire only when the test says so. */
const makeManualTimers = () => {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let nextHandle = 0;
  return {
    timers: {
      setTimeout: (/** @type {() => void} */ callback) => {
        nextHandle += 1;
        pending.set(nextHandle, callback);
        return nextHandle;
      },
      clearTimeout: (/** @type {number} */ handle) => {
        pending.delete(handle);
      },
    },
    fireAll: () => {
      for (const callback of [...pending.values()]) callback();
      pending.clear();
    },
    pendingCount: () => pending.size,
  };
};

test('subagent names are restricted to a shape that is unambiguous as a pet name', t => {
  t.is(assertSubagentName('researcher'), 'researcher');
  t.is(assertSubagentName('a-b-9'), 'a-b-9');
  for (const bad of [
    '',
    'Researcher',
    '9lives',
    'has space',
    'has/slash',
    '@special',
    'x'.repeat(33),
    42,
    undefined,
  ]) {
    t.throws(() => assertSubagentName(/** @type {any} */ (bad)), {
      message: /must match/,
    });
  }
});

test('locator identity ignores the transport hints locate() appends', t => {
  t.true(
    isSameFormula(locatorFor(CHILD), locatorFor(CHILD, ['tcp/1.2.3.4:1'])),
  );
  t.false(isSameFormula(locatorFor(CHILD), locatorFor(OTHER)));
  t.false(isSameFormula(locatorFor(CHILD), 'not-a-locator'));
  t.false(isSameFormula(undefined, locatorFor(CHILD)));
});

test('message text interleaves strings and edge names', t => {
  t.is(
    messageText(
      harden({
        type: 'package',
        strings: harden(['here is ', ' for you']),
        names: harden(['counter']),
      }),
    ),
    'here is @counter for you',
  );
  t.is(messageText(harden({ type: 'request' })), '(request message)');
});

test('askSubagent resolves with the reply the subagent mails back', async t => {
  const mailbox = makeMailbox({
    names: { 'subagents/helper': locatorFor(CHILD) },
  });
  const { timers } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });

  const answerP = delegations.ask({
    name: 'helper',
    task: 'summarize the design',
    timeoutSeconds: 30,
  });
  await mailbox.whenSent();
  // The daemon echoes our own send into our stream; the loop offers it first.
  t.is(mailbox.stream.length, 1);
  t.deepEqual(delegations.claim(mailbox.stream[0]), {
    claimed: false,
    dismissable: false,
  });

  const reply = mailbox.deliverReply({
    from: locatorFor(CHILD),
    replyTo: 'out-1',
    text: 'the design is sound',
  });
  t.deepEqual(delegations.claim(reply), { claimed: true, dismissable: true });

  const answer = await answerP;
  t.is(answer.text, 'the design is sound');
  t.deepEqual(answer.edgeNames, []);
});

test('a reply carrying capabilities stays in the inbox for adoption', async t => {
  const mailbox = makeMailbox({
    names: { 'subagents/helper': locatorFor(CHILD) },
  });
  const { timers } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  const answerP = delegations.ask({
    name: 'helper',
    task: 'find me a tool',
    timeoutSeconds: 30,
  });
  await mailbox.whenSent();
  delegations.claim(mailbox.stream[0]);
  const reply = mailbox.deliverReply({
    from: locatorFor(CHILD),
    replyTo: 'out-1',
    text: 'here it is: ',
    edgeNames: ['grep'],
  });
  t.deepEqual(delegations.claim(reply), { claimed: true, dismissable: false });
  const answer = await answerP;
  t.deepEqual(answer.edgeNames, ['grep']);
});

test('a reply from a different sender does not settle the delegation', async t => {
  const mailbox = makeMailbox({
    names: { 'subagents/helper': locatorFor(CHILD) },
  });
  const { timers, fireAll } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  const answerP = delegations.ask({
    name: 'helper',
    task: 'do the thing',
    timeoutSeconds: 30,
  });
  await mailbox.whenSent();
  delegations.claim(mailbox.stream[0]);

  // Same replyTo, wrong sender: an impostor must not be able to answer.
  const forged = mailbox.deliverReply({
    from: locatorFor(OTHER),
    replyTo: 'out-1',
    text: 'I am not your subagent',
  });
  t.deepEqual(delegations.claim(forged), {
    claimed: false,
    dismissable: false,
  });

  fireAll();
  await t.throwsAsync(answerP, { message: /did not reply within/ });
});

test('a late reply is no longer claimable and falls through to the inbox', async t => {
  const mailbox = makeMailbox({
    names: { 'subagents/helper': locatorFor(CHILD) },
  });
  const { timers, fireAll, pendingCount } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  const answerP = delegations.ask({
    name: 'helper',
    task: 'slow work',
    timeoutSeconds: 1,
  });
  await mailbox.whenSent();
  delegations.claim(mailbox.stream[0]);
  fireAll();
  await t.throwsAsync(answerP, { message: /did not reply within/ });
  // The timer is released, so a timed-out ask leaves nothing behind.
  t.is(pendingCount(), 0);

  const late = mailbox.deliverReply({
    from: locatorFor(CHILD),
    replyTo: 'out-1',
    text: 'sorry, took a while',
  });
  t.deepEqual(delegations.claim(late), { claimed: false, dismissable: false });
});

test('two questions to one subagent at a time are refused', async t => {
  const mailbox = makeMailbox({
    names: { 'subagents/helper': locatorFor(CHILD) },
  });
  const { timers, fireAll } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  const first = delegations.ask({
    name: 'helper',
    task: 'first',
    timeoutSeconds: 30,
  });
  await mailbox.whenSent();
  await t.throwsAsync(
    delegations.ask({ name: 'helper', task: 'second', timeoutSeconds: 30 }),
    { message: /already has a question in flight/ },
  );
  fireAll();
  await t.throwsAsync(first);
});

test('asking an unknown subagent fails before any mail is sent', async t => {
  const mailbox = makeMailbox({ names: {} });
  const { timers } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  await t.throwsAsync(
    delegations.ask({ name: 'ghost', task: 'anything', timeoutSeconds: 30 }),
    { message: /No subagent named/ },
  );
  t.is(mailbox.stream.length, 0);
});

test('ask rejects an out-of-range timeout and an oversized task', async t => {
  const mailbox = makeMailbox({
    names: { 'subagents/helper': locatorFor(CHILD) },
  });
  const { timers } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  await t.throwsAsync(
    delegations.ask({ name: 'helper', task: 'x', timeoutSeconds: 0 }),
    { message: /whole number of seconds/ },
  );
  await t.throwsAsync(
    delegations.ask({ name: 'helper', task: 'x', timeoutSeconds: 10_000 }),
    { message: /whole number of seconds/ },
  );
  await t.throwsAsync(
    delegations.ask({
      name: 'helper',
      task: 'x'.repeat(32_769),
      timeoutSeconds: 30,
    }),
    { message: /at most/ },
  );
  t.is(mailbox.stream.length, 0);
});

test('spawnSubagent binds the subagent under the parent’s own authority', async t => {
  const mailbox = makeMailbox({ names: {} });
  const { timers } = makeManualTimers();
  const delegations = makeSubagentDelegations({
    powers: mailbox.powers,
    timers,
  });
  /** @type {any[]} */
  const spawned = [];
  const spawner = Far('SubagentSpawner', {
    spawn: async (name, options) => {
      spawned.push({ name, options });
      return harden({ name, locator: locatorFor(CHILD) });
    },
    stop: async name => {
      spawned.push({ stopped: name });
    },
  });
  const tools = makeSubagentTools({
    powers: mailbox.powers,
    spawner,
    delegations,
  });

  const spawnTool = /** @type {any} */ (tools.get('spawnSubagent'));
  const result = await spawnTool.execute(
    harden({ name: 'helper', systemPrompt: 'be terse' }),
  );
  t.regex(result, /Spawned subagent "helper"/);
  t.deepEqual(spawned[0], {
    name: 'helper',
    options: { systemPrompt: 'be terse' },
  });
  // The spawner returned a locator; the parent, not the spawner, bound it.
  t.is(mailbox.names['subagents/helper'], locatorFor(CHILD));

  await t.throwsAsync(spawnTool.execute(harden({ name: 'Bad Name' })), {
    message: /must match/,
  });
});

test('every subagent tool advertises a well-formed schema', t => {
  const mailbox = makeMailbox({ names: {} });
  const { timers } = makeManualTimers();
  const tools = makeSubagentTools({
    powers: mailbox.powers,
    spawner: Far('SubagentSpawner', {}),
    delegations: makeSubagentDelegations({ powers: mailbox.powers, timers }),
  });
  t.deepEqual([...tools.keys()].sort(), [
    'askSubagent',
    'spawnSubagent',
    'stopSubagent',
  ]);
  for (const [name, tool] of tools) {
    const schema = tool.schema();
    t.is(schema.type, 'function');
    t.is(schema.function.name, name);
    t.true(schema.function.description.length > 0);
    t.is(schema.function.parameters.type, 'object');
    t.true(typeof tool.help() === 'string');
  }
});
