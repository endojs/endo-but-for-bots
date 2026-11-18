// @ts-check
// M5 W5.4, the exec side (designs/m5-interfaces.md 2.7, D-M5-2, D-M5-3): the
// exec program from its bundle alone, in a Node Compartment with only the
// guest prelude, over fake adapter objects, a fake ExecPowersSource and the
// M5 fixture objects (test/fixtures/m5-objects.js, evaluated from their
// source text as the workspace vat evaluates them). Covers the per-call
// powers (forwarding, JSON values, expiry with the call), the membrane
// (each bound at and over its limit, wrappers, wrapped answers, an ended
// call's wrappers), every inspector operation with its bounds, the
// exhausted answer, and the exec copy of the M5 contract pieces. What only a
// vat can show (a hostile answer halting the exec vat) is W5.5's
// integration (m5-security, m5-objects).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import { guestPrelude } from '../../scripts/guest-prelude.js';
import { harnessRoot } from '../_helpers.js';
import { m5FixtureSource } from '../fixtures/m5-objects.js';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  m5Interfaces,
  m5Shapes,
  texts,
  textOf,
} from '../../guest/lib/interfaces-m5.js';
import {
  execGuards,
  texts as execTexts,
  textOf as execTextOf,
} from '../../guest/exec/render.js';
import {
  ANSWER_DEPTH,
  MODEL_OBJECT_TEXT,
  NESTED_PROMISE_TEXT,
  isWrapper,
  makeMembrane,
  measureArguments,
} from '../../guest/exec/membrane.js';
import { LABEL_TEXT, NOT_JSON_TEXT } from '../../guest/exec/powers.js';
import {
  ARGUMENTS_OBJECT_TEXT,
  ITEMS_TEXT,
  UNKNOWN_METHOD_TEXT,
  UNREADABLE_TEXT,
} from '../../guest/exec/inspect.js';
import { previewText, utf8Bytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, M, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** The exec budget after M5's merge (open decision O-1, the PM's ruling). */
const EXEC_BUDGET_AFTER_M5 = 120_000;

const entry = path.join(harnessRoot, 'guest', 'exec', 'main.js');

/** @type {Promise<{ bundle: any, namespace: any }> | undefined} */
let loaded;
const load = () => {
  if (!loaded)
    loaded = (async () => {
      const bundle = await bundleGuest(entry);
      const namespace = new Compartment({
        globals: harden({ ...guestPrelude, TextEncoder }),
        __options__: true,
      }).evaluate(bundle.source);
      return { bundle, namespace };
    })();
  return loaded;
};

/** The fixtures, made from their shipped source text with the prelude alone. */
const fixtures = () =>
  E(
    new Compartment({
      globals: harden({ ...guestPrelude }),
      __options__: true,
    }).evaluate(m5FixtureSource)(),
  ).all();

/** Fake adapter objects: staging writers, a Content over staged blobs, a Timer. */
const makeAdapter = () => {
  /** @type {Map<any, string>} */
  const blobs = new Map();
  /** @param {string} text */
  const stage = text => {
    const blob = Far('Blob', {});
    blobs.set(blob, text);
    return harden({
      blob,
      preview: previewText(text, 256),
      bytes: utf8Bytes(text),
    });
  };
  const writers = Far('BlobWriters', {
    open: () => {
      /** @type {string[]} */
      const pieces = [];
      return Far('BlobWriter', {
        /** @param {string} piece */
        append: piece => {
          pieces.push(piece);
        },
        close: () => stage(pieces.join('')),
        abort: () => undefined,
      });
    },
  });
  const content = Far('Content', {
    /**
     * @param {any} blob
     * @param {{ offset: number, maxBytes: number }} range
     */
    read: (blob, { offset, maxBytes }) => {
      const text = /** @type {string} */ (blobs.get(blob));
      const next = Math.min(text.length, offset + maxBytes);
      return harden({
        text: text.slice(offset, next),
        next,
        done: next === text.length,
      });
    },
  });
  const timer = Far('Timer', { sleep: () => undefined });
  /** @param {any} text inline or staged */
  const textOfOutcome = text =>
    /** @type {string} */ (
      typeof text === 'string' ? text : blobs.get(text.blob)
    );
  return { blobs, stage, writers, content, timer, textOfOutcome };
};

/**
 * A fake ExecPowersSource over a Map (label -> object or { json }).
 * @param {Record<string, any>} [initial]
 */
const makeSource = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  /** @type {any[]} */
  const log = [];
  const source = Far('ExecPowersSource', {
    /** @param {string} label */
    lookup: label => {
      log.push(['lookup', label]);
      return map.get(label);
    },
    list: () => harden([...map.keys()].sort()),
    /**
     * @param {string} label
     * @param {any} value
     */
    store: (label, value) => {
      log.push(['store', label]);
      if (map.has(label)) throw Error(textOf.labelTaken(label));
      map.set(label, value);
    },
    /** @param {string} label */
    remove: label => {
      log.push(['remove', label]);
      return map.delete(label);
    },
  });
  return { source, map, log };
};

/** @param {string} code */
const argsOf = code => JSON.stringify({ code });

/**
 * A fresh scope, adapter, fixtures and powers source.
 * @param {Record<string, any>} [extra] more labels
 */
const fresh = async (extra = {}) => {
  const { namespace } = await load();
  const scope = namespace.makeExecScope();
  const adapter = makeAdapter();
  const fx = await fixtures();
  const mirror = Far('Mirror', {
    /** @param {unknown} x */
    echo: x => x,
    /** @param {unknown} x */
    isNotes: x => x === fx.notes,
  });
  const powers = makeSource({
    notes: fx.notes,
    mirror,
    cfg: harden({ json: '{"a":[1,2],"n":"12345678901234567890"}' }),
    ...extra,
  });
  /**
   * @param {string} code
   * @param {{ withPowers?: boolean }} [options]
   */
  const exec = (code, { withPowers = true } = {}) =>
    E(scope).run(
      harden({
        args: argsOf(code),
        writers: adapter.writers,
        timer: adapter.timer,
        ...(withPowers ? { powers: powers.source } : {}),
      }),
    );
  /** @param {Record<string, any>} request */
  const inspect = request =>
    E(scope).inspect(harden({ writers: adapter.writers, ...request }));
  return { scope, adapter, fx, powers, mirror, exec, inspect };
};

test('the exec bundle with W5.4 fits the budget M5 raises it to (O-1); the exec copy equals the contract', async t => {
  const { bundle } = await load();
  t.log(
    JSON.stringify({
      metric: 'exec.program',
      bytes: bundle.bytes,
      budget: EXEC_BUDGET_AFTER_M5,
      baseBudget: limits.execProgramBytes,
      modules: bundle.modules.length,
    }),
  );
  const bytes = /** @type {number} */ (bundle.bytes);
  t.true(bytes <= EXEC_BUDGET_AFTER_M5, `${bytes}`);
  t.false(bundle.modules.includes('lib/interfaces-m5.js'));
  // The copy is the contract's, value for value.
  const guards = execGuards();
  t.deepEqual(guards.ExecScope, m5Interfaces.ExecScope);
  t.deepEqual(guards.ExecRequest, m5Shapes.ExecRequest);
  t.deepEqual(guards.InspectRequest, m5Shapes.InspectRequest);
  t.deepEqual(guards.InspectOutcome, m5Shapes.InspectOutcome);
  t.is(execTexts.powersExpired, texts.powersExpired);
  t.is(execTextOf.valueTooLarge(9, 8), textOf.valueTooLarge(9, 8));
  t.is(execTextOf.toolSchemaInvalid('r'), textOf.toolSchemaInvalid('r'));
  t.is(execTextOf.membraneTooLarge(9, 8), textOf.membraneTooLarge(9, 8));
  t.is(execTextOf.membraneTooManyKeys(9, 8), textOf.membraneTooManyKeys(9, 8));
  t.is(execTextOf.membraneTooDeep(8), textOf.membraneTooDeep(8));
});

test('powers forwards lookup, list, store and remove to the session source; JSON values parse in the exec vat', async t => {
  const { exec, powers, fx } = await fresh();
  t.deepEqual(
    await exec(
      'const v = await E(powers).lookup("cfg"); return [v.a[1], v.n, typeof (await powers.lookup("missing"))];',
    ),
    {
      status: 'ok',
      text: JSON.stringify([2, '12345678901234567890', 'undefined'], null, 2),
    },
  );
  t.deepEqual(
    await exec(
      'await powers.store("big", { b: 12345678901234567890n }); const n = await powers.lookup("notes"); await E(powers).store("copy", n); return await powers.list();',
    ),
    {
      status: 'ok',
      text: JSON.stringify(['big', 'cfg', 'copy', 'mirror', 'notes'], null, 2),
    },
  );
  // A non-remotable value crosses as its JSON text (big integers as
  // decimals); a wrapper crosses as its target, never as the wrapper.
  t.deepEqual(powers.map.get('big'), { json: '{"b":"12345678901234567890"}' });
  t.is(powers.map.get('copy'), fx.notes);
  t.deepEqual(await exec('return await powers.remove("big");'), {
    status: 'ok',
    text: 'true',
  });
  t.false(powers.map.has('big'));
  // The session's refusals reach model code as errors.
  t.deepEqual(
    await exec(
      'try { await powers.store("notes", 1); } catch (e) { return e.message; }',
    ),
    { status: 'ok', text: JSON.stringify(textOf.labelTaken('notes')) },
  );
});

test('powers checks labels and values in the exec vat, before sending', async t => {
  const { exec, powers } = await fresh();
  const before = powers.log.length;
  const outcome = await exec(
    [
      'const out = [];',
      'for (const f of [() => powers.lookup(""), () => powers.lookup(5), () => powers.remove("x".repeat(257)),',
      '  () => powers.store("v", "x".repeat(9000)), () => powers.store("f", () => 1), () => powers.store("u", undefined)]) {',
      '  try { await f(); out.push("sent"); } catch (e) { out.push(e.message); }',
      '}',
      'return out;',
    ].join('\n'),
  );
  t.deepEqual(JSON.parse(outcome.text), [
    LABEL_TEXT,
    LABEL_TEXT,
    LABEL_TEXT,
    textOf.valueTooLarge(9002, limits.labelValueBytes),
    NOT_JSON_TEXT,
    NOT_JSON_TEXT,
  ]);
  t.is(powers.log.length, before, 'nothing reached the session');
  // A stored value of exactly labelValueBytes is sent.
  t.deepEqual(
    await exec('await powers.store("edge", "x".repeat(8190)); return 1;'),
    { status: 'ok', text: '1' },
  );
});

test('powers and wrappers die with their call: powersExpired, nothing sent; an M1b request keeps powers {}', async t => {
  const { exec, powers, fx } = await fresh();
  t.deepEqual(
    await exec(
      'globalThis.p = powers; globalThis.kept = await E(powers).lookup("notes"); return 1;',
    ),
    { status: 'ok', text: '1' },
  );
  const sent = powers.log.length;
  const outcome = await exec(
    [
      'const out = [];',
      'for (const f of [() => p.lookup("notes"), () => E(p).list(), () => p.store("a", 1), () => p.remove("a"),',
      '  () => E(kept).read(), () => powers.store("k", kept)]) {',
      '  try { await f(); out.push("sent"); } catch (e) { out.push(e.message); }',
      '}',
      'return out;',
    ].join('\n'),
  );
  t.deepEqual(JSON.parse(outcome.text), Array(6).fill(texts.powersExpired));
  t.is(powers.log.length, sent);
  t.deepEqual(await E(fx.notes).calls(), []);
  // Without request.powers (an M1b session) powers stays the empty record.
  t.deepEqual(
    await exec(
      'return [Object.keys(powers).length, Object.isFrozen(powers)];',
      {
        withPowers: false,
      },
    ),
    { status: 'ok', text: JSON.stringify([0, true], null, 2) },
  );
});

test('no raw presence outlives its call: a remotable deeper than ANSWER_DEPTH is refused, plain data passes (M5-FIX)', async t => {
  const leaf = Far('Leaf', { ping: () => 'pong' });
  /**
   * @param {number} depth
   * @param {boolean} withLeaf
   */
  const nestAround = (depth, withLeaf) => {
    /** @type {any} */
    let v = withLeaf ? leaf : 1;
    for (let i = 0; i < depth; i += 1) v = harden([v]);
    return v;
  };
  const { exec } = await fresh({ deep: Far('Deep', { make: nestAround }) });
  const unnest =
    'const unnest = v => { while (Array.isArray(v)) v = v[0]; return v; };';
  t.deepEqual(
    JSON.parse(
      (
        await exec(
          [
            unnest,
            'const d = await powers.lookup("deep");',
            `globalThis.w = unnest(await E(d).make(${ANSWER_DEPTH - 1}, true));`,
            'const out = [await E(w).ping(), unnest(await E(d).make(70, false))];',
            'try { await E(d).make(70, true); out.push("answered"); } catch (e) { out.push(e.message); }',
            'return out;',
          ].join('\n'),
        )
      ).text,
    ),
    ['pong', 1, textOf.membraneTooDeep(ANSWER_DEPTH)],
  );
  // The wrapper of the ended call is refused, by a send and by a get.
  t.deepEqual(
    JSON.parse(
      (
        await exec(
          [
            'const out = [];',
            'for (const f of [() => E(w).ping(), () => E.get(w).ping]) {',
            '  try { await f(); out.push("sent"); } catch (e) { out.push(e.message); }',
            '}',
            'return out;',
          ].join('\n'),
        )
      ).text,
    ),
    Array(2).fill(texts.powersExpired),
  );
});

test('no raw presence outlives its call: E.get through a wrapper answers a wrapper (M5-FIX)', async t => {
  const leaf = Far('Leaf', { ping: () => 'pong' });
  const holder = Far('Holder', {});
  // A call E whose property get answers a remotable, as a get on another
  // vat's object may; the local E answers only methods.
  const callE = Object.assign((/** @type {any} */ x) => E(x), {
    sendOnly: E.sendOnly,
    resolve: E.resolve,
    when: E.when,
    get: (/** @type {any} */ x) =>
      harden({ inner: Promise.resolve(x === holder ? leaf : undefined) }),
  });
  const first = makeMembrane({ callE });
  const firstE = /** @type {any} */ (first.E);
  const inner = await firstE.get(first.wrap(holder)).inner;
  t.not(inner, leaf);
  t.true(isWrapper(inner));
  t.is(await firstE(inner).ping(), 'pong');
  // A get through a promise for the wrapper is wrapped too.
  t.true(
    isWrapper(await firstE.get(Promise.resolve(first.wrap(holder))).inner),
  );
  // Kept past its call, it is refused under the next call's membrane.
  const nextE = /** @type {any} */ (makeMembrane({ callE }).E);
  await t.throwsAsync(() => nextE(inner).ping(), {
    message: texts.powersExpired,
  });
  await t.throwsAsync(() => nextE.get(inner).inner, {
    message: texts.powersExpired,
  });
});

test('the membrane: wrappers stand for their targets, answers are wrapped, a result renders as its target', async t => {
  const { exec, fx } = await fresh();
  t.deepEqual(
    await exec(
      [
        'const n = await E(powers).lookup("notes");',
        'const m = await powers.lookup("mirror");',
        'const back = await E(m).echo(n);',
        'return [n === (await powers.lookup("notes")), back === n, await E(m).isNotes(n), await E(back).read(),',
        '  await E(E(powers).lookup("notes")).read(), await E(E(m).echo(n)).read()];',
      ].join('\n'),
    ),
    {
      status: 'ok',
      text: JSON.stringify(
        [
          true,
          true,
          true,
          'remember the milk',
          'remember the milk',
          'remember the milk',
        ],
        null,
        2,
      ),
    },
  );
  // eslint-disable-next-line no-underscore-dangle
  const names = await E(fx.notes).__getMethodNames__();
  t.deepEqual(await exec('return await powers.lookup("notes");'), {
    status: 'ok',
    text: `[remote capability] callable methods: ${JSON.stringify(names)}`,
  });
});

test('the membrane refuses an oversize argument, a 40-key record and a nested promise before sending', async t => {
  const { exec, fx } = await fresh();
  const outcome = await exec(
    [
      'const n = await powers.lookup("notes");',
      'const out = [];',
      'const keys = {}; for (let i = 0; i < 40; i += 1) keys["k" + i] = i;',
      'for (const f of [() => E(n).write("a".repeat(102400)), () => E(n).write(keys),',
      '  () => E(n).write([Promise.resolve(1)]), () => E.sendOnly(n).write("b".repeat(102400))]) {',
      '  try { await f(); out.push("sent"); } catch (e) { out.push(e.message); }',
      '}',
      'await E(n).write("small"); out.push(await E(n).read());',
      'await E(n).write(Promise.resolve("awaited")); out.push(await E(n).read());',
      'return out;',
    ].join('\n'),
  );
  t.deepEqual(JSON.parse(outcome.text), [
    textOf.membraneTooLarge(307_200, limits.membraneArgBytes),
    textOf.membraneTooManyKeys(40, limits.membraneRecordKeys),
    NESTED_PROMISE_TEXT,
    'sent',
    'small',
    'awaited',
  ]);
  // Only the two small writes and the reads reached the fixture.
  t.deepEqual(await E(fx.notes).calls(), ['write', 'read', 'write', 'read']);
});

test('measureArguments: each bound at its limit passes, one over is refused; the walk copies and swaps', t => {
  const ok = (/** @type {unknown[]} */ args) =>
    'args' in measureArguments(args);
  const refusal = (/** @type {unknown[]} */ args) =>
    /** @type {any} */ (measureArguments(args)).refusal;
  // Bytes: units x 3.
  t.true(ok(['x'.repeat(limits.membraneArgBytes / 3)]));
  t.is(
    refusal(['x'.repeat(limits.membraneArgBytes / 3 + 1)]),
    textOf.membraneTooLarge(
      limits.membraneArgBytes + 3,
      limits.membraneArgBytes,
    ),
  );
  // Keys of one record.
  /**
   * @param {number} n
   * @param {string} [p]
   */
  const rec = (n, p = 'k') =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${p}${i}`, 0]));
  t.true(ok([rec(32)]));
  t.is(refusal([rec(33)]), textOf.membraneTooManyKeys(33, 32));
  // Keys of the whole message.
  t.true(ok([Array.from({ length: 8 }, () => rec(32, 'a'))]));
  t.is(
    refusal([Array.from({ length: 9 }, () => rec(32, 'a'))]),
    textOf.membraneTooManyKeys(288, 256),
  );
  // Depth: the argument itself is at 1; 31 arrays around a number reach 32.
  /** @param {number} n */
  const nest = n => {
    /** @type {any} */
    let v = 1;
    for (let i = 0; i < n; i += 1) v = [v];
    return v;
  };
  t.true(ok([nest(31)]));
  t.is(refusal([nest(32)]), textOf.membraneTooDeep(32));
  // The model's own objects are copied, not hardened in place; swap applies.
  const mine = { a: [1] };
  const target = Far('T', {});
  const stand = Far('W', {});
  const out = /** @type {any} */ (
    measureArguments([mine, stand], {
      swap: v => (v === stand ? target : v),
    })
  ).args;
  t.false(Object.isFrozen(mine));
  t.deepEqual(out[0], { a: [1] });
  t.is(out[1], target);
});

/** Model code that builds a remotable by hand (the scope has no `Far`). */
const FORGE = [
  'const PS = Symbol.for("passStyle");',
  'const proto = harden(Object.create(Object.prototype, { [PS]: { value: "remotable" },',
  '  [Symbol.toStringTag]: { value: "Alleged: mine" } }));',
  'const mine = harden(Object.create(proto, { hello: { value: () => "hi" } }));',
].join('\n');

test('what a model-made object can receive: nothing from another vat; it never leaves through the membrane (XC)', async t => {
  /** @type {any[]} */
  const received = [];
  const keeper = Far('Keeper', {
    /** @param {unknown} x */
    keep: x => {
      received.push(x);
      return 'kept';
    },
  });
  const { exec, fx } = await fresh({ keeper });
  const outcome = await exec(
    [
      FORGE,
      'const k = await powers.lookup("keeper");',
      'const n = await powers.lookup("notes");',
      'const out = [];',
      'for (const f of [() => E(k).keep(mine), () => E(k).keep([{ deep: mine }]),',
      '  () => E(k).keep(harden({ mine })), () => E.sendOnly(k).keep(mine)]) {',
      '  try { const a = await f(); out.push(a === undefined ? "sendOnly" : a); } catch (e) { out.push(e.message); }',
      '}',
      // A message to the model's own object stays in the vat (measured).
      'out.push(await E(mine).hello());',
      // This call's wrapper and data still pass.
      'out.push(await E(k).keep(harden({ n, s: "x" })));',
      'globalThis.oldNotes = n;',
      'return out;',
    ].join('\n'),
  );
  t.deepEqual(outcome, {
    status: 'ok',
    text: JSON.stringify(
      [
        MODEL_OBJECT_TEXT,
        MODEL_OBJECT_TEXT,
        MODEL_OBJECT_TEXT,
        'sendOnly',
        'hi',
        'kept',
      ],
      null,
      2,
    ),
  });
  // The keeper (another vat's object) received the target, never the forged
  // object nor a wrapper.
  t.is(received.length, 1);
  t.is(received[0].n, fx.notes);
  // A wrapper of an ended call in a later call's message: powersExpired.
  t.deepEqual(
    await exec(
      [
        'const k = await powers.lookup("keeper");',
        'try { await E(k).keep([globalThis.oldNotes]); return "sent"; } catch (e) { return e.message; }',
      ].join('\n'),
    ),
    { status: 'ok', text: JSON.stringify(texts.powersExpired) },
  );
  t.is(received.length, 1, 'nothing reached the keeper');
});

test('rule 12.13 (X-FIX, was the residual): powers.store refuses a model-made object, so it cannot come back wrapped and leave', async t => {
  // `powers.store` used to pass any remotable to the session; `lookup` in a
  // later call answered it wrapped, and it could then be sent to another
  // vat, whose calls reached model code after the call that made it ended.
  // `store` now takes only this call's wrappers among remotables.
  /** @type {any[]} */
  const received = [];
  const keeper = Far('Keeper', {
    /** @param {unknown} x */
    keep: x => {
      received.push(x);
      return 'kept';
    },
  });
  const { exec } = await fresh({ keeper });
  t.deepEqual(
    await exec(
      [
        FORGE,
        'try { await powers.store("mine", mine); } catch (e) { return e.message; }',
        'return "stored";',
      ].join('\n'),
    ),
    { status: 'ok', text: JSON.stringify(MODEL_OBJECT_TEXT) },
  );
  t.deepEqual(
    await exec(
      [
        'const w = await powers.lookup("mine");',
        'const k = await powers.lookup("keeper");',
        'if (w !== undefined) return await E(k).keep(w);',
        'await powers.store("again", k);',
        'return typeof (await powers.lookup("again"));',
      ].join('\n'),
    ),
    { status: 'ok', text: JSON.stringify('object') },
    'nothing was stored under the label; a wrapper of this call still stores',
  );
  t.is(received.length, 0, 'the model-made object never left');
});

test('tagged values keep their tag through the membrane, both ways (XC)', async t => {
  /** @type {any[]} */
  const seen = [];
  const { passStyleOf } = /** @type {GuestGlobals} */ (globalThis);
  const tags = Far('Tags', {
    /** @param {any} x */
    echo: x => {
      seen.push([passStyleOf(x), x[Symbol.toStringTag]]);
      return x;
    },
  });
  const { exec, fx } = await fresh({ tags });
  const outcome = await exec(
    [
      'const PS = Symbol.for("passStyle");',
      'const tag = (t, p) => harden(Object.create(Object.prototype, { [PS]: { value: "tagged" },',
      '  [Symbol.toStringTag]: { value: t }, payload: { value: p, enumerable: true } }));',
      'const m = await powers.lookup("tags");',
      'const n = await powers.lookup("notes");',
      'const back = await E(m).echo(tag("copySet", harden(["a", "b"])));',
      'const withCap = await E(m).echo(tag("holder", harden([n])));',
      'return [back[Symbol.toStringTag], back.payload, withCap[Symbol.toStringTag],',
      '  await E(withCap.payload[0]).read()];',
    ].join('\n'),
  );
  t.deepEqual(outcome, {
    status: 'ok',
    text: JSON.stringify(
      ['copySet', ['a', 'b'], 'holder', 'remember the milk'],
      null,
      2,
    ),
  });
  t.deepEqual(seen, [
    ['tagged', 'copySet'],
    ['tagged', 'holder'],
  ]);
  // measureArguments alone: the copy keeps the tag, the payload is swapped.
  const target = Far('T', {});
  const stand = Far('W', {});
  const copySet = harden(
    Object.create(Object.prototype, {
      [Symbol.for('passStyle')]: { value: 'tagged' },
      [Symbol.toStringTag]: { value: 'copySet' },
      payload: { value: harden([stand]), enumerable: true },
    }),
  );
  t.is(passStyleOf(copySet), 'tagged');
  const out = /** @type {any} */ (
    measureArguments([copySet], {
      swap: v => (v === stand ? target : v),
    })
  ).args[0];
  t.is(passStyleOf(out), 'tagged');
  t.is(out[Symbol.toStringTag], 'copySet');
  t.is(out.payload[0], target);
  t.truthy(fx);
});

test('inspect methods and describe render without calling the object; Fae describeCapability rules', async t => {
  const { inspect, fx, adapter } = await fresh();
  // eslint-disable-next-line no-underscore-dangle
  const names = await E(fx.notes).__getMethodNames__();
  t.deepEqual(await inspect({ op: 'methods', target: fx.notes }), {
    status: 'ok',
    methods: names,
  });
  t.deepEqual(await E(fx.notes).calls(), []);
  // Many long names: at most 128 of at most 128 units.
  const many = Far(
    'Many',
    Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `m${i}${'x'.repeat(200)}`,
        () => i,
      ]),
    ),
  );
  const bounded = /** @type {{ methods: string[] }} */ (
    await inspect({ op: 'methods', target: many })
  );
  t.is(bounded.methods.length, 128);
  // Every name is cut to 128 units (`__getMethodNames__` itself is shorter).
  t.true(bounded.methods.every(n => n.length <= 128));
  t.true(bounded.methods.filter(n => n.length === 128).length >= 127);
  t.true(matchesOutcome(bounded));

  const overview = JSON.parse(
    (await inspect({ op: 'describe', target: fx.notes })).text,
  );
  t.is(overview.documentationScope, 'overview');
  t.deepEqual(overview.methods, names);
  t.false(overview.truncated);
  const method = JSON.parse(
    (await inspect({ op: 'describe', target: fx.notes, method: 'read' })).text,
  );
  t.is(method.documentationScope, 'method');
  t.is(method.documentation, 'notes.read: see read() and write(text).');
  t.deepEqual(
    await inspect({ op: 'describe', target: fx.notes, method: 'nope' }),
    {
      status: 'failed',
      text: UNKNOWN_METHOD_TEXT,
    },
  );
  // A guarded help() that takes no argument: the overview instead.
  const guarded = makeExo(
    'Guarded',
    M.interface('Guarded', { help: M.call().returns(M.string()) }),
    { help: () => 'zero-argument help' },
  );
  const fallback = JSON.parse(
    (await inspect({ op: 'describe', target: guarded, method: 'help' })).text,
  );
  t.is(fallback.documentationScope, 'overview');
  t.is(fallback.documentation, 'zero-argument help');
  // 200 KB of help (in a vat the exec vat would halt decoding it: W5.5's
  // probe b): cut to 8,000 units and flagged.
  const big = await inspect({ op: 'describe', target: fx.bigHelp });
  const bigText = JSON.parse(adapter.textOfOutcome(big.text));
  t.is(bigText.documentation.length, limits.describeDocumentationUnits);
  t.true(bigText.truncated);
});

/** @param {unknown} outcome */
const matchesOutcome = outcome =>
  /** @type {any} */ (globalThis).matches(outcome, m5Shapes.InspectOutcome);

test('inspect readSources: Fae item rules, SourceReader per item, bounded results, staged arguments', async t => {
  const { inspect, fx, adapter } = await fresh();
  const items = [
    { path: ['README.md'], startLine: 2, lineCount: 3 },
    { path: ['src', 'agent.js'], search: 'checkpoint' },
    { path: ['nope.md'] },
    { path: ['a/b'] },
    { path: ['README.md'], extra: 1 },
    { path: ['README.md'], lineCount: 201 },
  ];
  const outcome = await inspect({
    op: 'readSources',
    target: fx.sourceReader,
    args: JSON.stringify(items),
  });
  t.is(outcome.status, 'ok');
  const { results } = JSON.parse(outcome.text);
  t.deepEqual(results[0], {
    index: 0,
    ok: true,
    lines: [
      { line: 2, text: 'README line 2' },
      { line: 3, text: 'README line 3' },
      { line: 4, text: 'README line 4' },
    ],
    scanTruncated: false,
    outputTruncated: true,
  });
  t.deepEqual(
    results[1].lines.map((/** @type {any} */ l) => l.line),
    [3, 6],
  );
  t.deepEqual(results[2], { index: 2, ok: false, error: 'No such file' });
  t.true(
    results[3].error.startsWith('path must contain 1–64 relative segments'),
  );
  t.is(
    results[4].error,
    'Unexpected argument "extra" for readSources item; allowed arguments: path, startLine, lineCount, search',
  );
  t.is(
    results[5].error,
    'Line/count arguments must be integers between 1 and 200',
  );
  // Item count, JSON, and a staged argument read through Content.
  t.deepEqual(
    await inspect({ op: 'readSources', target: fx.sourceReader, args: '[]' }),
    { status: 'failed', text: ITEMS_TEXT },
  );
  const notJson = await inspect({
    op: 'readSources',
    target: fx.sourceReader,
    args: '[{',
  });
  t.true(notJson.text.startsWith('could not parse tool arguments as JSON ('));
  const staged = await inspect({
    op: 'readSources',
    target: fx.sourceReader,
    args: adapter.stage(
      JSON.stringify([{ path: ['README.md'], lineCount: 1 }]),
    ),
    content: adapter.content,
  });
  t.is(JSON.parse(staged.text).results[0].lines[0].text, 'README line 1');
  // A reader that throws or answers another shape: the unreadable text.
  const odd = Far('Odd', {
    /** @param {any} request */
    read: request =>
      request.path[0] === 'throw'
        ? Promise.reject(Error('secret detail'))
        : harden({ ok: true, lines: 5 }),
  });
  const oddOut = JSON.parse(
    (
      await inspect({
        op: 'readSources',
        target: odd,
        args: JSON.stringify([{ path: ['throw'] }, { path: ['shape'] }]),
      })
    ).text,
  );
  t.deepEqual(
    oddOut.results.map((/** @type {any} */ r) => r.error),
    [UNREADABLE_TEXT, UNREADABLE_TEXT],
  );
  // One long item stays within the 48,000-unit budget.
  const wide = Far('Wide', {
    read: () =>
      harden({
        ok: true,
        lines: Array.from({ length: 200 }, (_, i) => ({
          line: i + 1,
          text: 'w'.repeat(7000),
        })),
      }),
  });
  const wideOut = await inspect({
    op: 'readSources',
    target: wide,
    args: JSON.stringify([{ path: ['w'], lineCount: 200 }]),
  });
  const wideText = adapter.textOfOutcome(wideOut.text);
  const wideResult = JSON.parse(wideText).results[0];
  t.true(wideResult.outputTruncated);
  t.true(JSON.stringify(wideResult).length <= limits.inspectResultUnits - 100);
});

test('inspect toolSchema: a ToolDescription, or refused-schema reasons', async t => {
  const { inspect, fx } = await fresh();
  const good = await inspect({ op: 'toolSchema', target: fx.echoTool });
  t.true(matchesOutcome(good));
  t.is(good.description.name, 'echo2');
  t.deepEqual(JSON.parse(good.description.parameters).required, ['text']);
  for (const [target, reason] of [
    [fx.badSchemaTool, 'the schema is not { type: "function", function }'],
    [fx.deepSchemaTool, 'parameters nest deeper than 32'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await inspect({ op: 'toolSchema', target }), {
      status: 'failed',
      text: textOf.toolSchemaInvalid(reason),
    });
  }
  const big = await inspect({ op: 'toolSchema', target: fx.bigSchemaTool });
  t.regex(
    big.text,
    /^The granted tool's schema was refused: the parameters are \d+ characters of JSON; the limit is 2048$/,
  );
  /** @param {any} schema */
  const toolWith = schema => Far('T', { schema: () => harden(schema) });
  const fn = (/** @type {any} */ f) => ({ type: 'function', function: f });
  const parameters = { type: 'object', properties: {} };
  const badName = await inspect({
    op: 'toolSchema',
    target: toolWith(fn({ name: 'a b', description: '', parameters })),
  });
  t.is(badName.status, 'failed');
  const nodes = await inspect({
    op: 'toolSchema',
    target: toolWith(
      fn({
        name: 'wide',
        description: '',
        parameters: {
          type: 'object',
          enum: Array.from({ length: 10_001 }, () => 0),
        },
      }),
    ),
  });
  t.is(
    nodes.text,
    textOf.toolSchemaInvalid('parameters have more than 10000 values'),
  );
  const long = await inspect({
    op: 'toolSchema',
    target: toolWith(
      fn({ name: 'long', description: 'd'.repeat(2000), parameters }),
    ),
  });
  t.is(long.status, 'ok');
  t.is(long.description.description.length, limits.grantedDescriptionUnits);
  t.true(long.description.description.startsWith('ddd'));
  t.true(matchesOutcome(long));
});

test('inspect toolExecute: string as is, else JSON; cut and staged; membrane bounds; errors; beside a running run', async t => {
  const { inspect, fx, adapter, exec } = await fresh();
  t.deepEqual(
    await inspect({
      op: 'toolExecute',
      target: fx.echoTool,
      args: '{"text":"hi"}',
    }),
    { status: 'ok', text: 'echo2: hi' },
  );
  const objectTool = Far('O', { execute: () => harden({ n: 10n, s: 'x' }) });
  t.deepEqual(
    await inspect({ op: 'toolExecute', target: objectTool, args: '{}' }),
    {
      status: 'ok',
      text: '{"n":"10","s":"x"}',
    },
  );
  const big = await inspect({
    op: 'toolExecute',
    target: fx.bigAnswerTool,
    args: '{}',
  });
  t.is(big.status, 'ok');
  const bigText = adapter.textOfOutcome(big.text);
  t.is(bigText.length, limits.toolOutputUnits);
  t.deepEqual(
    await inspect({ op: 'toolExecute', target: fx.throwingTool, args: '{}' }),
    { status: 'failed', text: 'the throwing fixture tool failed' },
  );
  t.deepEqual(
    await inspect({ op: 'toolExecute', target: fx.echoTool, args: '[1]' }),
    {
      status: 'failed',
      text: ARGUMENTS_OBJECT_TEXT,
    },
  );
  const keys = JSON.stringify(
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
  );
  t.deepEqual(
    await inspect({ op: 'toolExecute', target: fx.echoTool, args: keys }),
    {
      status: 'failed',
      text: textOf.membraneTooManyKeys(40, 32),
    },
  );
  // A slow tool and an exec call run side by side (inspect is never busy).
  const slow = inspect({
    op: 'toolExecute',
    target: fx.slowTool,
    args: '{"text":"s"}',
  });
  await new Promise(resolve => setImmediate(resolve));
  t.deepEqual(await E(fx.slowTool).runs(), { started: 1, finished: 0 });
  t.deepEqual(await exec('return 7;'), { status: 'ok', text: '7' });
  await E(fx.slowTool).release();
  t.deepEqual(await slow, { status: 'ok', text: 'slow: s' });
});

test('a key flood or an exhausted name table answers exhausted; another error fails', async t => {
  const { inspect } = await fresh();
  const exhausted = Far('X', {
    schema: () => {
      throw RangeError('property key space exhausted');
    },
  });
  t.deepEqual(await inspect({ op: 'toolSchema', target: exhausted }), {
    status: 'exhausted',
  });
  const broken = Far('B', { schema: () => Promise.reject(Error('nope')) });
  t.deepEqual(await inspect({ op: 'toolSchema', target: broken }), {
    status: 'failed',
    text: 'nope',
  });
  t.true(matchesOutcome(harden({ status: 'exhausted' })));
});
