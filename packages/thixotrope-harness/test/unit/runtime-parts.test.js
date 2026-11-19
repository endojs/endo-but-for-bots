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
/* eslint-enable import/no-relative-packages */

/** @param {readonly any[]} parts */
const runtimeOf = parts =>
  makeRuntime({
    labels: makeLabels(),
    services: harden({}),
    config: harden({}),
    parts: harden(parts),
  });

test('the table: powers, inspector, grants, exec, packages; all required', t => {
  t.deepEqual(
    runtimeParts.map(part => part.name),
    ['powers', 'inspector', 'grants', 'exec', 'packages'],
  );
  t.deepEqual([...requiredParts], ['powers', 'inspector', 'grants', 'exec', 'packages']);
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
