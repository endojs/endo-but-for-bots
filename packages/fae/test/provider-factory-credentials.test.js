// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { make } from '../llm-provider-factory.js';

for (const token of ['test-import-only', '']) {
  test(`provider form ${token ? 'refuses a failed Secret import' : 'permits tokenless local configuration'}`, async t => {
    t.timeout(5000);
    const inbox = makeBufferedReader();
    t.teardown(() => inbox.close());
    const stored = [];
    let finish;
    const replied = new Promise(resolve => {
      finish = resolve;
    });
    const host = Far('ProviderHost', {
      has: () => false,
      lookup: () => {
        throw Error('Secrets unavailable');
      },
      storeValue: (value, name) => {
        stored.push({ value, name });
      },
    });
    const powers = Far('ProviderFactoryPowers', {
      form: () => undefined,
      lookup: () => host,
      locate: () => 'self',
      listMessages: () =>
        harden([{ from: 'self', type: 'form', messageId: 'form' }]),
      followMessages: () => inbox.reader,
      lookupById: () =>
        harden({
          name: 'local',
          host: 'http://localhost:11434',
          model: 'test',
          authToken: token,
        }),
      reply: (_number, strings) => {
        finish(strings);
      },
    });
    make(powers, undefined);
    inbox.push(
      harden({ type: 'value', replyTo: 'form', valueId: 'value', number: 1n }),
    );
    const reply = await replied;
    if (token) {
      t.deepEqual(stored, []);
      t.regex(reply[0], /Error creating provider: Secrets unavailable/);
      t.false(reply[0].includes(token));
    } else {
      t.deepEqual(stored, [
        {
          name: 'local',
          value: { host: 'http://localhost:11434', model: 'test' },
        },
      ]);
    }
  });
}
