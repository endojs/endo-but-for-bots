// @ts-check
// guest/lib/bounded.js and guest/lib/retired.js (M1a W1a.1): sizes measured
// on the sending side, surrogate-safe cuts and chunking, the R4-46 tool
// output bound, publish batches, and the retired-break predicate.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  boundToolOutput,
  chunkText,
  cutText,
  estimateBytes,
  fitsFrame,
  messageBytes,
  previewText,
  splitBatches,
  utf8Bytes,
} from '../../guest/lib/bounded.js';
import { isRetiredBreak, RETIRED_TEXT } from '../../guest/lib/retired.js';
import { limits } from '../../guest/lib/limits.js';
import { textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const EURO = '€'; // 3 bytes
const SMILE = '\u{1F600}'; // a surrogate pair, 4 bytes
const HIGH = '\ud83d'; // a lone high surrogate, 3 bytes as U+FFFD

/** @param {number} code */
const isHigh = code => code >= 0xd800 && code <= 0xdbff;
/** @param {number} code */
const isLow = code => code >= 0xdc00 && code <= 0xdfff;

/**
 * Whether `piece` ends inside a pair that `next` completes.
 * @param {string} piece
 * @param {string} next
 */
const splitBetween = (piece, next) =>
  piece.length > 0 &&
  next.length > 0 &&
  isHigh(piece.charCodeAt(piece.length - 1)) &&
  isLow(next.charCodeAt(0));

/**
 * A deterministic mixed text: ASCII, 2-byte, 3-byte, pairs, and an
 * occasional lone surrogate.
 * @param {number} length in code points
 * @param {number} seed
 */
const mixedText = (length, seed) => {
  const alphabet = ['a', 'b', 'é', EURO, SMILE, '\u{10348}', ' ', HIGH];
  let state = seed;
  const parts = [];
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    parts.push(alphabet[state % alphabet.length]);
  }
  return parts.join('');
};

test('estimate and exact byte counts', t => {
  t.is(estimateBytes(''), 0);
  t.is(estimateBytes(`a${EURO}b`), 9);
  t.is(utf8Bytes(''), 0);
  t.is(utf8Bytes(`a${EURO}b`), 5);
  t.is(utf8Bytes(SMILE), 4);
  t.is(utf8Bytes(HIGH), 3);
  t.is(utf8Bytes('é'), 2);
  for (const text of [mixedText(300, 1), mixedText(300, 2), SMILE + HIGH]) {
    t.is(utf8Bytes(text), Buffer.byteLength(text, 'utf8'));
    t.true(estimateBytes(text) >= utf8Bytes(text));
  }
});

test('messageBytes counts every string of a message, keys included', t => {
  const remote = Far('Thing', { ping: () => 1 });
  const message = harden({
    rev: 3,
    events: [
      { type: 'delta', text: `a${EURO}` },
      { type: 'end', ok: true, n: null },
    ],
    target: remote,
  });
  // keys: rev events type text type ok n target; values: delta a€ end
  const expected =
    utf8Bytes('rev') +
    utf8Bytes('events') +
    2 * utf8Bytes('type') +
    utf8Bytes('text') +
    utf8Bytes('ok') +
    utf8Bytes('n') +
    utf8Bytes('target') +
    utf8Bytes('delta') +
    utf8Bytes(`a${EURO}`) +
    utf8Bytes('end');
  t.is(messageBytes(message), expected);
  t.is(messageBytes('x'), 1);
  t.is(messageBytes(42), 0);
  t.is(messageBytes(remote), 0);
  t.is(messageBytes(harden(Error('boom'))), utf8Bytes('Error') + 4);
  // A sender may measure before hardening.
  t.is(messageBytes({ k: [SMILE] }), 1 + 4);
  // A deep tree does not exhaust the stack.
  /** @type {any} */
  let deep = 'leaf';
  for (let i = 0; i < 20_000; i += 1) deep = [deep];
  t.is(messageBytes(deep), 4);
});

test('fitsFrame takes the estimate first and measures exactly only when over', t => {
  t.true(fitsFrame(harden({ text: 'a'.repeat(8000) })));
  // Estimate 3 x 20,004 is over the frame; the exact count is not.
  t.true(fitsFrame(harden({ text: 'a'.repeat(20_000) })));
  t.false(fitsFrame(harden({ text: 'a'.repeat(limits.frameBytes) })));
  t.true(fitsFrame(harden({ t: 'a'.repeat(limits.frameBytes - 1) })));
  t.false(fitsFrame(harden({ t: EURO.repeat(8192) })));
  t.true(fitsFrame(harden({ t: EURO.repeat(8191) })));
  t.true(fitsFrame(harden(['abc']), 3));
  t.false(fitsFrame(harden(['abcd']), 3));
  t.false(fitsFrame(harden([SMILE]), 3));
  t.true(fitsFrame(harden([SMILE]), 4));
});

test('cutText keeps the longest prefix within the bytes, never splitting a pair', t => {
  t.is(cutText('hello', 10), 'hello');
  t.is(cutText('hello', 3), 'hel');
  t.is(cutText('hello', 0), '');
  t.is(cutText(`ab${EURO}`, 4), 'ab');
  t.is(cutText(`ab${EURO}`, 5), `ab${EURO}`);
  t.is(cutText(`a${SMILE}`, 4), 'a');
  t.is(cutText(`a${SMILE}b`, 5), `a${SMILE}`);
  t.is(cutText(`${SMILE}${SMILE}`, 7), SMILE);
  t.throws(() => cutText('x', -1), { message: /non-negative integer/ });
  for (const seed of [3, 4, 5, 6]) {
    const text = mixedText(2000, seed);
    for (const max of [0, 1, 2, 3, 4, 5, 7, 100, 1001, 4096, 9000]) {
      const cut = cutText(text, max);
      t.true(text.startsWith(cut));
      t.true(utf8Bytes(cut) <= max, `seed ${seed} max ${max}`);
      t.false(splitBetween(cut, text.slice(cut.length)));
      if (cut.length < text.length) {
        // Maximal: the next code point would not fit.
        const nextUnits =
          isHigh(text.charCodeAt(cut.length)) &&
          isLow(text.charCodeAt(cut.length + 1))
            ? 2
            : 1;
        t.true(
          utf8Bytes(text.slice(0, cut.length + nextUnits)) > max,
          `maximal: seed ${seed} max ${max}`,
        );
      }
    }
  }
});

test('chunkText pieces are within the bytes, cut between code points, and join to the text', t => {
  t.deepEqual(chunkText(''), []);
  t.deepEqual(chunkText('abc', 4), ['abc']);
  t.deepEqual(chunkText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  t.deepEqual(chunkText(SMILE.repeat(3), 4), [SMILE, SMILE, SMILE]);
  t.deepEqual(chunkText(SMILE.repeat(3), 7), [SMILE, SMILE, SMILE]);
  t.deepEqual(chunkText(`a${SMILE}`, 4), ['a', SMILE]);
  t.throws(() => chunkText('abc', 3), { message: /at least 4/ });
  for (const seed of [7, 8, 9]) {
    const text = mixedText(30_000, seed);
    for (const max of [4, 5, 6, 1000, limits.frameBytes, 8192]) {
      const pieces = chunkText(text, max);
      t.is(pieces.join(''), text);
      t.true(Object.isFrozen(pieces));
      for (const [index, piece] of pieces.entries()) {
        t.true(piece.length > 0);
        t.true(utf8Bytes(piece) <= max);
        if (index + 1 < pieces.length) {
          t.false(
            splitBetween(piece, pieces[index + 1]),
            `pair split at piece ${index} (seed ${seed}, max ${max})`,
          );
        }
      }
    }
  }
  // An ASCII program source is cut in frameBytes-unit pieces.
  const ascii = 'x'.repeat(200_000);
  const asciiPieces = chunkText(ascii);
  t.is(asciiPieces.length, Math.ceil(200_000 / limits.frameBytes));
  t.is(asciiPieces[0].length, limits.frameBytes);
  // A pair straddling the frame boundary moves whole into the next piece.
  const straddle = `${'x'.repeat(limits.frameBytes - 1)}${SMILE}y`;
  t.deepEqual(chunkText(straddle), [
    'x'.repeat(limits.frameBytes - 1),
    `${SMILE}y`,
  ]);
});

test('previewText is a unit prefix that never splits a pair', t => {
  t.is(previewText('hello', 10), 'hello');
  t.is(previewText('hello', 2), 'he');
  t.is(previewText(`a${SMILE}`, 2), 'a');
  t.is(previewText(`a${SMILE}`, 3), `a${SMILE}`);
  t.is(previewText(`${HIGH}a`, 1), HIGH);
  t.throws(() => previewText('x', 1.5));
});

/**
 * Fae session/tool-output.js boundToolOutput at 1315bef86, without the image
 * exemption: the reference the port must equal.
 * @param {string} text
 * @param {number} limit
 */
const faeBoundToolOutput = (text, limit) => {
  if (text.length <= limit) return text;
  const marker = `\n[Tool output truncated from ${text.length} characters. Only a prefix is shown; use filtering or pagination for more.]`;
  let end = limit - marker.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${marker}`;
};

test('boundToolOutput is R4-46: unchanged within the limit, else a prefix and the marker within it', t => {
  t.is(limits.toolOutputUnits, 32_768);
  t.is(boundToolOutput('short'), 'short');
  const exact = 'x'.repeat(limits.toolOutputUnits);
  t.is(boundToolOutput(exact), exact);
  const long = 'y'.repeat(300_000);
  const bounded = boundToolOutput(long);
  t.is(bounded.length, limits.toolOutputUnits);
  t.true(bounded.endsWith(textOf.truncationMarker(300_000)));
  t.true(
    bounded.endsWith(
      '\n[Tool output truncated from 300000 characters. Only a prefix is shown; use filtering or pagination for more.]',
    ),
  );
  t.is(bounded, faeBoundToolOutput(long, limits.toolOutputUnits));
  // A pair at the boundary is not split, as in Fae.
  for (let shift = 0; shift < 4; shift += 1) {
    const text = `${'z'.repeat(shift)}${SMILE.repeat(20_000)}`;
    const cut = boundToolOutput(text);
    t.is(cut, faeBoundToolOutput(text, limits.toolOutputUnits));
    t.true(cut.length <= limits.toolOutputUnits);
    const prefix = cut.slice(
      0,
      cut.length - textOf.truncationMarker(text.length).length,
    );
    t.false(isHigh(prefix.charCodeAt(prefix.length - 1)));
  }
  // A limit shorter than the marker cuts the marker too, within the limit.
  t.is(boundToolOutput('w'.repeat(50), 20).length, 20);
  t.is(boundToolOutput('w'.repeat(50), 0), '');
});

test('splitBatches groups events in order within the count and byte bounds', t => {
  const events = Array.from({ length: 150 }, (_, index) =>
    harden({ type: 'tool_call', id: `c${index}`, args: '{}' }),
  );
  const byCount = splitBatches(events);
  t.deepEqual(
    byCount.map(group => group.length),
    [64, 64, 22],
  );
  t.deepEqual(byCount.flat(), events);

  const big = Array.from({ length: 10 }, (_, index) =>
    harden({ type: 'final', text: `${index}`.repeat(5000) }),
  );
  const byBytes = splitBatches(big, { maxBytes: limits.frameBytes });
  t.deepEqual(byBytes.flat(), big);
  for (const group of byBytes) {
    t.true(group.length >= 1);
    t.true(messageBytes(group) <= limits.frameBytes);
  }
  // 4 events of about 5,014 bytes fit one frame (estimates alone would put 1).
  t.is(byBytes[0].length, 4);

  // An event alone over the bound is its own group.
  const huge = harden({ type: 'final', text: 'h'.repeat(30_000) });
  const small = harden({ type: 'end' });
  t.deepEqual(splitBatches([small, huge, small]), [[small], [huge], [small]]);
  t.deepEqual(splitBatches([]), []);
  t.throws(() => splitBatches(events, { maxEvents: 0 }));
});

test('isRetiredBreak recognises the hub text and nothing else', t => {
  t.is(RETIRED_TEXT, 'the target session has been retired');
  t.true(
    isRetiredBreak(Error('ocapn hub: the target session has been retired')),
  );
  t.true(isRetiredBreak(harden({ message: `x ${RETIRED_TEXT} y` })));
  t.false(isRetiredBreak(Error('the target session has been suspended')));
  t.false(isRetiredBreak(Error('tool failed')));
  t.false(isRetiredBreak(RETIRED_TEXT));
  t.false(isRetiredBreak(null));
  t.false(isRetiredBreak(undefined));
  t.false(isRetiredBreak(harden({ message: 42 })));
  const throwing = {
    get message() {
      throw Error('getter');
    },
  };
  t.false(isRetiredBreak(throwing));
});
