/* eslint-disable */
// @ts-nocheck
//
// isfrozen.js — the "how much does `Object.isFrozen` cost, per byte-array size
// and per wrapper shape, on each engine" benchmark requested on PR #602
// (endojs/endo-but-for-bots#602, kriskowal: "Please also benchmark `isFrozen`
// for byte arrays of varying size on each platform.").
//
// A single, dependency-free, flat script that runs UNMODIFIED on both engines,
// the same flat-script idiom as its sibling `codec-emulation.js`:
//
//     node packages/immutable-arraybuffer/benchmarks/isfrozen.js
//     xst  packages/immutable-arraybuffer/benchmarks/isfrozen.js
//
// It has NO imports and uses only `Date.now`/`performance.now`, `Object`,
// `Uint8Array`, `Proxy`, `Reflect`, and `WeakMap`.
//
// ---------------------------------------------------------------------------
// Why `isFrozen` at all, and why per-size
// ---------------------------------------------------------------------------
//
// SES's `harden` is built on `Object.isFrozen`: the transitive walk checks
// `isFrozen` on every object it reaches to decide whether it is already sealed
// and can be skipped. A freezable-`TypedArray` view over an immutable
// `ArrayBuffer` is exactly the kind of object that walk meets, so the *per-call*
// cost of `Object.isFrozen` on such a view — and whether that cost grows with
// the byte length — is a real hardening-hot-path question, distinct from the
// per-element read cost `codec-emulation.js` measures.
//
// `Object.isFrozen(O)` is `TestIntegrityLevel(O, frozen)`:
//   1. If `IsExtensible(O)` is true, return false.        (fast exit)
//   2. Let keys = O.[[OwnPropertyKeys]]().                (can be O(n)!)
//   3. For each key, if its descriptor is configurable (or, for frozen, a
//      writable data property), return false.
//
// Step 2 is where size *could* enter: a genuine Integer-Indexed Exotic view of
// length n has n own integer-indexed keys, so materializing that key list — and
// then asking `[[GetOwnProperty]]` for each — is O(n) in principle. The two
// EMULATED wrapper shapes this PR compares avoid those keys entirely:
//
//   - plain-object wrapper (`src/lib.js`): an ordinary object with a handful of
//     *named* own/inherited members and NO integer-indexed own keys, so its
//     own-key set is size-independent — `isFrozen` is O(1) in n.
//   - Proxy wrapper (`src/proxy-lib.js` makeFreezableIndexRejectingProxy): the
//     proxy target is a plain object (again no integer-indexed own keys), and
//     the proxy installs no `ownKeys` / `getOwnPropertyDescriptor` / `isExtensible`
//     traps, so `TestIntegrityLevel` forwards straight to that plain target —
//     O(1) in n, plus a fixed proxy-dispatch tax.
//
// So the empirical questions are:
//   (a) For the shapes SES actually hardens (the two emulated wrappers, frozen),
//       is `isFrozen` flat in the byte length on each engine? (Expected: yes.)
//   (b) What is the constant-factor gap between them — does the Proxy's
//       trap-dispatch tax show up on `isFrozen` the way it does on indexed reads?
//   (c) For a GENUINE view, does `isFrozen` scale with n (the O(n) key walk), or
//       does the engine short-circuit? Measured on both an extensible genuine
//       view (should fast-exit at step 1) and a non-extensible one (forced past
//       step 1 into the key walk).
//   (d) Can a genuine view even BE frozen on this platform? (Objection 1 of the
//       design: an integer-indexed exotic refuses to make index "0"
//       non-configurable, so `Object.freeze` THROWS. Attempted at startup and
//       reported per engine — this is why the emulated wrappers exist.)
//
// The wrapper models are the same ones `codec-emulation.js` uses (plain-object
// amplifier from `src/lib.js`; the freezable Proxy from `src/proxy-lib.js`), so
// the two benchmarks describe the same two objects.

'use strict';

/* global print, console, globalThis, Date, Object, Uint8Array, ArrayBuffer, Proxy, Reflect, WeakMap, Math, String, Number */

// --- portable I/O and clock -------------------------------------------------

const emit =
  typeof console !== 'undefined' && console.log
    ? (...a) => console.log(a.join(' '))
    : s => print(s);

const now =
  typeof globalThis !== 'undefined' &&
  globalThis.performance &&
  globalThis.performance.now
    ? () => globalThis.performance.now()
    : () => Date.now();

// XS exposes `print` and no `console`; Node the reverse. The engine name only
// affects the default size sweep (XS is an interpreter, ~1000x slower per JS
// op, so its sweep tops out lower to keep the run bounded).
const IS_XS = typeof print === 'function' && typeof console === 'undefined';
const ENGINE = IS_XS ? 'XS' : 'Node';

// --- data generation --------------------------------------------------------

const makeBinary = len => {
  const a = new Uint8Array(len);
  // A cheap, deterministic, non-trivial fill (no Math.random dependency).
  let x = 0x9e3779b1;
  for (let i = 0; i < len; i += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    a[i] = x & 0xff;
  }
  return a;
};

// --- the two emulated-view models (identical to codec-emulation.js) ----------

// plain-object wrapper (models src/lib.js): a plain object whose prototype
// carries an amplifier-delegating `at`/`length` — WeakMap-get the hidden
// genuine TypedArray. It has NO integer-indexed own keys by construction, so
// `Object.freeze` succeeds and its `isFrozen` own-key walk is size-independent.
const hiddenTypedArrays = new WeakMap();
const { get: wmGet, set: wmSet } = WeakMap.prototype;
const { apply: reflectApply, get: reflectGet } = Reflect;
const taAt = Uint8Array.prototype.at;

const plainProto = {
  at(i) {
    const genuine = reflectApply(wmGet, hiddenTypedArrays, [this]);
    return reflectApply(taAt, genuine, [i]);
  },
  get length() {
    const genuine = reflectApply(wmGet, hiddenTypedArrays, [this]);
    return genuine.length;
  },
};

const makePlainWrapper = genuine => {
  const wrapper = Object.create(plainProto);
  reflectApply(wmSet, hiddenTypedArrays, [wrapper, genuine]);
  return wrapper;
};

// Proxy wrapper (models src/proxy-lib.js makeFreezableIndexRejectingProxy): the
// target is a FREEZE-ABLE plain object (an ordinary `Object.create` over the
// flavor prototype), the genuine TypedArray is held in the closure, and the
// `get` trap forwards reads. Critically for `isFrozen`, NO `ownKeys` /
// `getOwnPropertyDescriptor` / `isExtensible` / `preventExtensions` traps are
// installed, so `TestIntegrityLevel` forwards to the plain target — which has
// no integer-indexed own keys — and `Object.freeze` succeeds. Trap body kept
// faithful (buffer redirect, mutator-name guard, method rebinding) so the fixed
// proxy-dispatch tax is real, even though `isFrozen` itself never invokes `get`.
const mutatorMethodNames = ['copyWithin', 'fill', 'reverse', 'set', 'sort'];
const isMutatorName = key => {
  for (const name of mutatorMethodNames) {
    if (key === name) return true;
  }
  return false;
};

const makeFreezableProxyWrapper = genuine => {
  const target = Object.create(Uint8Array.prototype);
  return new Proxy(target, {
    get(_target, key) {
      if (key === 'buffer') {
        return undefined;
      }
      if (isMutatorName(key)) {
        return undefined;
      }
      const value = reflectGet(genuine, key);
      if (typeof value === 'function' && key !== 'constructor') {
        return (...args) => reflectApply(value, genuine, args);
      }
      return value;
    },
    set() {
      return true;
    },
    getPrototypeOf() {
      return Uint8Array.prototype;
    },
  });
};

// --- can a GENUINE view be frozen on this engine? (objection 1) --------------
//
// Attempt, at startup, to produce a genuine frozen TypedArray view — over a
// native immutable ArrayBuffer when the proposal is present, else a plain
// genuine view. Both throw today (an integer-indexed exotic refuses to make
// index "0" non-configurable), which is exactly why the emulated wrappers
// above exist; we record the outcome per engine rather than assert it.

const optTransferToImmutable =
  typeof ArrayBuffer.prototype.transferToImmutable === 'function'
    ? ArrayBuffer.prototype.transferToImmutable
    : undefined;

const makeGenuineImmutableView = len => {
  const src = makeBinary(len);
  // transferToImmutable detaches `src.buffer` and returns an immutable buffer.
  const immutableBuffer = reflectApply(optTransferToImmutable, src.buffer, []);
  return new Uint8Array(immutableBuffer);
};

let genuineFrozenNote;
{
  let view;
  let over;
  if (optTransferToImmutable) {
    over = 'native immutable ArrayBuffer';
    try {
      view = makeGenuineImmutableView(8);
    } catch (e) {
      view = undefined;
      genuineFrozenNote = `could not build a view over a ${over}: ${e.message}`;
    }
  } else {
    over = 'genuine mutable Uint8Array';
    view = makeBinary(8);
  }
  if (genuineFrozenNote === undefined) {
    try {
      Object.freeze(view);
      genuineFrozenNote = Object.isFrozen(view)
        ? `Object.freeze(${over} view) SUCCEEDS, isFrozen === true`
        : `Object.freeze(${over} view) did not throw but isFrozen === false`;
    } catch (e) {
      genuineFrozenNote = `Object.freeze(${over} view) THROWS: ${e.message} (objection 1 — a genuine view is not freezable)`;
    }
  }
}

// --- timing -----------------------------------------------------------------

let sink = 0; // defeat dead-code elimination

// Run `fn` (which returns a boolean) enough times to accumulate at least
// `minMs`, capped at `maxIters`, then return mean milliseconds per call.
const bench = (fn, minMs, maxIters) => {
  // Warm up (and let the JIT specialize on Node).
  sink += fn() ? 1 : 0;
  sink += fn() ? 1 : 0;
  let iters = 1;
  for (;;) {
    const t0 = now();
    for (let k = 0; k < iters; k += 1) {
      sink += fn() ? 1 : 0;
    }
    const dt = now() - t0;
    if (dt >= minMs || iters >= maxIters) {
      return dt / iters;
    }
    const factor = dt > 0 ? Math.max(2, Math.ceil((minMs / dt) * 1.2)) : 8;
    iters = Math.min(maxIters, iters * factor);
  }
};

// --- the shapes whose `isFrozen` we time ------------------------------------
//
// Each `make(len)` returns the object to probe, already in its final integrity
// state. `expect` is the `Object.isFrozen` result we assert (a wrong answer
// means the model is broken, not that the timing is interesting).

const shapes = [
  {
    key: 'genuineExt',
    label: 'genuine (extensible)',
    make: len => makeBinary(len),
    expect: false, // IsExtensible === true -> fast exit at step 1
  },
  {
    key: 'genuineNonExt',
    label: 'genuine (preventExtensions)',
    make: len => {
      const a = makeBinary(len);
      Object.preventExtensions(a);
      return a;
    },
    expect: false, // non-extensible, but index "0" is configurable -> false
  },
  {
    key: 'plainFrozen',
    label: 'plain wrapper (frozen)',
    make: len => {
      const w = makePlainWrapper(makeBinary(len));
      Object.freeze(w);
      return w;
    },
    expect: true,
  },
  {
    key: 'proxyFrozen',
    label: 'proxy wrapper (frozen)',
    make: len => {
      const w = makeFreezableProxyWrapper(makeBinary(len));
      Object.freeze(w);
      return w;
    },
    expect: true,
  },
];

// --- the sweep --------------------------------------------------------------

const SIZES_NODE = [16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];
const SIZES_XS = [16, 64, 256, 1024, 4096, 16384, 65536];
const sizes = IS_XS ? SIZES_XS : SIZES_NODE;

// Time budget per cell. XS has only a 1 ms `Date.now` clock, and a single
// `isFrozen` call is nanoseconds, so each cell must accumulate a healthy
// multiple of that 1 ms tick to be meaningful.
const MIN_MS = IS_XS ? 200 : 100;
const MAX_ITERS = 5000000;

const pad = (s, n) => {
  s = String(s);
  while (s.length < n) s = ` ${s}`;
  return s;
};

emit('');
emit(
  `# isFrozen benchmark — ${ENGINE}  (nanoseconds per Object.isFrozen call, lower is faster)`,
);
emit(`#   genuine-view freezability: ${genuineFrozenNote}`);
emit(
  `#   columns are the object shape whose isFrozen is timed; a genuine FROZEN view is`,
);
emit(
  `#   absent above, so the two "(frozen)" columns are the emulated wrappers this PR compares.`,
);
emit('');
emit(
  [
    pad('bytes', 9),
    pad('genuineExt', 12),
    pad('genuineNonExt', 15),
    pad('plainFrozen', 13),
    pad('proxyFrozen', 13),
  ].join(' '),
);

const machine = []; // per-size records for the JSON tail

// Assert each shape's isFrozen answer once up front (correctness before timing).
for (const shape of shapes) {
  const probe = shape.make(64);
  const got = Object.isFrozen(probe);
  if (got !== shape.expect) {
    emit(
      `#   WARNING: shape ${shape.key} expected isFrozen=${shape.expect} but got ${got}`,
    );
  }
}

const ns = msPerOp => msPerOp * 1e6;

for (const len of sizes) {
  const objects = shapes.map(shape => shape.make(len));
  const times = objects.map(obj =>
    bench(() => Object.isFrozen(obj), MIN_MS, MAX_ITERS),
  );

  const record = { bytes: len };
  for (let i = 0; i < shapes.length; i += 1) {
    record[`${shapes[i].key}Ns`] = ns(times[i]);
  }
  machine.push(record);

  emit(
    [
      pad(len, 9),
      pad(ns(times[0]).toFixed(1), 12),
      pad(ns(times[1]).toFixed(1), 15),
      pad(ns(times[2]).toFixed(1), 13),
      pad(ns(times[3]).toFixed(1), 13),
    ].join(' '),
  );
}

emit('');
emit(
  `#   If a column is flat across the size sweep, isFrozen is O(1) in the byte length`,
);
emit(
  `#   for that shape; a rising column is the O(n) integer-indexed key walk of step 2.`,
);
emit('');
emit(`# sink=${sink & 0xffff}`);
emit(`#JSON ${JSON.stringify({ engine: ENGINE, shapes: shapes.map(s => ({ key: s.key, label: s.label, expectFrozen: s.expect })), genuineFrozen: genuineFrozenNote, data: machine })}`);
