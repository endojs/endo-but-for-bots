// @ts-check
// The environments adapter's command output (resources/environments/impl/
// command-output.js; designs/m6-interfaces.md D-M6-6, 5.5, section 11):
// the tool-path JSON is always valid JSON within toolOutputUnits with the
// R4-46 marker inside each cut field, and the exec-path record fits its
// shape and answerBytes. Node adapter test; no vat.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  environmentLimits,
  environmentShapes,
} from '../../guest/lib/guards/environments.js';
import { textOf } from '../../guest/lib/interfaces.js';
import { fitsFrame } from '../../guest/lib/bounded.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  boundCommandRecord,
  boundCommandResult,
  decodeStream,
  stderrShareUnits,
} from '../../resources/environments/impl/command-output.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { mustMatch } = /** @type {GuestGlobals} */ (globalThis);

const encoder = new TextEncoder();
const streamBytes = environmentLimits.streamBytes;

/**
 * A RawResult as the runtime answers it: each stream kept to streamBytes.
 * @param {Uint8Array | string} stdout
 * @param {Uint8Array | string} [stderr]
 * @param {Partial<import('../../resources/environments/impl/command-output.js').RawResult>} [rest]
 */
const rawOf = (stdout, stderr = '', rest = {}) => {
  /** @param {Uint8Array | string} value */
  const keep = value => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    return bytes.length > streamBytes
      ? { bytes: bytes.subarray(0, streamBytes), cut: true }
      : { bytes, cut: false };
  };
  const out = keep(stdout);
  const err = keep(stderr);
  return {
    stdout: out.bytes,
    stderr: err.bytes,
    stdoutCut: out.cut,
    stderrCut: err.cut,
    exitCode: 0,
    signal: null,
    timedOut: false,
    ms: 1,
    ...rest,
  };
};

/** A small deterministic PRNG (mulberry32), so a failure is reproducible. */
const makeRandom = (/** @type {number} */ seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Characters of every UTF-8 width and every JSON escape class: ASCII,
// a quote and a backslash (2 units escaped), a control character (6
// units), 2-, 3- and 4-byte characters (the last a surrogate pair).
const alphabet = ['a', ' ', '\n', '"', '\\', '\u0001', 'é', '€', '漢', '😀'];

/**
 * @param {() => number} random
 * @param {number} bytes about this many UTF-8 bytes
 */
const randomText = (random, bytes) => {
  /** @type {string[]} */
  const parts = [];
  // A run of one character keeps the generator fast on 80 KiB streams.
  let size = 0;
  while (size < bytes) {
    const char = alphabet[Math.floor(random() * alphabet.length)];
    const run = 1 + Math.floor(random() * 512);
    parts.push(char.repeat(run));
    size += encoder.encode(char).length * run;
  }
  return parts.join('');
};

/**
 * Whether `field` is `original` cut with the R4-46 marker inside it.
 * @param {string} field
 * @param {string} original
 */
const isMarkedCut = (field, original) => {
  const marker = textOf.truncationMarker(original.length);
  return (
    field.endsWith(marker) &&
    original.startsWith(field.slice(0, field.length - marker.length))
  );
};

test('a small result is the A.3 JSON unchanged', t => {
  const text = boundCommandResult(
    rawOf('hello\n', 'warn\n', { exitCode: 3, signal: null }),
  );
  t.is(
    text,
    JSON.stringify({
      stdout: 'hello\n',
      stderr: 'warn\n',
      exitCode: 3,
      signal: null,
      truncated: false,
    }),
  );
});

test('a stream cut by the runtime is truncated even when its JSON fits', t => {
  const raw = rawOf('x'.repeat(10));
  const parsed = JSON.parse(boundCommandResult({ ...raw, stdoutCut: true }));
  t.is(parsed.stdout, 'x'.repeat(10));
  t.true(parsed.truncated);
});

test('property: any output is valid JSON within toolOutputUnits, markers inside cut fields', t => {
  const random = makeRandom(0x5eed);
  for (let i = 0; i < 120; i += 1) {
    const stdout = randomText(random, Math.floor(random() * 80 * 1024));
    const stderr =
      random() < 0.3 ? '' : randomText(random, Math.floor(random() * 80 * 1024));
    const raw = rawOf(stdout, stderr, {
      exitCode: random() < 0.5 ? 0 : null,
      signal: random() < 0.2 ? 'SIGKILL' : null,
    });
    const decodedOut = decodeStream(raw.stdout, raw.stdoutCut);
    const decodedErr = decodeStream(raw.stderr, raw.stderrCut);
    const text = boundCommandResult(raw);
    t.true(text.length <= limits.toolOutputUnits, `case ${i}: ${text.length}`);
    const parsed = JSON.parse(text);
    t.deepEqual(Object.keys(parsed), [
      'stdout',
      'stderr',
      'exitCode',
      'signal',
      'truncated',
    ]);
    t.is(parsed.exitCode, raw.exitCode);
    t.is(parsed.signal, raw.signal);
    for (const [field, original] of [
      [parsed.stdout, decodedOut],
      [parsed.stderr, decodedErr],
    ]) {
      t.true(
        field === original || isMarkedCut(field, original),
        `case ${i}: a field is whole or a marked prefix`,
      );
      // Never a lone surrogate: the cut is at a code point boundary.
      t.false(/[\ud800-\udbff](?![\udc00-\udfff])/.test(field));
    }
    const cut = parsed.stdout !== decodedOut || parsed.stderr !== decodedErr;
    t.is(parsed.truncated, cut || raw.stdoutCut || raw.stderrCut);
  }
});

test('stderr keeps at least its share when both streams are long', t => {
  const text = boundCommandResult(rawOf('o'.repeat(70_000), 'e'.repeat(70_000)));
  const parsed = JSON.parse(text);
  t.true(parsed.truncated);
  const marker = textOf.truncationMarker(streamBytes);
  t.true(parsed.stderr.length - marker.length >= stderrShareUnits);
  t.true(parsed.stdout.length > parsed.stderr.length);
  t.true(text.length <= limits.toolOutputUnits);
  t.true(text.length > limits.toolOutputUnits - 400, 'the room is used');
});

test('a field is cut by its escaped length: control characters take six units', t => {
  const text = boundCommandResult(rawOf('\u0001'.repeat(20_000)));
  t.true(text.length <= limits.toolOutputUnits);
  const parsed = JSON.parse(text);
  t.true(isMarkedCut(parsed.stdout, '\u0001'.repeat(20_000)));
  // 32,768 units of JSON hold about 5,400 escaped control characters.
  const kept = parsed.stdout.length - textOf.truncationMarker(20_000).length;
  t.true(kept > 5000 && kept < 5500, `${kept}`);
});

test('invalid UTF-8 and a NUL become U+FFFD and an escape; the JSON is valid', t => {
  const bytes = new Uint8Array([0x61, 0xff, 0x00, 0xc3, 0x28, 0x62]);
  const parsed = JSON.parse(boundCommandResult(rawOf(bytes)));
  t.is(parsed.stdout, 'a�\u0000�(b');
});

test('a stream cut inside a character drops the partial character', t => {
  const bytes = encoder.encode('ab€'); // € is three bytes
  const cut = bytes.subarray(0, 4);
  t.is(decodeStream(cut, true), 'ab');
  // An uncut stream ending in a partial character keeps a replacement.
  t.is(decodeStream(cut, false), 'ab�');
});

test('one 1 MiB line without a newline is cut inside the field', t => {
  const line = 'z'.repeat(1024 * 1024);
  const raw = rawOf(line);
  t.true(raw.stdoutCut);
  const text = boundCommandResult(raw);
  t.true(text.length <= limits.toolOutputUnits);
  const parsed = JSON.parse(text);
  t.true(isMarkedCut(parsed.stdout, 'z'.repeat(streamBytes)));
  t.true(parsed.truncated);
});

test('a smaller maxUnits is honoured', t => {
  for (const maxUnits of [600, 1000, 4096]) {
    const text = boundCommandResult(rawOf('q'.repeat(9000), 'r'.repeat(9000)), {
      maxUnits,
    });
    t.true(text.length <= maxUnits, `${maxUnits}: ${text.length}`);
    t.true(JSON.parse(text).truncated);
  }
});

test('the exec-path record fits CommandResult and answerBytes', t => {
  const random = makeRandom(0xc0ffee);
  for (let i = 0; i < 40; i += 1) {
    const raw = rawOf(
      randomText(random, Math.floor(random() * 80 * 1024)),
      randomText(random, Math.floor(random() * 8 * 1024)),
      { exitCode: 1, signal: i % 2 === 0 ? 'SIGTERM' : null },
    );
    const record = boundCommandRecord(raw);
    mustMatch(record, environmentShapes.CommandResult);
    t.true(fitsFrame(record, environmentLimits.answerBytes));
    t.is(record.exitCode, 1);
  }
  const small = boundCommandRecord(rawOf('ok\n'));
  t.deepEqual(small, {
    stdout: 'ok\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: false,
  });
  const long = boundCommandRecord(rawOf('y'.repeat(5000)));
  t.true(long.truncated);
  t.true(isMarkedCut(long.stdout, 'y'.repeat(5000)));
  t.true(long.stdout.length <= environmentLimits.shellAnswerStreamUnits);
});
