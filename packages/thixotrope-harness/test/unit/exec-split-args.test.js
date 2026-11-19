// @ts-check
// The exec vat's `splitArgs` inspector operation (designs/m9-interfaces.md
// D-M9-14, seam X1): staged tool arguments read in pages, parsed, long
// string values staged again through the session's writers, the residual
// JSON with placeholders. The module directly over fake adapter objects for
// the rules and bounds; the exec program from its bundle alone (a Node
// Compartment with only the guest prelude) for the dispatch entry. Every
// answer is checked against the real `InspectOutcome` guard.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import { guestPrelude } from '../../scripts/guest-prelude.js';
import { harnessRoot } from '../_helpers.js';
/* eslint-disable import/no-relative-packages */
import { shapes, textOf } from '../../guest/lib/guards/base.js';
import { limits } from '../../guest/lib/limits.js';
import { previewText, utf8Bytes } from '../../guest/lib/bounded.js';
import {
  SPLIT_NO_ARGS_TEXT,
  SPLIT_PLACEHOLDER_PREFIX,
  SPLIT_SOURCE_BYTES,
  splitArgs,
  splitPlaceholder,
  splitResidualText,
  splitStringTooLongText,
  splitTooManyText,
} from '../../guest/exec/split-args.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

/** @param {unknown} outcome */
const matchesOutcome = outcome =>
  /** @type {any} */ (globalThis).matches(outcome, shapes.InspectOutcome);

/**
 * A fake blob store: the session's writers (counting opens, pieces and
 * aborts) and a Content that pages staged blobs by UTF-16 offset.
 * @param {{ failAppend?: unknown, failRead?: unknown }} [faults]
 */
const makeBlobStore = (faults = {}) => {
  /** @type {Map<any, string>} */
  const texts = new Map();
  const counts = { opens: 0, pieces: 0, aborts: 0, reads: 0, largestPiece: 0 };
  /** @param {string} text */
  const stage = text => {
    const blob = Far('Blob', {});
    texts.set(blob, text);
    return harden({
      blob,
      preview: previewText(text, 256),
      bytes: utf8Bytes(text),
    });
  };
  const writers = Far('BlobWriters', {
    open: () => {
      counts.opens += 1;
      /** @type {string[]} */
      const pieces = [];
      return Far('BlobWriter', {
        /** @param {string} piece */
        append: piece => {
          if (faults.failAppend !== undefined) throw faults.failAppend;
          counts.pieces += 1;
          counts.largestPiece = Math.max(counts.largestPiece, utf8Bytes(piece));
          pieces.push(piece);
        },
        close: () => stage(pieces.join('')),
        abort: () => {
          counts.aborts += 1;
        },
      });
    },
  });
  const content = Far('Content', {
    /**
     * @param {any} blob
     * @param {{ offset: number, maxBytes: number }} range
     */
    read: (blob, { offset, maxBytes }) => {
      counts.reads += 1;
      if (faults.failRead !== undefined) throw faults.failRead;
      const text = /** @type {string} */ (texts.get(blob));
      const next = Math.min(text.length, offset + maxBytes);
      return harden({
        text: text.slice(offset, next),
        next,
        done: next === text.length,
      });
    },
  });
  /** @param {any} staged */
  const read = staged => /** @type {string} */ (texts.get(staged.blob));
  return { stage, writers, content, counts, read };
};

/**
 * Split `args` (staged unless `inline`) with a fresh store.
 * @param {string} argsText
 * @param {{ inline?: boolean, faults?: object }} [options]
 */
const split = async (argsText, { inline = false, faults } = {}) => {
  const store = makeBlobStore(faults);
  const args = inline ? argsText : store.stage(argsText);
  const outcome = await splitArgs(
    { args },
    { writers: store.writers, content: store.content },
  );
  return { outcome: /** @type {any} */ (outcome), store };
};

/**
 * The arguments back from a split: the residual parsed, every placeholder
 * string replaced by its staged text.
 * @param {any} outcome
 * @param {ReturnType<typeof makeBlobStore>} store
 */
const rejoin = (outcome, store) =>
  JSON.parse(outcome.split.json, (_key, value) => {
    if (
      typeof value !== 'string' ||
      !value.startsWith(SPLIT_PLACEHOLDER_PREFIX)
    )
      return value;
    const index = Number(value.slice(SPLIT_PLACEHOLDER_PREFIX.length));
    return store.read(outcome.split.staged[index]);
  });

test('short arguments come back unchanged with nothing staged', async t => {
  const argsText = '{ "name": "scout", "attachments": [{"name":"a"}] }';
  const { outcome, store } = await split(argsText);
  t.deepEqual(outcome, {
    status: 'split',
    split: { json: argsText, staged: [] },
  });
  t.true(matchesOutcome(outcome));
  t.is(store.counts.opens, 0);
  // Inline arguments are split the same way, unread.
  const inline = await split(argsText, { inline: true });
  t.is(inline.outcome.split.json, argsText);
  t.is(inline.store.counts.reads, 0);
});

test('long string values are staged in order; keys, numbers and white space keep their source', async t => {
  const long = 'x'.repeat(limits.splitStringUnits + 1);
  const other = `é中"q"\\${'y'.repeat(3000)}`;
  const key = 'k'.repeat(2000);
  const argsText = `{"name":"scout",\n  "task": ${JSON.stringify(long)}, "n": 1.0, "big": 12345678901234567890,
  "list": ["short", ${JSON.stringify(other)}], ${JSON.stringify(key)}: "v",
  "edge": ${JSON.stringify('z'.repeat(limits.splitStringUnits))}}`;
  const { outcome, store } = await split(argsText);
  t.is(outcome.status, 'split');
  t.true(matchesOutcome(outcome));
  const { json, staged } = outcome.split;
  t.is(staged.length, 2);
  t.is(store.read(staged[0]), long);
  t.is(store.read(staged[1]), other);
  t.is(staged[1].bytes, utf8Bytes(other));
  // Exactly the two literals replaced: the rest is the model's own text.
  t.is(
    json,
    argsText
      .replace(JSON.stringify(long), JSON.stringify(splitPlaceholder(0)))
      .replace(JSON.stringify(other), JSON.stringify(splitPlaceholder(1))),
  );
  t.true(json.includes('"n": 1.0, "big": 12345678901234567890'));
  t.true(json.includes(`${JSON.stringify(key)}: "v"`));
  t.deepEqual(rejoin(outcome, store), JSON.parse(argsText));
});

test('a value that begins with the placeholder prefix is staged, however it is escaped', async t => {
  const argsText = '{"a":"\\u0000s0","b":"\\u0000\\u0073x","c":"\\u0000t"}';
  const { outcome, store } = await split(argsText);
  t.is(outcome.status, 'split');
  const { json, staged } = outcome.split;
  t.is(staged.length, 2);
  t.is(store.read(staged[0]), `${SPLIT_PLACEHOLDER_PREFIX}0`);
  t.is(store.read(staged[1]), `${SPLIT_PLACEHOLDER_PREFIX}x`);
  t.is(json, '{"a":"\\u0000s0","b":"\\u0000s1","c":"\\u0000t"}');
  t.deepEqual(rejoin(outcome, store), JSON.parse(argsText));
});

test('a residual over inlineBytes stages more values, longest first, until it fits', async t => {
  const strings = Array.from({ length: 20 }, (_, i) =>
    String.fromCharCode(97 + i).repeat(800 + i),
  );
  const argsText = JSON.stringify({ recipient: 'user', strings });
  t.true(utf8Bytes(argsText) > limits.inlineBytes);
  const { outcome, store } = await split(argsText);
  t.is(outcome.status, 'split');
  t.true(matchesOutcome(outcome));
  const { json, staged } = outcome.split;
  t.true(utf8Bytes(json) <= limits.inlineBytes, `${utf8Bytes(json)}`);
  const count = /** @type {number} */ (staged.length);
  t.true(count <= limits.splitStagedStrings, `${count}`);
  // The longest (latest) strings went first; placeholders in text order.
  t.is(store.read(staged.at(-1)), strings[19]);
  t.true(json.includes(JSON.stringify(strings[0])));
  t.deepEqual(rejoin(outcome, store), JSON.parse(argsText));
});

test('refusals: too many long strings, a residual that cannot fit, a string over mailBodyUnits; nothing staged', async t => {
  const limit = limits.splitStagedStrings;
  const many = JSON.stringify({
    strings: Array.from({ length: limit + 1 }, () => 'm'.repeat(1100)),
  });
  let { outcome, store } = await split(many);
  t.deepEqual(outcome, {
    status: 'failed',
    text: splitTooManyText(limit + 1, limit),
  });
  t.is(store.counts.opens, 0);

  const wide = JSON.stringify({
    strings: Array.from({ length: limits.mailParts }, () => 'w'.repeat(1000)),
  });
  ({ outcome, store } = await split(wide));
  t.deepEqual(outcome, {
    status: 'failed',
    text: splitResidualText(limits.inlineBytes),
  });
  t.is(store.counts.opens, 0);

  const tooLong = JSON.stringify({
    strings: 'b'.repeat(limits.mailBodyUnits + 1),
  });
  ({ outcome, store } = await split(tooLong));
  t.deepEqual(outcome, {
    status: 'failed',
    text: splitStringTooLongText(
      limits.mailBodyUnits + 1,
      limits.mailBodyUnits,
    ),
  });
  t.is(store.counts.opens, 0);
  t.true(matchesOutcome(outcome));
});

test('a 1 MiB task is read in pages and staged again in pieces', async t => {
  const task = 't'.repeat(limits.taskUnits);
  const argsText = JSON.stringify({ name: 'scout', task, timeoutSeconds: 60 });
  const { outcome, store } = await split(argsText);
  t.true(matchesOutcome(outcome));
  t.is(
    outcome.split.json,
    JSON.stringify({
      name: 'scout',
      task: splitPlaceholder(0),
      timeoutSeconds: 60,
    }),
  );
  t.is(store.read(outcome.split.staged[0]), task);
  t.is(
    store.counts.reads,
    Math.ceil(utf8Bytes(argsText) / limits.blobPageBytes),
  );
  t.true(store.counts.largestPiece <= limits.blobPieceBytes);
});

test('unreadable, oversized or malformed arguments fail; an exhausted name table answers exhausted', async t => {
  const none = await splitArgs({}, { writers: undefined });
  t.deepEqual(none, {
    status: 'failed',
    text: SPLIT_NO_ARGS_TEXT,
  });
  const store = makeBlobStore();
  const huge = harden({
    blob: Far('Blob', {}),
    preview: 'p',
    bytes: SPLIT_SOURCE_BYTES + 1,
  });
  t.deepEqual(
    await splitArgs(
      { args: huge },
      { writers: store.writers, content: store.content },
    ),
    {
      status: 'failed',
      text: textOf.execSourceTooLarge(
        SPLIT_SOURCE_BYTES + 1,
        SPLIT_SOURCE_BYTES,
      ),
    },
  );
  t.is(store.counts.reads, 0);
  t.deepEqual(
    await splitArgs({ args: store.stage('{"a":') }, { writers: store.writers }),
    { status: 'failed', text: SPLIT_NO_ARGS_TEXT },
  );

  let { outcome } = await split('{"a": tru}');
  t.is(outcome.status, 'failed');
  t.true(outcome.text.startsWith('could not parse tool arguments as JSON ('));

  ({ outcome } = await split('{}', { faults: { failRead: Error('gone') } }));
  t.deepEqual(outcome, { status: 'failed', text: 'gone' });

  const exhausted = RangeError('property key space exhausted');
  await t.throwsAsync(split('{}', { faults: { failRead: exhausted } }), {
    message: 'property key space exhausted',
  });

  const long = JSON.stringify({ task: 'a'.repeat(5000) });
  const failing = await split(long, {
    faults: { failAppend: Error('disk full') },
  });
  ({ outcome } = failing);
  const store2 = failing.store;
  t.deepEqual(outcome, {
    status: 'failed',
    text: textOf.stagingFailed('disk full'),
  });
  t.is(store2.counts.aborts, 1);
});

test('the bundled exec program dispatches splitArgs; exhaustion answers exhausted there', async t => {
  const bundle = await bundleGuest(
    path.join(harnessRoot, 'guest', 'exec', 'main.js'),
  );
  t.true(bundle.modules.includes('exec/split-args.js'));
  t.log(JSON.stringify({ metric: 'exec.program', bytes: bundle.bytes }));
  t.true(/** @type {number} */ (bundle.bytes) <= 120_000, `${bundle.bytes}`);
  const namespace = new Compartment({
    globals: harden({ ...guestPrelude, TextEncoder }),
    __options__: true,
  }).evaluate(bundle.source);
  const scope = namespace.makeExecScope();
  const store = makeBlobStore();
  const task = 'q'.repeat(4000);
  const outcome = await E(scope).inspect(
    harden({
      op: 'splitArgs',
      target: store.writers,
      writers: store.writers,
      content: store.content,
      args: store.stage(JSON.stringify({ name: 'scout', task })),
    }),
  );
  t.true(matchesOutcome(outcome));
  t.is(
    outcome.split.json,
    `{"name":"scout","task":${JSON.stringify(splitPlaceholder(0))}}`,
  );
  t.is(store.read(outcome.split.staged[0]), task);

  const flooded = makeBlobStore({
    failRead: RangeError('property key space exhausted'),
  });
  t.deepEqual(
    await E(scope).inspect(
      harden({
        op: 'splitArgs',
        target: flooded.writers,
        writers: flooded.writers,
        content: flooded.content,
        args: flooded.stage('{}'),
      }),
    ),
    { status: 'exhausted' },
  );
});
