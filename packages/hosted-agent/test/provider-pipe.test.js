// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { Far } from '@endo/far';
import { PassThrough } from 'node:stream';

import { makeProviderPipe } from '../src/provider-pipe.js';

test('private pipe transports capabilities and rejects outstanding calls on EOF', async t => {
  t.timeout(1000);
  const a = new PassThrough();
  const b = new PassThrough();
  const left = makeProviderPipe({
    input: a,
    output: b,
    bootstrap: Far('inference', {
      async echo(value) {
        return harden({ value });
      },
      async stalled() {
        return new Promise(() => {});
      },
    }),
  });
  const right = makeProviderPipe({ input: b, output: a, bootstrap: undefined });
  t.teardown(() => {
    left.close();
    right.close();
  });
  const endpoint = await right.getBootstrap();
  t.deepEqual(await E(endpoint).echo('hello'), { value: 'hello' });
  const pending = E(endpoint).stalled();
  const rejected = t.throwsAsync(pending);
  left.close();
  await right.closed;
  await rejected;
});

test('oversized private frame closes before decoding its payload', async t => {
  t.timeout(1000);
  const input = new PassThrough();
  const output = new PassThrough();
  const pipe = makeProviderPipe({
    input,
    output,
    bootstrap: undefined,
    maxFrameBytes: 64,
  });
  t.teardown(pipe.close);
  input.write('9999:');
  await pipe.closed;
  t.true(input.destroyed);
  t.true(output.destroyed);
});

test('application rejection preserves the private pipe for subsequent calls', async t => {
  t.timeout(1000);
  const a = new PassThrough();
  const b = new PassThrough();
  const left = makeProviderPipe({
    input: a,
    output: b,
    bootstrap: Far('inference', {
      reject() {
        throw Fail`Inference quota exhausted`;
      },
      echo(value) {
        return value;
      },
    }),
  });
  const right = makeProviderPipe({ input: b, output: a, bootstrap: undefined });
  t.teardown(() => {
    left.close();
    right.close();
  });
  const endpoint = await right.getBootstrap();
  await t.throwsAsync(E(endpoint).reject(), {
    message: /Inference quota exhausted/,
  });
  t.is(await E(endpoint).echo('still available'), 'still available');
  t.false(a.destroyed);
  t.false(b.destroyed);
});

test('CapTP protocol rejection still closes the private pipe', async t => {
  t.timeout(1000);
  const input = new PassThrough();
  const output = new PassThrough();
  const pipe = makeProviderPipe({ input, output, bootstrap: undefined });
  t.teardown(pipe.close);
  const payload = JSON.stringify({ type: 'NOT_A_CAPTP_MESSAGE' });
  input.write(`${payload.length}:${payload},`);
  await pipe.closed;
  t.true(input.destroyed);
  t.true(output.destroyed);
});
