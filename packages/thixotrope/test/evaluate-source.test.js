// @ts-check
import test from '@endo/ses-ava/test.js';

import {
  STAGING_CHUNK_CHARS,
  STAGING_FRAME_BYTES,
  evaluateSource,
} from '../src/core/evaluate-source.js';

/**
 * A worker that records each staged chunk and answers the final evaluation
 * with the reassembled source.
 */
const makeRecordingWorker = () => {
  /** @type {string[]} */
  const chunks = [];
  let calls = 0;
  const worker = {
    /**
     * @param {string} source
     * @param {Record<string, any>} [endowments]
     */
    evaluate: async (source, endowments) => {
      calls += 1;
      if (endowments && typeof endowments.chunk === 'string') {
        chunks.push(endowments.chunk);
        return true;
      }
      if (source.includes('.join(')) return chunks.join('');
      return true;
    },
  };
  return { worker, chunks, calls: () => calls };
};

/** @param {string} chunk */
const endsInHighSurrogate = chunk => {
  const last = chunk.charCodeAt(chunk.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
};

test('the staging chunk is a third of the frame size, so a chunk fits a frame in UTF-8', t => {
  t.is(STAGING_FRAME_BYTES, 24_576);
  t.is(STAGING_CHUNK_CHARS, STAGING_FRAME_BYTES / 3);
  t.true(Number.isSafeInteger(STAGING_CHUNK_CHARS));
});

test('an ASCII source goes in full chunks and arrives whole', async t => {
  const { worker, chunks, calls } = makeRecordingWorker();
  const source = 'x'.repeat(3 * STAGING_CHUNK_CHARS + 17);
  const result = await evaluateSource(worker, source, {});
  t.is(result, source);
  t.deepEqual(
    chunks.map(c => c.length),
    [STAGING_CHUNK_CHARS, STAGING_CHUNK_CHARS, STAGING_CHUNK_CHARS, 17],
  );
  // Reset, four chunks, the evaluation.
  t.is(calls(), 6);
});

test('no chunk ends between the halves of a surrogate pair', async t => {
  const { worker, chunks } = makeRecordingWorker();
  // One leading unit puts every chunk boundary inside a pair, then a run
  // of pairs alone.
  const source = `a${'\u{1f600}'.repeat(2 * STAGING_CHUNK_CHARS)}`;
  const result = await evaluateSource(worker, source, {});
  t.is(result, source);
  t.true(chunks.length > 4);
  for (const chunk of chunks) {
    t.true(chunk.length <= STAGING_CHUNK_CHARS);
    t.false(endsInHighSurrogate(chunk));
  }
});

test('the worst case for UTF-8, three-byte characters, fills a frame and no more', async t => {
  const { worker, chunks } = makeRecordingWorker();
  const source = '€'.repeat(2 * STAGING_CHUNK_CHARS + 1);
  await evaluateSource(worker, source, {});
  const bytes = chunks.map(c => new TextEncoder().encode(c).length);
  t.deepEqual(bytes, [STAGING_FRAME_BYTES, STAGING_FRAME_BYTES, 3]);
});

test('the chunk size is an option, and must leave room for a surrogate pair', async t => {
  const { worker, chunks } = makeRecordingWorker();
  const source = 'abcdefg';
  const staged = await evaluateSource(worker, source, {}, { chunkChars: 3 });
  t.is(staged, source);
  t.deepEqual(chunks, ['abc', 'def', 'g']);
  for (const chunkChars of [0, 1, 2.5, NaN, Infinity]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => evaluateSource(worker, source, {}, { chunkChars }),
      { message: /chunkChars/ },
    );
  }
  // A two-unit chunk still moves through a run of pairs.
  const pairs = makeRecordingWorker();
  const astral = `a${'\u{1f600}'.repeat(4)}`;
  t.is(
    await evaluateSource(pairs.worker, astral, {}, { chunkChars: 2 }),
    astral,
  );
});
