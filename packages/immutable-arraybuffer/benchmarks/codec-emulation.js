/* eslint-disable */
// @ts-nocheck
//
// codec-emulation.js — the "native-with-copy vs emulated-without-copy" benchmark
// requested on PR #602 (endojs/endo-but-for-bots#602, kriskowal).
//
// A single, dependency-free, flat script that runs UNMODIFIED on both engines:
//
//     node packages/immutable-arraybuffer/benchmarks/codec-emulation.js
//     xst  packages/immutable-arraybuffer/benchmarks/codec-emulation.js
//
// It has NO imports (so `xst` can run it directly, the same flat-script idiom
// `@endo/ses`'s own `test:xs` uses) and uses only `Date.now`, `Uint8Array`,
// `Proxy`, `Reflect`, `WeakMap`, `TextEncoder`, `TextDecoder`, and — when the
// engine provides them — the native `toBase64` / `toHex` intrinsics. Absent
// intrinsics are detected and their column is reported as "n/a".
//
// ---------------------------------------------------------------------------
// What it measures, and why this models the real decision
// ---------------------------------------------------------------------------
//
// The bytes an `@endo/bytes` / `@endo/base64` / `@endo/hex` codec serializes
// (the bytes -> text direction: UTF-8 decode, Base64 encode, Hex encode, ASCII
// encode) may live in an *immutable ArrayBuffer* whose bytes are only reachable
// through an EMULATED freezable-TypedArray view. Two families of strategy:
//
//   native-with-copy    Copy the immutable buffer's bytes into a genuine
//                       mutable Uint8Array (`bytesFromImmutable` ===
//                       `new Uint8Array(buffer.slice(0))`, modelled here as
//                       `genuine.slice()`), then run the fast native codec
//                       (TextDecoder / toBase64 / toHex) over the genuine copy.
//                       Pays a full O(n) copy; wins the per-byte work at C++
//                       speed. On Node/web there is such a native copy fallback
//                       for everything EXCEPT ASCII (no native ASCII codec).
//
//   emulated-without-copy
//                       Read each byte in place through the emulated view and
//                       run the pure-JS codec. No copy. But every byte read
//                       pays the emulation's per-element cost, which differs by
//                       wrapper shape:
//                         - plain-object wrapper: `view[i]` is `undefined`
//                           (a plain object has no integer-indexed slot), so
//                           `.at(i)` is the ONLY option — an amplifier
//                           delegation (WeakMap-get the hidden genuine
//                           TypedArray, then apply native `at`).
//                         - Proxy wrapper: `view[i]` works — a `get` trap
//                           forwards to the hidden genuine TypedArray — so
//                           bracket indexing is available and (the open
//                           question) plausibly cheaper than `.at`.
//
// The only thing that differs across strategies is the byte-access path, so the
// benchmark isolates exactly that: whether the immutable buffer is backed by a
// genuine mutable buffer or a real proposal-immutable one does not change read
// cost, so the models below wrap a genuine hidden Uint8Array. The plain-`.at`
// model reproduces the shipped wrapper's amplifier delegation
// (`src/lib.js`); the Proxy model reproduces `src/proxy-lib.js`'s
// `makeIndexRejectingProxy` `get` trap verbatim. The JS codecs are the shipped
// `jsEncodeHex` / `jsEncodeBase64` polyfills, read-path-parameterized.
//
// For each (codec, size) it sweeps these strategies and reports throughput
// (MiB/s, higher is better) plus the size THRESHOLD at which native-with-copy
// overtakes emulated-without-copy:
//
//   copy+native     copy, then native intrinsic          (native-with-copy)
//   copy+js         copy, then JS codec over genuine `[i]` (copy, no native)
//   js+genuineIdx   JS codec over genuine `[i]`, no copy  (emulation-free floor)
//   js+plainAt      JS codec over plain wrapper `.at(i)`  (emulated, no copy)
//   js+proxyIdx     JS codec over Proxy wrapper `[i]`     (emulated, no copy)
//   js+proxyAt      JS codec over Proxy wrapper `.at(i)`  (emulated, no copy)
//
// "js+genuineIdx" is the reference floor: the JS codec with neither a copy nor
// emulation overhead. The gap from it to js+plainAt / js+proxyIdx is the pure
// emulation tax; the gap from it to copy+native is what the copy buys back.
//
// js+proxyIdx vs js+proxyAt directly tests the comment's hypothesis that, for a
// Proxy wrapper, bracket indexing is faster than `.at`; js+plainAt vs
// js+proxyIdx tests which EMULATION (plain-object, forced onto `.at`, vs Proxy,
// free to index) serves the codec's read faster — the ASCII-package choice.

'use strict';

/* global print, console, globalThis, Date, Uint8Array, Proxy, Reflect, WeakMap, TextEncoder, TextDecoder, Math, String, Array, Number */

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

// --- the shipped pure-JS codecs, read-path-parameterized --------------------
//
// `read(view, i)` is the byte accessor; `len` the element count. Specializing
// the loop per accessor (rather than passing a closure) keeps each strategy's
// inner loop identical to the real code: genuine and Proxy both use `view[i]`;
// the plain wrapper uses `view.at(i)`.

const hexAlphabet = '0123456789abcdef';

const jsEncodeHexIndex = (view, len) => {
  const chars = new Array(len * 2);
  for (let i = 0; i < len; i += 1) {
    const b = view[i];
    const j = i * 2;
    chars[j] = hexAlphabet[b >>> 4];
    chars[j + 1] = hexAlphabet[b & 0x0f];
  }
  return chars.join('');
};

const jsEncodeHexAt = (view, len) => {
  const chars = new Array(len * 2);
  for (let i = 0; i < len; i += 1) {
    const b = view.at(i);
    const j = i * 2;
    chars[j] = hexAlphabet[b >>> 4];
    chars[j + 1] = hexAlphabet[b & 0x0f];
  }
  return chars.join('');
};

const alphabet64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const padding = '=';

const jsEncodeBase64Index = (view, len) => {
  let string = '';
  let register = 0;
  let quantum = 0;
  for (let i = 0; i < len; i += 1) {
    const b = view[i];
    register = (register << 8) | b;
    quantum += 8;
    if (quantum === 24) {
      string +=
        alphabet64[(register >>> 18) & 0x3f] +
        alphabet64[(register >>> 12) & 0x3f] +
        alphabet64[(register >>> 6) & 0x3f] +
        alphabet64[(register >>> 0) & 0x3f];
      register = 0;
      quantum = 0;
    }
  }
  if (quantum === 8) {
    string +=
      alphabet64[(register >>> 2) & 0x3f] +
      alphabet64[(register << 4) & 0x3f] +
      padding +
      padding;
  } else if (quantum === 16) {
    string +=
      alphabet64[(register >>> 10) & 0x3f] +
      alphabet64[(register >>> 4) & 0x3f] +
      alphabet64[(register << 2) & 0x3f] +
      padding;
  }
  return string;
};

const jsEncodeBase64At = (view, len) => {
  let string = '';
  let register = 0;
  let quantum = 0;
  for (let i = 0; i < len; i += 1) {
    const b = view.at(i);
    register = (register << 8) | b;
    quantum += 8;
    if (quantum === 24) {
      string +=
        alphabet64[(register >>> 18) & 0x3f] +
        alphabet64[(register >>> 12) & 0x3f] +
        alphabet64[(register >>> 6) & 0x3f] +
        alphabet64[(register >>> 0) & 0x3f];
      register = 0;
      quantum = 0;
    }
  }
  if (quantum === 8) {
    string +=
      alphabet64[(register >>> 2) & 0x3f] +
      alphabet64[(register << 4) & 0x3f] +
      padding +
      padding;
  } else if (quantum === 16) {
    string +=
      alphabet64[(register >>> 10) & 0x3f] +
      alphabet64[(register >>> 4) & 0x3f] +
      alphabet64[(register << 2) & 0x3f] +
      padding;
  }
  return string;
};

// A minimal but correct streaming UTF-8 decoder (bytes -> string), chunked to
// avoid quadratic string growth. This is the shape a pure-JS `bytesToText`
// fallback would take on an engine without a native TextDecoder, reading each
// byte through the emulated view.
const decodeUtf8 = (view, len, read) => {
  let out = '';
  const buf = new Array(0x1000);
  let bi = 0;
  const flush = () => {
    // String.fromCharCode.apply chunk; guard for XS apply-arity by joining.
    out += String.fromCharCode.apply(String, buf.slice(0, bi));
    bi = 0;
  };
  let i = 0;
  while (i < len) {
    const b0 = read(view, i);
    let cp;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | (read(view, i + 1) & 0x3f);
      i += 2;
    } else if (b0 < 0xf0) {
      cp =
        ((b0 & 0x0f) << 12) |
        ((read(view, i + 1) & 0x3f) << 6) |
        (read(view, i + 2) & 0x3f);
      i += 3;
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        ((read(view, i + 1) & 0x3f) << 12) |
        ((read(view, i + 2) & 0x3f) << 6) |
        (read(view, i + 3) & 0x3f);
      i += 4;
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      buf[bi] = 0xd800 + (cp >> 10);
      bi += 1;
      buf[bi] = 0xdc00 + (cp & 0x3ff);
      bi += 1;
    } else {
      buf[bi] = cp;
      bi += 1;
    }
    if (bi >= 0xf00) flush();
  }
  flush();
  return out;
};

// ASCII encode (bytes -> string), chunked. No native ASCII codec exists on
// Node or the web, so this per-byte read is unavoidable regardless of platform;
// the only knob is the read path (`[i]` vs `.at`).
const encodeAscii = (view, len, read) => {
  let out = '';
  const buf = new Array(0x1000);
  let bi = 0;
  for (let i = 0; i < len; i += 1) {
    buf[bi] = read(view, i);
    bi += 1;
    if (bi >= 0xf00) {
      out += String.fromCharCode.apply(String, buf.slice(0, bi));
      bi = 0;
    }
  }
  out += String.fromCharCode.apply(String, buf.slice(0, bi));
  return out;
};

const readIndex = (view, i) => view[i];
const readAt = (view, i) => view.at(i);

// --- the two emulated-view models -------------------------------------------

// plain-object wrapper (models src/lib.js): a plain object whose prototype
// carries an amplifier-delegating `at` — WeakMap-get the hidden genuine
// TypedArray, then apply native `%TypedArray%.prototype.at`. `view[i]` is
// undefined by construction, exactly as for the shipped wrapper.
const hiddenTypedArrays = new WeakMap();
const { get: wmGet } = WeakMap.prototype;
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
  reflectApply(WeakMap.prototype.set, hiddenTypedArrays, [wrapper, genuine]);
  return wrapper;
};

// Proxy wrapper (models src/proxy-lib.js makeIndexRejectingProxy): the `get`
// trap forwards reads to the hidden genuine TypedArray. Trap body reproduced
// verbatim (buffer redirect, mutator-name guard, method rebinding) so an
// integer-indexed read pays the real trap cost.
const mutatorMethodNames = ['copyWithin', 'fill', 'reverse', 'set', 'sort'];
const isMutatorName = key => {
  for (const name of mutatorMethodNames) {
    if (key === name) return true;
  }
  return false;
};

const makeProxyWrapper = genuine =>
  new Proxy(genuine, {
    get(_target, key) {
      if (key === 'buffer') {
        // In the real wrapper this returns the immutable buffer; the read
        // benchmark never touches it, so the branch cost alone is what matters.
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
  });

// --- timing -----------------------------------------------------------------

let sink = 0; // defeat dead-code elimination

// Run `fn` enough times to accumulate at least `minMs`, capped at `maxIters`,
// then return mean milliseconds per call.
const bench = (fn, minMs, maxIters) => {
  // Warm up (and let the JIT specialize on Node).
  sink += fn().length;
  sink += fn().length;
  let iters = 1;
  for (;;) {
    const t0 = now();
    for (let k = 0; k < iters; k += 1) {
      sink += fn().length;
    }
    const dt = now() - t0;
    if (dt >= minMs || iters >= maxIters) {
      return dt / iters;
    }
    const factor = dt > 0 ? Math.max(2, Math.ceil((minMs / dt) * 1.2)) : 8;
    iters = Math.min(maxIters, iters * factor);
  }
};

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

const makeAscii = len => {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    a[i] = 0x20 + (i % 0x5f); // printable ASCII 0x20..0x7e
  }
  return a;
};

// Valid UTF-8 bytes: encode a mixed-script string, then tile to `len`.
const utf8Seed = (() => {
  const s =
    'The quick brown fox — le renard rapide — 素早い狐 — быстрая лисица 0123456789 ';
  return new TextEncoder().encode(s);
})();

const makeUtf8 = len => {
  const a = new Uint8Array(len);
  // Tile whole seed copies; the trailing partial region is filled with ASCII
  // spaces (valid UTF-8) so we never split a multi-byte sequence at the end.
  let i = 0;
  while (i + utf8Seed.length <= len) {
    a.set(utf8Seed, i);
    i += utf8Seed.length;
  }
  while (i < len) {
    a[i] = 0x20;
    i += 1;
  }
  return a;
};

// --- native codec detection -------------------------------------------------

const nativeToHex =
  typeof Uint8Array.prototype.toHex === 'function'
    ? bytes => bytes.toHex()
    : undefined;
const nativeToBase64 =
  typeof Uint8Array.prototype.toBase64 === 'function'
    ? bytes => bytes.toBase64()
    : undefined;
const utf8Decoder = new TextDecoder();
const nativeUtf8 = bytes => utf8Decoder.decode(bytes);
let latin1Decoder;
try {
  latin1Decoder = new TextDecoder('latin1');
  latin1Decoder.decode(new Uint8Array([65]));
} catch (_e) {
  latin1Decoder = undefined; // XS has no 'latin1' label
}
const nativeAscii = latin1Decoder ? bytes => latin1Decoder.decode(bytes) : undefined;

// --- the sweep --------------------------------------------------------------

// Each codec: a data generator, a native-with-copy fn (or undefined), and the
// four JS strategies over genuine / plain / proxy.
const codecs = [
  {
    name: 'hex-encode',
    gen: makeBinary,
    native: nativeToHex,
    jsIndex: (view, len) => jsEncodeHexIndex(view, len),
    jsAt: (view, len) => jsEncodeHexAt(view, len),
  },
  {
    name: 'base64-encode',
    gen: makeBinary,
    native: nativeToBase64,
    jsIndex: (view, len) => jsEncodeBase64Index(view, len),
    jsAt: (view, len) => jsEncodeBase64At(view, len),
  },
  {
    name: 'utf8-decode',
    gen: makeUtf8,
    native: nativeUtf8,
    jsIndex: (view, len) => decodeUtf8(view, len, readIndex),
    jsAt: (view, len) => decodeUtf8(view, len, readAt),
  },
  {
    name: 'ascii-encode',
    gen: makeAscii,
    native: nativeAscii, // Node-only (latin1); undefined on XS
    jsIndex: (view, len) => encodeAscii(view, len, readIndex),
    jsAt: (view, len) => encodeAscii(view, len, readAt),
  },
];

const SIZES_NODE = [
  16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576,
];
const SIZES_XS = [16, 64, 256, 1024, 4096, 16384];
const sizes = IS_XS ? SIZES_XS : SIZES_NODE;

// Time budget per cell. XS has only a 1 ms `Date.now` clock, so each cell must
// accumulate a healthy multiple of that to be meaningful; the adaptive loop
// stops at 1 iteration once a single op already exceeds MIN_MS (the large XS
// sizes), so a high iteration cap only lengthens the small, fast cells.
const MIN_MS = IS_XS ? 200 : 80;
const MAX_ITERS = 200000;

const mibPerSec = (bytes, msPerOp) =>
  msPerOp > 0 ? bytes / (1024 * 1024) / (msPerOp / 1000) : 0;

const pad = (s, n) => {
  s = String(s);
  while (s.length < n) s = ` ${s}`;
  return s;
};

emit('');
emit(
  `# codec emulation benchmark — ${ENGINE}  (throughput MiB/s, higher is better)`,
);
emit(
  `#   native intrinsics: toHex=${!!nativeToHex} toBase64=${!!nativeToBase64} utf8=${true} ascii-latin1=${!!nativeAscii}`,
);
emit('');

const machine = {}; // codec -> array of per-size records, for the JSON tail

for (const codec of codecs) {
  machine[codec.name] = [];
  emit(`## ${codec.name}`);
  emit(
    [
      pad('bytes', 8),
      pad('copy+native', 12),
      pad('copy+js', 10),
      pad('js+genIdx', 10),
      pad('js+plainAt', 11),
      pad('js+proxyIdx', 12),
      pad('js+proxyAt', 11),
      '  threshold',
    ].join(' '),
  );

  let crossover = null;
  for (const len of sizes) {
    const genuine = codec.gen(len);
    const plain = makePlainWrapper(genuine);
    const proxy = makeProxyWrapper(genuine);

    const tCopyNative = codec.native
      ? bench(() => codec.native(genuine.slice()), MIN_MS, MAX_ITERS)
      : null;
    const tCopyJs = bench(
      () => codec.jsIndex(genuine.slice(), len),
      MIN_MS,
      MAX_ITERS,
    );
    const tGenIdx = bench(() => codec.jsIndex(genuine, len), MIN_MS, MAX_ITERS);
    const tPlainAt = bench(() => codec.jsAt(plain, len), MIN_MS, MAX_ITERS);
    const tProxyIdx = bench(() => codec.jsIndex(proxy, len), MIN_MS, MAX_ITERS);
    const tProxyAt = bench(() => codec.jsAt(proxy, len), MIN_MS, MAX_ITERS);

    // "best emulated-without-copy" = min(plainAt, proxyIdx). Crossover is the
    // first size where native-with-copy (if any) beats that best emulated path.
    const bestEmulatedMs = Math.min(tPlainAt, tProxyIdx, tProxyAt);
    let mark = '';
    if (tCopyNative !== null) {
      if (tCopyNative < bestEmulatedMs && crossover === null) {
        crossover = len;
        mark = '<- native wins here';
      }
    }

    machine[codec.name].push({
      bytes: len,
      copyNativeMiBs: tCopyNative !== null ? mibPerSec(len, tCopyNative) : null,
      copyJsMiBs: mibPerSec(len, tCopyJs),
      genIdxMiBs: mibPerSec(len, tGenIdx),
      plainAtMiBs: mibPerSec(len, tPlainAt),
      proxyIdxMiBs: mibPerSec(len, tProxyIdx),
      proxyAtMiBs: mibPerSec(len, tProxyAt),
    });

    emit(
      [
        pad(len, 8),
        pad(tCopyNative !== null ? mibPerSec(len, tCopyNative).toFixed(1) : 'n/a', 12),
        pad(mibPerSec(len, tCopyJs).toFixed(1), 10),
        pad(mibPerSec(len, tGenIdx).toFixed(1), 10),
        pad(mibPerSec(len, tPlainAt).toFixed(1), 11),
        pad(mibPerSec(len, tProxyIdx).toFixed(1), 12),
        pad(mibPerSec(len, tProxyAt).toFixed(1), 11),
        `  ${mark}`,
      ].join(' '),
    );
  }
  if (codec.native) {
    emit(
      `#   native-with-copy overtakes best emulated-without-copy at: ${
        crossover === null ? 'never in this sweep' : `${crossover} bytes`
      }`,
    );
  } else {
    emit(`#   (no native codec on ${ENGINE}; copy+native column is n/a)`);
  }
  emit('');
}

emit(`# sink=${sink & 0xffff}`);
emit(`#JSON ${JSON.stringify({ engine: ENGINE, data: machine })}`);
