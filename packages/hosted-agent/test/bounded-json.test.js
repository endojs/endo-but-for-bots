// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { boundedJson } from '../src/bounded-json.js';

test('default oversized input cancels without awaiting the cancellation', async t => {
  t.timeout(5000);
  let release = () => {};
  const cancellation = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(release);
  let cancellations = 0;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
      },
      cancel() {
        cancellations += 1;
        return cancellation;
      },
    }),
  );
  await t.throwsAsync(boundedJson(response, 2, 'Probe'), {
    message: 'Probe too large',
  });
  t.is(cancellations, 1);
  release();
  await cancellation;
});

test('a supplied body reader remains its caller’s cleanup responsibility', async t => {
  const response = new Response(Uint8Array.of(1, 2, 3));
  const reader = response.body?.getReader();
  if (!reader) throw Error('Expected synthetic body reader');
  let cancellations = 0;
  const cancel = reader.cancel.bind(reader);
  reader.cancel = async () => {
    cancellations += 1;
    await cancel();
  };
  t.teardown(() => (cancellations === 0 ? reader.cancel() : undefined));
  await t.throwsAsync(boundedJson(response, 2, 'Probe', reader), {
    message: 'Probe too large',
  });
  t.is(cancellations, 0);
  await reader.cancel();
  t.is(cancellations, 1);
});

test('a supplied reader is used without reacquiring the locked response body', async t => {
  const response = Response.json({ accepted: true });
  const reader = response.body?.getReader();
  if (!reader) throw Error('Expected synthetic body reader');
  t.teardown(() => reader.cancel());
  t.true(response.body?.locked);
  t.deepEqual(await boundedJson(response, 64, 'Probe', reader), {
    accepted: true,
  });
});

/** @type {[string, Uint8Array][]} */
const malformedReplies = [
  ['invalid JSON', new TextEncoder().encode('PRIVATE-RESPONSE')],
  ['invalid UTF-8', Uint8Array.of(0xc3, 0x28)],
  ['incomplete UTF-8', Uint8Array.of(0xc3)],
];
for (const [name, bytes] of malformedReplies) {
  test(`default ${name} remains a sanitized parser failure`, async t => {
    await t.throwsAsync(boundedJson(new Response(bytes), 64, 'Probe'), {
      message: 'Probe was not JSON',
    });
  });
}
