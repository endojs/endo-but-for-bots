// @ts-check
// The runtime parts as the one per-session extension (HR-SYN-15;
// guest/session/runtime-parts.js): the table order; each part made once,
// reached by its getter; the parts' hooks combined in table order (onClaim
// gets the entry, onRecover skips a throw or a rejection, nextTurn answers
// the first source with a turn); the parts' tool sources in table order; a
// missing or doubled part refused; no string lookup and no session
// internals on the runtime.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { makeLabels } from '../../guest/session/labels.js';
import {
  makeRuntime,
  requiredParts,
  runtimeParts,
} from '../../guest/session/runtime-parts.js';
import { toolTable } from '../../guest/session/tool-table.js';
/* eslint-enable import/no-relative-packages */

/** @param {readonly any[]} parts */
const runtimeOf = parts =>
  makeRuntime({
    labels: makeLabels(),
    services: harden({}),
    config: harden({}),
    parts: harden(parts),
  });

test('the table: powers, inspector, grants, exec, packages, environment, compaction, inbox, subagents; all required', t => {
  t.deepEqual(
    runtimeParts.map(part => part.name),
    [
      'powers',
      'inspector',
      'grants',
      'exec',
      'packages',
      'environment',
      'compaction',
      'inbox',
      'subagents',
    ],
  );
  t.deepEqual(
    [...requiredParts],
    [
      'powers',
      'inspector',
      'grants',
      'exec',
      'packages',
      'environment',
      'compaction',
      'inbox',
      'subagents',
    ],
  );
  const runtime = /** @type {any} */ (runtimeOf(runtimeParts));
  for (const name of requiredParts) t.truthy(runtime[name]);
  t.false('session' in runtime);
  t.false('part' in runtime);
  t.throws(() => runtimeOf(runtimeParts.slice(1)), {
    message: 'no runtime part powers',
  });
  t.throws(() => runtimeOf([...runtimeParts, runtimeParts[0]]), {
    message: 'two runtime parts powers',
  });
});

test('hooks fan out in table order; recovery skips failures; the first turn source wins', async t => {
  /** @type {any[]} */
  const calls = [];
  /** @param {string} name @param {Record<string, any>} hooks */
  const probe = (name, hooks) =>
    harden({ name, make: () => harden({ hooks: harden(hooks) }) });
  const runtime = runtimeOf([
    ...runtimeParts,
    probe('a', {
      onClaim: (/** @type {any} */ _turn, /** @type {any} */ item) =>
        calls.push(['a.claim', item]),
      onSettle: () => calls.push(['a.settle']),
      onRecover: () => {
        calls.push(['a.recover']);
        throw Error('a failed');
      },
      nextTurn: () => undefined,
    }),
    probe('b', {
      onClaim: () => calls.push(['b.claim']),
      beforeRound: () => calls.push(['b.round']),
      onCancel: () => calls.push(['b.cancel']),
      onRecover: () => {
        calls.push(['b.recover']);
        return Promise.reject(Error('b failed'));
      },
      nextTurn: () => harden({ text: 'from b', at: 1 }),
    }),
    probe('c', {
      onRecover: () => calls.push(['c.recover']),
      nextTurn: () => harden({ text: 'from c', at: 2 }),
    }),
  ]);
  const turn = /** @type {any} */ (
    Object.freeze({
      active: { turnId: 't1', calls: undefined },
      round: 0,
      append: () => {},
      emit: () => {},
    })
  );
  runtime.hooks.onClaim(turn, 'item');
  runtime.hooks.beforeRound(turn);
  runtime.hooks.onCancel(turn);
  runtime.hooks.onSettle(turn);
  runtime.hooks.onRecover(turn);
  t.deepEqual(calls, [
    ['a.claim', 'item'],
    ['b.claim'],
    ['b.round'],
    ['b.cancel'],
    ['a.settle'],
    ['a.recover'],
    ['b.recover'],
    ['c.recover'],
  ]);
  t.deepEqual(runtime.hooks.nextTurn(), { text: 'from b', at: 1 });
  await null;
});

test("the parts' tool sources, in table order, after the grants part's", t => {
  const extra = () => harden([]);
  const runtime = runtimeOf([
    ...runtimeParts,
    harden({ name: 'probe', make: () => harden({ tools: extra }) }),
  ]);
  t.is(runtime.toolSources.length, 2);
  t.is(runtime.toolSources[0], runtime.grants.tools);
  t.is(runtime.toolSources[1], extra);
});

/**
 * The part order fixed for every part to come (WX.1; m8-interfaces.md
 * D-M8-18, m9-interfaces.md D-M9-24). A lane adds its part at its place.
 */
const PART_ORDER = harden([
  'powers',
  'inspector',
  'grants',
  'exec',
  'packages',
  'environment',
  'compaction',
  'inbox',
  'subagents',
]);

/**
 * @param {readonly string[]} names
 * @param {readonly string[]} order
 */
const inOrder = (names, order) => {
  const places = names.map(name => order.indexOf(name));
  return places.every(
    (place, i) => place >= 0 && (i === 0 || place > places[i - 1]),
  );
};

test('the table and the required list follow the fixed part order (WX.1)', t => {
  t.true(
    inOrder(
      runtimeParts.map(part => part.name),
      PART_ORDER,
    ),
  );
  t.true(inOrder(requiredParts, PART_ORDER));
  // Every part of the table so far is required; a later part joins
  // `requiredParts` in the commit that adds it to `runtimeParts`.
  t.deepEqual(
    [...requiredParts],
    runtimeParts.map(part => part.name),
  );
});

test('admit answers the first refusal in table order, or undefined (WX.1, m6 15.3)', t => {
  /** @type {string[]} */
  const asked = [];
  /** @param {string} name @param {() => (string | undefined)} admit */
  const probe = (name, admit) =>
    harden({ name, make: () => harden({ hooks: harden({ admit }) }) });
  t.is(runtimeOf(runtimeParts).hooks.admit(), undefined, 'no part admits');
  const runtime = runtimeOf([
    ...runtimeParts,
    probe('a', () => {
      asked.push('a');
      return undefined;
    }),
    probe('b', () => {
      asked.push('b');
      return 'b refuses';
    }),
    probe('c', () => {
      asked.push('c');
      return 'c refuses';
    }),
  ]);
  t.is(runtime.hooks.admit(), 'b refuses');
  t.deepEqual(
    asked,
    ['a', 'b'],
    'the parts after the first refusal are not asked',
  );
});

test("nextTurn passes a source's take through unchanged (WX.1, m9 S2b)", t => {
  const take = () => {};
  const answer = harden({ text: 'from a', at: 1, take });
  const runtime = runtimeOf([
    ...runtimeParts,
    harden({
      name: 'a',
      make: () => harden({ hooks: harden({ nextTurn: () => answer }) }),
    }),
  ]);
  t.is(runtime.hooks.nextTurn(), answer);
});

test('the context window option is the runtime member, undefined by default (WX.1, m8 T-1)', t => {
  t.is(runtimeOf(runtimeParts).contextWindow, undefined);
  const contextWindow = harden({ epoch: () => 0 });
  const runtime = makeRuntime({
    labels: makeLabels(),
    services: harden({}),
    config: harden({}),
    contextWindow,
  });
  t.is(runtime.contextWindow, contextWindow);
});

test('the static tool table follows the fixed tool order after the package entries (WX.1)', t => {
  const names = toolTable.map(entry => entry.name);
  const after = names.slice(names.indexOf('adoptTool') + 1);
  t.true(
    inOrder(after, [
      'runCommand',
      'inspectShell',
      'viewImage',
      'listMessages',
      'send',
      'reply',
      'dismiss',
      'resolveRequest',
      'rejectRequest',
      'submitForm',
      'spawnSubagent',
      'askSubagent',
      'stopSubagent',
    ]),
    after.join(', '),
  );
});
