// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { PARSE_ERROR } from '@endo/agent-tools/adapters/mcp.js';

import { serveStdio } from '../src/stdio.js';

/**
 * Feed `chunks` to `serveStdio` and collect the frames it dispatches, echoing
 * each as its own reply.
 *
 * @param {Array<Uint8Array | string>} chunks
 */
const frame = async chunks => {
  /** @type {string[]} */
  const handled = [];
  /** @type {string[]} */
  const written = [];
  let eofCount = 0;
  await serveStdio({
    input: (async function* input() {
      yield* chunks;
    })(),
    writeLine: line => written.push(line),
    handleLine: async line => {
      handled.push(line);
      return line;
    },
    onEof: () => {
      eofCount += 1;
    },
  });
  return { handled, written, eofCount };
};

const encoder = new TextEncoder();

test('a multi-byte character split across chunks is reassembled', async t => {
  const bytes = encoder.encode('{"x":"😀漢"}\n');
  for (let cut = 1; cut < bytes.length; cut += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { handled } = await frame([bytes.slice(0, cut), bytes.slice(cut)]);
    t.deepEqual(handled, ['{"x":"😀漢"}'], `cut at ${cut}`);
  }
});

test('one chunk may carry zero, one, or several frames', async t => {
  t.deepEqual(await frame(['{"a":1']).then(r => r.handled), ['{"a":1']);
  t.deepEqual((await frame(['1\n2\n3\n'])).handled, ['1', '2', '3']);
  t.deepEqual((await frame(['1', '\n2', '', '\n'])).handled, ['1', '2']);
});

test('the final frame needs no trailing newline', async t => {
  t.deepEqual((await frame(['1\n2'])).handled, ['1', '2']);
  t.deepEqual((await frame([encoder.encode('3')])).handled, ['3']);
});

test('CRLF is tolerated; a bare CR, U+2028, and U+2029 never split', async t => {
  t.deepEqual((await frame(['1\r\n2\r\n'])).handled, ['1', '2']);
  t.deepEqual((await frame(['{"a":\r1}\n'])).handled, ['{"a":\r1}']);
  const separated = `"a${'\u2028'}b${'\u2029'}c"`;
  t.deepEqual((await frame([`${separated}\n`])).handled, [separated]);
});

test('blank and whitespace-only lines are not frames', async t => {
  const { handled, written, eofCount } = await frame(['\n  \n\t\r\n1\n']);
  t.deepEqual(handled, ['1']);
  t.deepEqual(written, ['1']);
  t.is(eofCount, 1);
});

test('a rejected handleLine is reported, and serving continues', async t => {
  /** @type {unknown[]} */
  const errors = [];
  /** @type {string[]} */
  const written = [];
  await serveStdio({
    input: (async function* input() {
      yield 'bad\ngood\n';
    })(),
    writeLine: line => written.push(line),
    handleLine: async line => {
      if (line === 'bad') throw Error('handler failed');
      return line;
    },
    onError: error => errors.push(error),
  });
  t.deepEqual(written, ['good']);
  t.is(errors.length, 1);
});

test('a frame longer than maxFrameLength is refused unread', async t => {
  /** @type {string[]} */
  const handled = [];
  /** @type {string[]} */
  const written = [];
  await serveStdio({
    input: (async function* input() {
      // One refused frame split over three chunks, then one refused whole.
      yield '12345';
      yield '6789';
      yield '0abc\n12\n';
      yield '1234567890\n3';
    })(),
    writeLine: line => written.push(line),
    handleLine: async line => {
      handled.push(line);
      return line;
    },
    maxFrameLength: 8,
  });
  t.deepEqual(handled, ['12', '3']);
  const refusals = written.filter(line => line.startsWith('{'));
  t.is(refusals.length, 2);
  for (const refusal of refusals) {
    const { id, error } = JSON.parse(refusal);
    t.is(id, null);
    t.is(error.code, PARSE_ERROR);
  }
});
