// @ts-check
// The subagent tree in Node (designs/m9-interfaces.md D-M9-10, 3.1, 4.3,
// 4.4, 5.1, 5.2 KM7-KM10; acceptance 7-10, 16 at the unit level): the real
// post office and row table, session rows with the fake inbox of
// `_post-office-fakes.js`, an injected `create` that makes such rows and an
// injected `deleteSession` that runs the tree's delete hook first.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { makeMailWorld, settle, stagedText } from './_post-office-fakes.js';

/* eslint-disable import/no-relative-packages */
import {
  interfaces as relayInterfaces,
  interfaces,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import {
  texts as mailTexts,
  textOf as mailTextOf,
} from '../../guest/lib/guards/session.js';
import { textOf as postOfficeTextOf } from '../../guest/lib/guards/factory.js';
import { ANSWER_UNITS, makeSubagents } from '../../guest/factory/subagents.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (
  globalThis
);

const none = harden([]);
const AT = 1_700_000_000_000;

/**
 * A tree on a mail world. `hold()` makes the next creations wait until
 * `release()`; `deleted` lists the titles in row-removal order.
 * @param {{ settings?: Record<string, number> }} [options]
 */
const makeTree = ({ settings } = {}) => {
  const world = makeMailWorld();
  /** @type {any[]} */
  const created = [];
  /** @type {string[]} */
  const deleted = [];
  /** @type {any[]} */
  const staged = [];
  /** @type {ReturnType<typeof makePromiseKit> | undefined} */
  let gate;
  /** @type {any} */
  let tree;
  const sessions = new Map();
  /**
   * @param {any} options
   * @param {any} how
   */
  const create = async (options, how) => {
    const { parent, endowments, link } = how;
    const child = world.addSession(options.title);
    /** @type {any} */ (child.row).parent = parent;
    child.row.userInitiated = options.userInitiated;
    sessions.set(child.row, child);
    created.push({ options, parent, endowments, child, how });
    link(child.row);
    if (gate !== undefined) await gate.promise;
    return { session: child.session, internal: child.row.internal };
  };
  /** @param {any} session */
  const deleteSession = async session => {
    const row = /** @type {any} */ (world.rows.ofSession(session));
    await tree.deleteChildren({ row, session });
    deleted.push(row.title);
    world.rows.drop(row);
  };
  // An admin whose relay writers (built from their real guards) stage
  // text into a counted fake blob.
  const relayWriters = makeExo('RelayWriters', relayInterfaces.RelayWriters, {
    open: async () => {
      /** @type {string[]} */
      const pieces = [];
      return makeExo('BlobWriter', interfaces.BlobWriter, {
        /** @param {string} piece */
        append: async piece => {
          pieces.push(piece);
        },
        close: async () => {
          const text = pieces.join('');
          staged.push(text);
          return harden({
            blob: Far('Blob', {}),
            preview: text.slice(0, 16),
            bytes: text.length,
          });
        },
        abort: () => undefined,
      });
    },
    copy: async () => {
      throw Error('not used by the tree tests');
    },
  });
  const admin = Far('AgentHostAdmin', { writersFor: () => relayWriters });
  tree = makeSubagents({
    create,
    deleteSession,
    rows: world.rows,
    postOffice: world.postOffice,
    starts: world.starts,
    admin,
    settings:
      settings === undefined ? undefined : { current: () => harden(settings) },
  });
  const backend = Far('Backend', {});
  const preset = Far('Preset', {});
  /**
   * A root session with a delegation.
   * @param {string} title
   * @param {Record<string, any>} [from]
   */
  const addParent = (title, from = {}) => {
    const parent = world.addSession(title);
    sessions.set(parent.row, parent);
    const delegation = tree.delegationFor(
      parent.row,
      harden({ backend, modelId: 'model-a', preset, ...from }),
    );
    return { ...parent, delegation };
  };
  /**
   * The delegation of a spawned child (its services builder's call).
   * @param {any} row
   */
  const delegationOf = row =>
    tree.delegationFor(row, harden({ backend, modelId: 'model-a', preset }));
  return {
    world,
    tree,
    created,
    deleted,
    staged,
    backend,
    preset,
    sessions,
    addParent,
    delegationOf,
    hold: () => {
      gate = makePromiseKit();
    },
    release: () => {
      const held = gate;
      gate = undefined;
      held?.resolve(undefined);
    },
    /** @param {any} handle */
    childOf: handle =>
      sessions.get(
        /** @type {any} */ (world.postOffice.recipientOf(handle)).row,
      ),
  };
};

/**
 * @param {any} delegation
 * @param {string} name
 * @param {any[]} [attachments]
 */
const spawn = (delegation, name, attachments = none) =>
  E(delegation).spawn(harden({ name, attachments, at: AT }));

/**
 * The child answers its newest envelope with `body` (its inbox's settle
 * hook posts this reply).
 * @param {any} child
 * @param {any} body
 * @param {any[]} [attachments]
 */
const replyFrom = (child, body, attachments = none) => {
  const envelope = child.envelopes[child.envelopes.length - 1];
  return E(child.outbox).post(
    harden({
      to: [envelope.from],
      body,
      attachments,
      inReplyTo: envelope.postmark,
    }),
  );
};

test('a spawned child is hidden, titled under its parent, inherits the creation, and holds only its attachments', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Planner');
  const thing = Far('Thing', {});
  const attachments = harden([{ label: 'notes', value: thing }]);
  const answer = await E(parent.delegation).spawn(
    harden({ name: 'scout', attachments, at: AT, systemPrompt: 'Be brief.' }),
  );
  t.is(answer.title, 'Planner / scout');
  const [made] = tree.created;
  t.is(made.parent, parent.row);
  t.is(made.options.backend, tree.backend);
  t.is(made.options.preset, tree.preset);
  t.is(made.options.modelId, 'model-a');
  t.is(made.options.userInitiated, false);
  t.is(made.options.at, AT);
  t.is(made.options.systemPrompt, 'Be brief.');
  t.false('reasoningEffort' in made.options);
  t.deepEqual(made.endowments, attachments);
  // The handle is the child's mail address.
  const child = tree.childOf(answer.handle);
  t.is(child, made.child);
  t.false(tree.world.rows.isListed(child.row));
  t.deepEqual(await E(answer.handle).describe(), {
    name: 'scout',
    state: 'ready',
    depth: 1,
  });
  const listed = await E(parent.delegation).children();
  t.deepEqual(
    listed.map((/** @type {any} */ c) => [c.name, c.state]),
    [['scout', 'ready']],
  );
  t.is(listed[0].handle, answer.handle);
  t.is(
    tree.tree.delegationFor(parent.row, harden({})),
    parent.delegation,
    'minted once',
  );
});

test('a pool-backed parent gives its child the same Backend object and effort', async t => {
  const tree = makeTree();
  const pool = Far('Backend', {});
  const parent = tree.addParent('Pooled', {
    backend: pool,
    reasoningEffort: 'high',
  });
  await spawn(parent.delegation, 'helper');
  const [made] = tree.created;
  t.is(made.options.backend, pool);
  t.is(made.options.reasoningEffort, 'high');
});

test('the long title of a parent is cut so the child title fits', async t => {
  const tree = makeTree();
  const parent = tree.addParent('p'.repeat(limits.titleUnits));
  const name = 'x'.repeat(40);
  const { title } = await spawn(parent.delegation, name);
  t.is(title.length, limits.titleUnits);
  t.true(title.endsWith(` / ${name}`));
});

test('nine concurrent spawns admit eight and refuse the ninth with the tree limit; names are checked', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  tree.hold();
  const spawns = Array.from({ length: 9 }, (_, i) =>
    spawn(parent.delegation, `w${i}`),
  );
  await settle();
  t.is(tree.tree.status().reservations, 8, 'eight admitted in flight');
  tree.release();
  const outcomes = await Promise.allSettled(spawns);
  t.is(outcomes.filter(o => o.status === 'fulfilled').length, 8);
  const ninth = /** @type {PromiseRejectedResult} */ (outcomes[8]);
  t.is(ninth.status, 'rejected');
  t.is(ninth.reason.message, postOfficeTextOf.treeLimit(8));
  t.is(tree.created.length, 8);
  t.is(tree.tree.status().reservations, 0);
  await t.throwsAsync(spawn(parent.delegation, 'Researcher'), {
    message: mailTextOf.nameInvalid('Researcher'),
  });
});

test('a name in flight or live is refused; a refused spawn reserves nothing', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  tree.hold();
  const first = spawn(parent.delegation, 'twin');
  await settle();
  await t.throwsAsync(spawn(parent.delegation, 'twin'), {
    message: mailTextOf.subagentExists('twin'),
  });
  tree.release();
  await first;
  await t.throwsAsync(spawn(parent.delegation, 'twin'), {
    message: mailTextOf.subagentExists('twin'),
  });
  t.is(tree.created.length, 1);
});

test('depth: a child below the limit delegates, a grandchild does not, and maxDepth 0 removes delegation', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'child');
  const child = tree.childOf(handle);
  const childDelegation = tree.delegationOf(child.row);
  t.not(childDelegation, undefined);
  const grand = await spawn(childDelegation, 'grand');
  const grandRow = tree.childOf(grand.handle).row;
  t.is(tree.delegationOf(grandRow), undefined);
  t.is((await E(grand.handle).describe()).depth, 2);
  // The grandchild counts toward the root's tree.
  t.deepEqual(
    (await E(childDelegation).children()).map((/** @type {any} */ c) => c.name),
    ['grand'],
  );
  const flat = makeTree({ settings: { maxDepth: 0 } });
  t.is(flat.addParent('Lonely').delegation, undefined);
  const small = makeTree({ settings: { maxDescendants: 2 } });
  const top = small.addParent('Top');
  const one = await spawn(top.delegation, 'one');
  await spawn(small.delegationOf(small.childOf(one.handle).row), 'two');
  await t.throwsAsync(spawn(top.delegation, 'three'), {
    message: postOfficeTextOf.treeLimit(2),
  });
});

test('ask posts the task to the child and answers its reply; the reply reaches no inbox', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'scout');
  const child = tree.childOf(handle);
  const asked = E(handle).ask(
    harden({ task: 'look around', attachments: none, at: AT }),
  );
  await settle();
  t.is(child.envelopes.length, 1);
  t.is(child.envelopes[0].type, 'package');
  t.is(child.envelopes[0].body, 'look around');
  t.is(child.envelopes[0].from, tree.world.postOffice.addressFor(parent.row));
  t.is((await E(handle).describe()).state, 'asking');
  await t.throwsAsync(
    E(handle).ask(harden({ task: 'again', attachments: none, at: AT })),
    { message: mailTextOf.askInFlight('scout') },
  );
  await replyFrom(child, 'all quiet');
  t.deepEqual(await asked, { text: 'all quiet', edges: [] });
  t.is(parent.envelopes.length, 0, 'the reply went to the ask');
  t.is((await E(handle).describe()).state, 'ready');
  t.is(tree.tree.status().asking, 0);
  t.is(tree.world.postOffice.status().asks, 0);
});

test('a staged reply is copied cut to the tool limit with the attachment note; an inline one too long with it is staged', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'scout');
  const child = tree.childOf(handle);
  const asked = E(handle).ask(
    harden({ task: 'write it up', attachments: none, at: AT }),
  );
  await settle();
  const report = stagedText(100_000);
  const attachments = harden([{ label: 'chart', value: Far('Chart', {}) }]);
  await replyFrom(child, report, attachments);
  const answer = await asked;
  const copy = tree.world.copies[tree.world.copies.length - 1];
  t.is(copy.source, report.blob);
  t.deepEqual(copy.options, {
    from: child.session,
    to: parent.session,
    maxUnits: ANSWER_UNITS,
    suffix: postOfficeTextOf.answerAttachments(['chart']),
  });
  t.is(answer.text, copy.copied);
  t.deepEqual(answer.edges, ['chart']);

  const again = E(handle).ask(
    harden({ task: 'once more', attachments: none, at: AT }),
  );
  await settle();
  const long = 'y'.repeat(limits.inlineBytes - 10);
  await replyFrom(child, long, attachments);
  const staged = await again;
  t.is(typeof staged.text, 'object');
  t.deepEqual(tree.staged, [
    `${long}${postOfficeTextOf.answerAttachments(['chart'])}`,
  ]);
});

test('a staged task reaches the child as a relay copy', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'reader');
  const child = tree.childOf(handle);
  const task = stagedText(1_048_576);
  void E(handle).ask(harden({ task, attachments: none, at: AT }));
  await settle();
  const [envelope] = child.envelopes;
  t.not(envelope.body, task);
  t.is(tree.world.copies[0].source, task.blob);
  t.is(envelope.body, tree.world.copies[0].copied);
});

test('cancelAsk ends the ask, tells the child, and a late reply is consumed', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'slow');
  const child = tree.childOf(handle);
  const asked = E(handle).ask(
    harden({ task: 'take your time', attachments: none, at: AT }),
  );
  await settle();
  const { postmark } = child.envelopes[0];
  await E(handle).cancelAsk();
  await t.throwsAsync(asked, { message: mailTexts.askAbandoned });
  await settle();
  t.deepEqual(child.cancelled, [postmark]);
  await replyFrom(child, 'too late');
  t.is(parent.envelopes.length, 0);
  t.is((await E(handle).describe()).state, 'ready');
});

test('a cancel before the post office answered cancels the delivery once it answers', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'slow');
  const child = tree.childOf(handle);
  child.stall();
  const asked = E(handle).ask(
    harden({ task: 'later', attachments: none, at: AT }),
  );
  await settle();
  await E(handle).cancelAsk();
  await t.throwsAsync(asked, { message: mailTexts.askAbandoned });
  child.release();
  await settle();
  t.deepEqual(child.cancelled, [child.envelopes[0].postmark]);
});

test('an ask to a lost child answers subagentLost', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'fragile');
  const child = tree.childOf(handle);
  child.state.retired = true;
  await t.throwsAsync(
    E(handle).ask(harden({ task: 'hello', attachments: none, at: AT })),
    { message: postOfficeTextOf.subagentLost('fragile') },
  );
  t.is(child.row.state, 'lost');
  t.is((await E(handle).describe()).state, 'lost');
  await t.throwsAsync(
    E(handle).ask(harden({ task: 'hello', attachments: none, at: AT })),
    { message: postOfficeTextOf.subagentLost('fragile') },
  );
});

test('stop deletes the subtree deepest first; deleting the parent deletes its children first', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const a = await spawn(parent.delegation, 'a');
  const aRow = tree.childOf(a.handle).row;
  const aa = await spawn(tree.delegationOf(aRow), 'aa');
  const b = await spawn(parent.delegation, 'b');
  const bRow = tree.childOf(b.handle).row;
  await spawn(tree.delegationOf(bRow), 'bb');
  const asked = E(aa.handle).ask(
    harden({ task: 'pending', attachments: none, at: AT }),
  );
  await E(a.handle).stop();
  t.deepEqual(tree.deleted, ['Root / a / aa', 'Root / a']);
  await t.throwsAsync(asked, { message: mailTexts.askAbandoned });
  t.deepEqual(
    (await E(parent.delegation).children()).map(
      (/** @type {any} */ c) => c.name,
    ),
    ['b'],
  );
  // A stopped subtree frees its room.
  await spawn(parent.delegation, 'c');
  // The parent's own delete runs the hook: children first, deepest first.
  await tree.tree.deleteChildren({ row: parent.row, session: parent.session });
  t.deepEqual(tree.deleted, [
    'Root / a / aa',
    'Root / a',
    'Root / b / bb',
    'Root / b',
    'Root / c',
  ]);
  t.deepEqual(await E(parent.delegation).children(), []);
  // A parent whose delete began spawns nothing more.
  await t.throwsAsync(spawn(parent.delegation, 'd'));
});

test('restart releases a spawn cut off before make and links one the start listener completed (KM9, KM10)', async t => {
  const tree = makeTree({ settings: { maxDescendants: 2 } });
  const parent = tree.addParent('Root');
  tree.hold();
  // KM10: the row is made and ready, but the spawn never answers.
  const done = spawn(parent.delegation, 'done');
  // KM9: the creation was rolled back by the start listener.
  const rolled = spawn(parent.delegation, 'rolled').then(
    () => 'made',
    error => error.message,
  );
  await settle();
  t.is(tree.tree.status().reservations, 2);
  await t.throwsAsync(spawn(parent.delegation, 'third'), {
    message: postOfficeTextOf.treeLimit(2),
  });
  tree.world.rows.drop(tree.created[1].child.row);
  await tree.tree.restart(tree.world.starts.next());
  t.is(tree.tree.status().reservations, 0);
  const listed = await E(parent.delegation).children();
  t.deepEqual(
    listed.map((/** @type {any} */ c) => c.name),
    ['done'],
  );
  t.is(tree.childOf(listed[0].handle), tree.created[0].child);
  // One room left: the rolled-back spawn is no longer counted.
  await t.throwsAsync(spawn(parent.delegation, 'done'), {
    message: mailTextOf.subagentExists('done'),
  });
  // Answers that arrive after the restart change nothing.
  tree.release();
  t.is((await done).title, 'Root / done');
  t.is(await rolled, postOfficeTextOf.subagentLost('rolled'));
  await spawn(parent.delegation, 'again');
  t.is(tree.tree.status().reservations, 0);
});

test('restart closes an ask stamped with an earlier start; the late reply is consumed (KM7, KM8)', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  const { handle } = await spawn(parent.delegation, 'busy');
  const child = tree.childOf(handle);
  const asked = E(handle).ask(
    harden({ task: 'before the restart', attachments: none, at: AT }),
  );
  await settle();
  await tree.tree.restart(tree.world.starts.next());
  await t.throwsAsync(asked, { message: mailTexts.askAbandoned });
  await settle();
  t.deepEqual(child.cancelled, [child.envelopes[0].postmark]);
  await replyFrom(child, 'after');
  t.is(parent.envelopes.length, 0);
  t.is(tree.tree.status().asking, 0);
  // A new ask after the restart works.
  const fresh = E(handle).ask(
    harden({ task: 'now', attachments: none, at: AT }),
  );
  await settle();
  await replyFrom(child, 'done');
  t.is((await fresh).text, 'done');
  t.is(limits.asksPerSubagent, 1);
});

// A spawn in flight while its parent is deleted: the parent's delete hook
// marks it closing, so the creation that answers later deletes its child
// and refuses the spawn; nothing is linked under the dropped parent.
test('a spawn in flight when its parent is deleted leaves no child behind', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  tree.hold();
  const pending = spawn(parent.delegation, 'late');
  await settle();
  // The parent's delete: its hook first, then the row is dropped.
  await tree.tree.deleteChildren({
    row: parent.row,
    session: parent.session,
  });
  tree.world.rows.drop(parent.row);
  tree.release();
  await t.throwsAsync(pending);
  const childRow = tree.created[0].child.row;
  t.true(childRow.dropped, 'the late child is deleted');
  t.deepEqual(tree.deleted, ['Root / late']);
  t.is(tree.tree.nodeOf(childRow), undefined);
  t.is(tree.tree.status().reservations, 0);
  // A spawn after the hook ran is refused before any creation.
  await t.throwsAsync(spawn(parent.delegation, 'after'));
  t.is(tree.created.length, 1);
});

test('restart deletes a child the start listener completed under a deleted parent (KM10)', async t => {
  const tree = makeTree();
  const parent = tree.addParent('Root');
  tree.hold();
  const pending = spawn(parent.delegation, 'cut').catch(() => 'refused');
  await settle();
  await tree.tree.deleteChildren({
    row: parent.row,
    session: parent.session,
  });
  tree.world.rows.drop(parent.row);
  await tree.tree.restart(tree.world.starts.next());
  await settle();
  const childRow = tree.created[0].child.row;
  t.true(childRow.dropped, 'not linked under the dropped parent');
  t.is(tree.tree.nodeOf(childRow), undefined);
  t.is(tree.tree.status().reservations, 0);
  tree.release();
  t.is(await pending, 'refused');
  t.deepEqual(tree.deleted, ['Root / cut']);
});

test("a child is made from its parent's preset snapshot, not a new one", async t => {
  const tree = makeTree();
  const snapshot = harden({ label: 'Planner preset', revision: 3 });
  const parent = tree.addParent('Root', { presetSnapshot: snapshot });
  const { handle } = await spawn(parent.delegation, 'kid');
  t.is(tree.created[0].how.presetSnapshot, snapshot);
  // The grandchild inherits the same snapshot through the child's row.
  const child = tree.childOf(handle);
  const childDelegation = tree.tree.delegationFor(
    child.row,
    harden({
      backend: tree.backend,
      modelId: 'model-a',
      preset: tree.preset,
      presetSnapshot: snapshot,
    }),
  );
  await spawn(childDelegation, 'grandkid');
  t.is(tree.created[1].how.presetSnapshot, snapshot);
});
