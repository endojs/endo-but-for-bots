// @ts-check
// W5.7 packages and mentions (designs/m5-interfaces.md 2.6): the queue's
// attachments and receipt fingerprint, the attachment refusals, and in the
// real session over in-memory fakes: the R4-29 line on every round of the
// turn only, `TurnStarted.attachments`, `adopt` into the label map in the
// issuing crank, `noPackage` after the turn, the package closed at settle
// and by recovery, `adoptTool` through a grants part, held entries keeping
// their attachments across a restart hold.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeQueue } from '../../guest/session/queue.js';
import { makeSession } from '../../guest/session/session.js';
import {
  checkAttachments,
  makePackages,
  packagesPart,
} from '../../guest/session/packages.js';
import {
  mentionHooks,
  packageToolEntries,
} from '../../guest/session/tools/mentions.js';
import { toolTable } from '../../guest/session/tool-table.js';
import { turnHooks } from '../../guest/session/turn-hooks.js';
import { m5Parts } from '../../guest/session/m5-parts.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

const drain = () => new Promise(resolve => setImmediate(resolve));
/** Microtasks only: what settles in the issuing crank. */
const microtasks = async (n = 500) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

const AT = 1_700_000_000_000;
let serial = 0;
const requestId = () => {
  serial += 1;
  return `${AT}-00000000-0000-4000-8000-${`${serial}`.padStart(12, '0')}`;
};
const usage = harden({
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/** @param {string[]} labels */
const attach = labels =>
  harden(labels.map(label => harden({ label, value: Far(label, {}) })));

// ---------------------------------------------------------------- queue

test('queue: entries keep attachments; the fingerprint covers the labels', t => {
  const queue = makeQueue();
  const [a, b] = attach(['notes', 'calc']);
  const id = requestId();
  const first = queue.enqueueOnce(harden({ text: 'hi' }), id, AT, [a, b]);
  t.true(first.added);
  const item = /** @type {any} */ (queue.first());
  t.deepEqual(
    item.attachments.map((/** @type {any} */ x) => x.value),
    [a.value, b.value],
  );
  // Same text and labels: a duplicate (other objects do not matter).
  const again = queue.enqueueOnce(
    harden({ text: 'hi' }),
    id,
    AT,
    attach(['notes', 'calc']),
  );
  t.false(again.added);
  t.true(again.receipt.duplicate);
  for (const other of [
    attach(['calc', 'notes']),
    attach(['notes']),
    undefined,
    harden([]),
  ]) {
    t.throws(() => queue.enqueueOnce(harden({ text: 'hi' }), id, AT, other), {
      message: texts.requestIdReused,
    });
  }
  // An id first used without attachments refuses them on a retry.
  const plain = requestId();
  queue.enqueueOnce(harden({ text: 'p' }), plain, AT);
  t.false(queue.enqueueOnce(harden({ text: 'p' }), plain, AT, []).added);
  t.throws(() => queue.enqueueOnce(harden({ text: 'p' }), plain, AT, [a]), {
    message: texts.requestIdReused,
  });
});

test('queue: edit keeps attachments; cancel and claim drop them from the entry', t => {
  const queue = makeQueue();
  const atts = attach(['notes']);
  const r1 = queue.enqueueOnce(harden({ text: 'one' }), requestId(), AT, atts);
  const r2 = queue.enqueueOnce(harden({ text: 'two' }), requestId(), AT, atts);
  const entry1 = /** @type {any} */ (r1.receipt.entry);
  entry1.edit(harden({ text: 'one!' }));
  const head = /** @type {any} */ (queue.first());
  t.is(head.submission.text, 'one!');
  t.is(head.attachments, atts);
  queue.claim(head, 't1');
  t.is(head.attachments, atts, 'the claimed item itself is unchanged');
  t.false(
    queue.items().some(i => i === head),
    'the entry left the queue',
  );
  const second = /** @type {any} */ (queue.first());
  t.is(second.attachments, atts);
  /** @type {any} */ (r2.receipt.entry).cancel();
  t.is(queue.size(), 0);
  // The cancelled exo no longer reaches the attachments: its view is gone
  // and a new queue item would be needed to hold them.
  t.throws(() => /** @type {any} */ (r2.receipt.entry).describe(), {
    message: texts.entryGone,
  });
});

test('checkAttachments refuses before anything is written', t => {
  const text = harden({ text: 'x' });
  t.notThrows(() => checkAttachments(text, attach(['notes', 'calc'])));
  t.throws(
    () =>
      checkAttachments(
        text,
        attach(Array.from({ length: 33 }, (_, i) => `a${i}`)),
      ),
    { message: textOf.tooManyAttachments(33) },
  );
  t.throws(() => checkAttachments(text, attach(['a', 'a'])), {
    message: textOf.duplicateAttachment('a'),
  });
  for (const bad of ['user', 'a/b', 'x@y', '..', ' ', 'tools']) {
    t.throws(() => checkAttachments(text, attach([bad])), {
      message: textOf.reservedLabel(bad),
    });
  }
  const max = limits.packageTextUnits;
  t.notThrows(() =>
    checkAttachments(harden({ text: 'é'.repeat(max) }), attach(['a'])),
  );
  t.throws(
    () =>
      checkAttachments(harden({ text: 'x'.repeat(max + 1) }), attach(['a'])),
    { message: textOf.packageTooLong(max + 1) },
  );
  const staged = (/** @type {number} */ bytes) =>
    harden({ blob: Far('Blob', {}), bytes, preview: 'p', digest: 'd' });
  t.notThrows(() => checkAttachments(staged(3 * max), attach(['a'])));
  t.throws(() => checkAttachments(staged(3 * max + 1), attach(['a'])), {
    message: textOf.packageTooLong(max + 1),
  });
});

test('makePackages: numbers from 1, take by turn, closeTurn releases', t => {
  const table = makePackages();
  const notes = Far('Notes', {});
  const n1 = table.open({
    labels: ['notes'],
    values: new Map([['notes', notes]]),
    turnId: 't1',
  });
  const n2 = table.open({ labels: [], values: new Map(), turnId: 't2' });
  t.deepEqual([n1, n2], [1, 2]);
  t.is(table.take(1, 'notes', 't1'), notes);
  t.is(table.take(1, 'notes'), notes, 'an edge can be taken twice');
  t.throws(() => table.take(1, 'notes', 't2'), {
    message: textOf.noPackage(1),
  });
  t.throws(() => table.take(1, 'calc', 't1'), {
    message: textOf.noEdge(1, 'calc'),
  });
  t.throws(() => table.take(9, 'notes'), { message: textOf.noPackage(9) });
  table.closeTurn('t1');
  t.is(table.size(), 1);
  t.throws(() => table.take(1, 'notes'), { message: textOf.noPackage(1) });
});

test('tables: packages part, hooks and tool entries are registered', t => {
  t.true(m5Parts.includes(packagesPart));
  t.true(turnHooks.onClaim.includes(mentionHooks.onClaim));
  t.true(turnHooks.onSettle.includes(mentionHooks.onSettle));
  t.true(turnHooks.recoverySteps.includes(mentionHooks.recoverySteps));
  for (const entry of packageToolEntries) t.true(toolTable.includes(entry));
  t.deepEqual(
    packageToolEntries.map(e => [e.name, e.site]),
    [
      ['adopt', 'session'],
      ['adoptTool', 'guest'],
    ],
  );
  for (const entry of packageToolEntries) {
    const d = entry.describe();
    t.is(d.name, entry.name);
    t.deepEqual(
      JSON.parse(d.parameters).required,
      entry.name === 'adopt'
        ? ['messageNumber', 'edgeName', 'petName']
        : ['messageNumber', 'edgeName', 'toolName'],
    );
  }
});

// ---------------------------------------------------------------- session

/**
 * The real session over in-memory fakes with M5's packages part (and the
 * parts a test adds); the adapter can be restarted (leases break).
 * @param {object} [options]
 * @param {any[]} [options.parts]
 * @param {any} [options.services]
 */
const makeM5Session = async ({ parts = [], services = {} } = {}) => {
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  let since = AT - 60_000;
  /** @type {any} */
  let runtime;
  const capture = harden({
    name: 'inbox',
    make: (/** @type {any} */ rt) => {
      runtime = rt;
    },
  });
  const makeIncarnation = () => {
    const state = { dead: false };
    const endpoint = Far('Endpoint', {
      holdTurn: () => {
        if (state.dead) return Promise.reject(Error(`hub: ${RETIRED_TEXT}`));
        const kit = makePromiseKit();
        leases.push(kit);
        return kit.promise;
      },
      releaseTurn: () => {},
      startRound: (/** @type {any} */ req) => {
        if (!state.dead) rounds.push(req);
      },
      cancelRound: () => {},
      armDeadline: () => {},
      disarm: () => {},
    });
    const publisher = Far('LivePublisher', { publish: () => {} });
    return {
      state,
      ports: harden({ endpoint, publisher, tools: harden([]), since }),
    };
  };
  let incarnation = makeIncarnation();
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => incarnation.ports,
  });
  const host = Far('SessionHostFacet', {
    liveChannel: () => Far('LivePublisher', { publish: () => {} }),
  });
  const made = makeSession(
    {
      config: harden({
        key: 's1',
        title: 'm5 w57',
        backendTitle: 'fake',
        modelId: 'scripted',
        preset: harden({ label: 'chat-only' }),
        createdAt: AT,
        userInitiated: true,
        systemPrompt: 'You are helpful.',
      }),
      services: harden({ backend, host, ...services }),
      rowReporter: Far('RowReporter', { changed: () => {} }),
    },
    harden({
      parts: harden([
        ...m5Parts.filter(
          part => !parts.some((/** @type {any} */ p) => p.name === part.name),
        ),
        ...parts,
        capture,
      ]),
    }),
  );
  await drain();
  const last = () => rounds[rounds.length - 1];
  return {
    ...made,
    rounds,
    last,
    runtime: () => runtime,
    /**
     * @param {string} text
     * @param {readonly any[]} [attachments]
     * @param {string} [id]
     */
    send: async (text, attachments = [], id = requestId()) => {
      const receipt = made.session.enqueueMessageOnce(
        harden({ text }),
        id,
        AT,
        harden(attachments),
      );
      await drain();
      return receipt;
    },
    /**
     * Answer the last round with these calls (none: final).
     * @param {{ name: string, args: string }[]} [calls]
     */
    answer: (calls = []) => {
      const req = last();
      req.sink.dispatching(req.round);
      req.sink.roundFinal(
        harden({
          round: req.round,
          text: 'ok',
          toolCalls: harden(
            calls.map((c, i) => harden({ callId: `c${i}`, ...c })),
          ),
          usage,
          at: AT + 1,
        }),
      );
    },
    restartAdapter: async () => {
      incarnation.state.dead = true;
      since += 1_000_000;
      incarnation = makeIncarnation();
      for (const kit of leases.splice(0)) {
        kit.reject(Error(`ocapn hub: ${RETIRED_TEXT}`));
      }
      await drain();
    },
  };
};

/** @param {any} req */
const resultsIn = req =>
  req.append
    .filter((/** @type {any} */ r) => r.kind === 'tool-result')
    .map((/** @type {any} */ r) => [r.result, r.failed]);

test('a mention: the line on every round of its turn, adopt, noPackage after', async t => {
  const s = await makeM5Session();
  const [notes, calc] = attach(['notes', 'calc']);
  const receipt = await s.send('look at these', [notes, calc]);
  t.is(receipt.state, 'started');
  const line = textOf.mentionLine(1, ['notes', 'calc']);
  const round0 = s.last();
  t.is(round0.system, `You are helpful.\n\n${line}`);
  const started = round0.append.find(
    (/** @type {any} */ r) => r.kind === 'turn-started',
  );
  t.deepEqual(started.attachments, ['notes', 'calc']);
  t.deepEqual(
    round0.tools
      .map((/** @type {any} */ d) => d.name)
      .filter((/** @type {string} */ n) => n.startsWith('adopt')),
    ['adopt'],
    'adoptTool needs an exec vat',
  );
  const labels = s.runtime().labels;
  s.answer([
    {
      name: 'adopt',
      args: '{"messageNumber":1,"edgeName":"notes","petName":"n"}',
    },
    {
      name: 'adopt',
      args: '{"messageNumber":1,"edgeName":"nope","petName":"x"}',
    },
    {
      name: 'adopt',
      args: '{"messageNumber":2,"edgeName":"calc","petName":"c"}',
    },
    {
      name: 'adopt',
      args: '{"messageNumber":1,"edgeName":"calc","petName":"user"}',
    },
    { name: 'adopt', args: '{"messageNumber":1,"edgeName":"calc"}' },
    {
      name: 'adopt',
      args: '{"messageNumber":1,"edgeName":"calc","petName":"c","x":1}',
    },
  ]);
  const before = s.rounds.length;
  await microtasks();
  t.is(s.rounds.length, before + 1, 'adopt settles in the issuing crank');
  const round1 = s.last();
  t.is(round1.system, `You are helpful.\n\n${line}`, 'every round of the turn');
  const results = resultsIn(round1);
  t.deepEqual(results.slice(0, 4), [
    [textOf.adopted('notes', 1, 'n'), false],
    [textOf.errorResult(textOf.noEdge(1, 'nope')), true],
    [textOf.errorResult(textOf.noPackage(2)), true],
    [textOf.errorResult(textOf.reservedLabel('user')), true],
  ]);
  t.true(results[4][1]);
  t.is(
    results[5][0],
    textOf.errorResult(
      textOf.unexpectedArgument('x', 'adopt', [
        'messageNumber',
        'edgeName',
        'petName',
      ]),
    ),
  );
  const bound = /** @type {any} */ (labels.get('n'));
  t.is(bound.value, notes.value);
  t.is(bound.source, 'adopted');
  t.is(s.runtime().packages.table.size(), 1);
  s.answer();
  await drain();
  t.is(s.runtime().packages.table.size(), 0, 'closed at settle');

  // The next turn: no line; the package is gone; `list` shows the adoption.
  await s.send('next');
  t.is(s.last().system, 'You are helpful.');
  s.answer([
    {
      name: 'adopt',
      args: '{"messageNumber":1,"edgeName":"calc","petName":"c"}',
    },
    { name: 'list', args: '{}' },
  ]);
  await drain();
  t.deepEqual(resultsIn(s.last()), [
    [textOf.errorResult(textOf.noPackage(1)), true],
    [JSON.stringify(['n'], null, 2), false],
  ]);
  s.answer();
  await drain();

  // A second message with attachments is #2.
  await s.send('more', attach(['calc']));
  t.is(
    s.last().system,
    `You are helpful.\n\n${textOf.mentionLine(2, ['calc'])}`,
  );
});

test('enqueueMessageOnce refuses before storing; a retry is a duplicate', async t => {
  const s = await makeM5Session();
  t.throws(
    () =>
      s.session.enqueueMessageOnce(
        harden({ text: 'x' }),
        requestId(),
        AT,
        attach(['a', 'a']),
      ),
    { message: textOf.duplicateAttachment('a') },
  );
  t.throws(
    () =>
      s.session.enqueueMessageOnce(
        harden({ text: 'x' }),
        requestId(),
        AT,
        attach(['user']),
      ),
    { message: textOf.reservedLabel('user') },
  );
  t.is(s.session.listPending().entries.length, 0);
  t.is(s.rounds.length, 0, 'no turn started');
  const id = requestId();
  const atts = attach(['notes']);
  const first = await s.send('hello', atts, id);
  const again = await s.send('hello', atts, id);
  t.true(again.duplicate);
  t.is(again.turnId ?? again.turn, first.turnId ?? first.turn);
  t.throws(
    () =>
      s.session.enqueueMessageOnce(
        harden({ text: 'hello' }),
        id,
        AT,
        attach(['other']),
      ),
    { message: texts.requestIdReused },
  );
});

test('queued entries keep their attachments behind a turn and a restart hold; recovery closes the package', async t => {
  const s = await makeM5Session();
  await s.send('first', attach(['a']));
  t.is(s.runtime().packages.table.size(), 1);
  await s.send('second', attach(['b']));
  t.is(s.session.listPending().entries.length, 1);
  // The adapter restarts mid-turn: recovery settles the turn, its package
  // closes, the waiting entry is held `restart` with its attachments.
  await s.restartAdapter();
  t.is(s.runtime().packages.table.size(), 0);
  t.is(s.session.listPending().hold?.reason, 'restart');
  const item = /** @type {any} */ (s.runtime().session.queue.items()[0]);
  t.deepEqual(
    item.attachments.map((/** @type {any} */ x) => x.label),
    ['b'],
  );
  // A new message releases the hold; the held entry runs with its line.
  await s.send('third');
  t.is(s.last().system, `You are helpful.\n\n${textOf.mentionLine(2, ['b'])}`);
  t.is(s.runtime().packages.table.size(), 1);
});

test('recoverySteps closes the turn package (idempotent with onSettle)', async t => {
  const s = await makeM5Session();
  await s.send('first', attach(['a']));
  const { core } = s.runtime().session;
  const active = core.current();
  mentionHooks.recoverySteps({ core, active, round: 0 });
  t.is(s.runtime().packages.table.size(), 0);
  mentionHooks.onSettle({ core, active, round: 0 });
  t.is(s.runtime().packages.table.size(), 0);
});

test('adoptTool grants through the grants part and answers by its schema read', async t => {
  /** @type {any[]} */
  const granted = [];
  /** @type {Map<any, any>} */
  const infos = new Map();
  const grantsPart = harden({
    name: 'grants',
    make: () =>
      harden({
        grant: (/** @type {any} */ tool, /** @type {string} */ source) => {
          granted.push([tool, source]);
          const handle = Far('ToolGrant', {});
          infos.set(
            handle,
            tool.toString().includes('bad')
              ? { state: 'refused-schema', reason: 'bad schema' }
              : { state: 'offered', name: 'echo2' },
          );
          return handle;
        },
        schemaRead: async (/** @type {any} */ handle) => infos.get(handle),
      }),
  });
  const execVat = Far('ExecHandle', {});
  const s = await makeM5Session({
    parts: [grantsPart],
    services: { execVat },
  });
  const [good, bad] = attach(['good', 'bad']);
  await s.send('tools', [good, bad]);
  t.true(s.last().tools.some((/** @type {any} */ d) => d.name === 'adoptTool'));
  s.answer([
    {
      name: 'adoptTool',
      args: '{"messageNumber":1,"edgeName":"good","toolName":"echo"}',
    },
    {
      name: 'adoptTool',
      args: '{"messageNumber":1,"edgeName":"bad","toolName":"b"}',
    },
    {
      name: 'adoptTool',
      args: '{"messageNumber":1,"edgeName":"good","toolName":"a/b"}',
    },
  ]);
  await drain();
  t.deepEqual(resultsIn(s.last()), [
    [textOf.adoptedTool('echo', 1), false],
    [textOf.errorResult('bad schema'), true],
    [textOf.errorResult(textOf.reservedLabel('a/b')), true],
  ]);
  t.deepEqual(granted, [
    [good.value, 'adopted'],
    [bad.value, 'adopted'],
  ]);
});
