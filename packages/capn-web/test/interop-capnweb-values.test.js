// @ts-nocheck
/* eslint-disable max-classes-per-file, class-methods-use-this -- interop suite mirrors capnweb's RpcTarget idiom */
// Wire-format equivalence between @endo/capn-web and a real
// cloudflare/capnweb (the tracked `capnweb` devDependency, currently
// 0.10.x).  For each value we assert three things:
//
//   1. Byte-identical wire: the port's devaluator emits the same JSON that
//      capnweb's `serialize()` does.
//   2. capnweb consumes the port's wire (`capnweb.deserialize(portWire)`).
//   3. The port consumes capnweb's wire (`portEvaluate(capnwebWire)`).
//
// (1)-(3) use capnweb's standalone `serialize`/`deserialize` (which take the
// JSON-string encoding level — the same one the WebSocket and HTTP-batch
// transports use) and the port's own devaluator/evaluator with a
// capability-free context, so these are pure data-plane checks.  Capability,
// pipelining, and map interop live in interop-capnweb.test.js and
// interop-capnweb-caps.test.js.

import test from '@endo/ses-ava/test.js';

import { makeDevaluator } from '../src/devaluate.js';
import { makeEvaluator } from '../src/evaluate.js';

let capnweb;
try {
  capnweb = await import('capnweb');
} catch (_e) {
  capnweb = null;
}
const interop = capnweb ? test : test.skip;

// A capability-free codec: pure-data values never touch the export/import
// hooks, so a hook that throws documents the intent (and catches mistakes).
const makePortCodec = () => {
  const boom = name => () => {
    throw new Error(`ctx.${name} unexpectedly called for a pure-data value`);
  };
  const devaluator = makeDevaluator({
    importIdOf: () => undefined,
    exportValue: boom('exportValue'),
    sendPipe: boom('sendPipe'),
  });
  const evaluator = makeEvaluator({
    getOrMakePresence: boom('getOrMakePresence'),
    getOrMakePromise: boom('getOrMakePromise'),
    getExportValue: boom('getExportValue'),
    consumePipeReadable: () => undefined,
  });
  return {
    serialize: v => JSON.stringify(devaluator.devaluate(v)),
    deserialize: s => evaluator.evaluate(JSON.parse(s)),
  };
};

const codec = makePortCodec();

// Assert full three-way wire compatibility for `value`.  `eq(t, got, want)`
// defaults to deepEqual; pass a custom comparator for Errors etc.  Set
// `checkBytes:false` for values whose exact byte form legitimately varies.
const assertWireCompat = (t, label, value, opts = {}) => {
  const { eq = (tt, got, want) => tt.deepEqual(got, want), checkBytes = true } =
    opts;
  const portWire = codec.serialize(value);
  const capnwebWire = capnweb.serialize(value);
  if (checkBytes) {
    t.is(portWire, capnwebWire, `${label}: wire bytes match capnweb`);
  }
  eq(t, capnweb.deserialize(portWire), value); // capnweb consumes ours
  eq(t, codec.deserialize(capnwebWire), value); // we consume capnweb's
};

const eqError = (t, got, want) => {
  t.true(got instanceof Error, 'decoded to an Error');
  t.is(got.name, want.name, 'error name');
  t.is(got.message, want.message, 'error message');
};

// ---------- primitives & non-finite numbers ----------

interop('scalars: null / booleans / integers / floats', t => {
  for (const [label, v] of [
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['int', 42],
    ['negative', -7],
    ['float', 3.5],
    ['max-safe-int', Number.MAX_SAFE_INTEGER],
    ['empty string', ''],
    ['unicode string', 'héllo → 世界'],
    ['string with newline', 'a\nb'],
    ['string with quote', 'she said "hi"'],
  ]) {
    assertWireCompat(t, label, v);
  }
});

interop('non-finite numbers: NaN / +Infinity / -Infinity', t => {
  assertWireCompat(t, 'NaN', NaN, {
    eq: (tt, got) => tt.true(Number.isNaN(got)),
  });
  assertWireCompat(t, '+Infinity', Infinity);
  assertWireCompat(t, '-Infinity', -Infinity);
});

interop('undefined', t => {
  assertWireCompat(t, 'undefined', undefined, {
    eq: (tt, got) => tt.is(got, undefined),
  });
});

// ---------- bigint ----------

interop('bigint: zero / negative / very large', t => {
  assertWireCompat(t, '0n', 0n, { eq: (tt, g) => tt.is(g, 0n) });
  assertWireCompat(t, '-123n', -123n, { eq: (tt, g) => tt.is(g, -123n) });
  const huge = 123_456_789_012_345_678_901_234_567_890n;
  assertWireCompat(t, 'huge', huge, { eq: (tt, g) => tt.is(g, huge) });
});

// ---------- Date, including Invalid Date ----------

interop('date: epoch / negative / typical', t => {
  const eqDate = (tt, got, want) => tt.is(got.getTime(), want.getTime());
  assertWireCompat(t, 'epoch', new Date(0), { eq: eqDate });
  assertWireCompat(t, 'negative', new Date(-1000), { eq: eqDate });
  assertWireCompat(t, 'typical', new Date(1_700_000_000_000), { eq: eqDate });
});

interop('date: Invalid Date round-trips as ["date", null]', t => {
  // Regression: capnweb encodes a NaN-time date as ["date", null]; the port
  // must both emit that form and decode it back to an Invalid Date rather
  // than throwing "date must be a number".
  const eqInvalid = (tt, got) =>
    tt.true(got instanceof Date && Number.isNaN(got.getTime()));
  assertWireCompat(t, 'invalid date', new Date(NaN), { eq: eqInvalid });
  t.is(codec.serialize(new Date(NaN)), '["date",null]');
});

// ---------- Uint8Array ----------

interop('bytes: empty / small / high bytes / larger', t => {
  const eqBytes = (tt, got, want) =>
    tt.deepEqual(Array.from(got), Array.from(want));
  assertWireCompat(t, 'empty', new Uint8Array([]), { eq: eqBytes });
  assertWireCompat(t, 'small', new Uint8Array([1, 2, 3]), { eq: eqBytes });
  assertWireCompat(t, 'high bytes', new Uint8Array([0, 250, 255, 128]), {
    eq: eqBytes,
  });
  const big = new Uint8Array(300);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 256;
  assertWireCompat(t, 'larger', big, { eq: eqBytes });
});

interop('bytes: base64 padding is omitted to match capnweb', t => {
  // 1 and 2 residual bytes are the cases that would carry "==" / "=" padding.
  t.is(codec.serialize(new Uint8Array([250])), '["bytes","+g"]');
  t.is(codec.serialize(new Uint8Array([1, 2])), '["bytes","AQI"]');
});

// ---------- Errors ----------

interop('error: each standard type round-trips', t => {
  for (const Ctor of [
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    EvalError,
    URIError,
  ]) {
    assertWireCompat(t, Ctor.name, new Ctor(`${Ctor.name} message`), {
      eq: eqError,
    });
  }
});

interop('error: cause round-trips via the props bag', t => {
  const err = new Error('outer', { cause: new TypeError('inner cause') });
  assertWireCompat(t, 'error with cause', err, {
    eq: (tt, got) => {
      eqError(tt, got, err);
      tt.true(got.cause instanceof TypeError, 'cause preserved as TypeError');
      tt.is(got.cause.message, 'inner cause');
    },
  });
});

interop('error: custom own-enumerable prop round-trips', t => {
  const err = new Error('boom');
  err.code = 'E_BOOM';
  err.detail = { retriable: true };
  assertWireCompat(t, 'error with props', err, {
    eq: (tt, got) => {
      eqError(tt, got, err);
      tt.is(got.code, 'E_BOOM');
      tt.deepEqual(got.detail, { retriable: true });
    },
  });
});

interop('error: AggregateError preserves message and errors', t => {
  const err = new AggregateError(
    [new Error('a'), new RangeError('b')],
    'aggregate boom',
  );
  assertWireCompat(t, 'AggregateError', err, {
    eq: (tt, got) => {
      tt.true(got instanceof AggregateError);
      tt.is(got.message, 'aggregate boom');
      tt.is(got.errors.length, 2);
      tt.is(got.errors[0].message, 'a');
      tt.true(got.errors[1] instanceof RangeError);
      tt.is(got.errors[1].message, 'b');
    },
  });
});

// ---------- compound structures ----------

interop('structures: arrays / records / nesting / specials inside', t => {
  const eqDeep = (tt, got, want) => tt.deepEqual(got, want);
  assertWireCompat(t, 'empty array', [], { eq: eqDeep });
  assertWireCompat(t, 'empty record', {}, { eq: eqDeep });
  assertWireCompat(t, 'flat array', [1, 'two', true, null], { eq: eqDeep });
  assertWireCompat(t, 'nested array', [[1, [2, [3, [4]]]]], { eq: eqDeep });
  assertWireCompat(
    t,
    'record',
    { a: 1, b: [2, 3], c: { d: 'e' }, f: null },
    { eq: eqDeep },
  );
  // Specials nested inside a structure.
  const mixed = {
    when: new Date(1_700_000_000_000),
    count: 42n,
    data: new Uint8Array([9, 8, 7]),
    tags: ['x', 'y'],
  };
  assertWireCompat(t, 'record of specials', mixed, {
    eq: (tt, got) => {
      tt.is(got.when.getTime(), mixed.when.getTime());
      tt.is(got.count, 42n);
      tt.deepEqual(Array.from(got.data), [9, 8, 7]);
      tt.deepEqual(got.tags, ['x', 'y']);
    },
  });
});

interop('structures: deep nesting under capnweb depth limit', t => {
  // capnweb 0.10 defaults maxDepth to 256; build a chain well under it.
  let obj = { leaf: true };
  for (let i = 0; i < 40; i += 1) obj = { next: obj };
  assertWireCompat(t, 'deep chain', obj, {
    eq: (tt, got) => {
      let cur = got;
      for (let i = 0; i < 40; i += 1) cur = cur.next;
      tt.true(cur.leaf);
    },
  });
});

// ---------- hardening against a hostile wire ----------

interop('safety: __proto__ / constructor keys from a peer are dropped', t => {
  // Craft a capnweb wire record carrying prototype-polluting keys.  The port
  // must decode it without walking Object.prototype's setter or polluting.
  const hostile = JSON.stringify({
    __proto__: { polluted: true },
    constructor: { polluted: true },
    safe: 1,
  });
  const got = codec.deserialize(hostile);
  t.is(got.safe, 1);
  t.false('polluted' in {}, 'Object.prototype not polluted');
  t.is(Object.getPrototypeOf(got), Object.prototype, 'clean prototype');
});

interop('safety: hostile error typeName cannot reach Object.prototype', t => {
  // ["error","constructor",…] previously resolved to Object → a String
  // wrapper.  With the null-prototype ERROR_TYPES table it falls back to Error.
  for (const bad of [
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
  ]) {
    const got = codec.deserialize(JSON.stringify(['error', bad, 'msg']));
    t.true(got instanceof Error, `["error","${bad}"] decodes to an Error`);
    t.is(got.message, 'msg');
  }
});

interop('safety: dangerous keys in an error props bag are not assigned', t => {
  // 5th-element props with a polluting key: capnweb evaluates but does not
  // assign it; the port must match.
  const wire = JSON.stringify([
    'error',
    'Error',
    'boom',
    null,
    { __proto__: 1, toJSON: 2, code: 'OK' },
  ]);
  const got = codec.deserialize(wire);
  t.is(got.message, 'boom');
  t.is(got.code, 'OK');
  t.false('polluted' in {});
  t.is(Object.getPrototypeOf(got), Error.prototype);
});
