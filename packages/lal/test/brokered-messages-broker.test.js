// @ts-check
// prefer-endo-primitives-exempt: wire fixtures exercise native fetch streams and AbortSignal.

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { makeAnthropicApiKeyIssuerFactory } from '@endo/hosted-agent/anthropic-api-key-issuer.js';
import { makeInferenceProviderRegistry } from '@endo/hosted-agent/inference-provider-registry.js';

import { makeBrokeredMessagesProvider } from '../providers/brokered-messages.js';

const CANARY = 'sk-ant-canary-5f1b9c';
const CANARY_BASE64 = Buffer.from(CANARY).toString('base64');

const completion = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 3 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 1 },
  },
  { type: 'message_stop' },
];

const sse = events =>
  new TextEncoder().encode(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  );

const sseResponse = body =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const eventually = async (t, predicate, title) => {
  await null;
  for (let turn = 0; turn < 500; turn += 1) {
    if (predicate()) {
      t.pass(title);
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  t.fail(title);
};

/**
 * The Lal adapter over a real registry grant and the real Anthropic issuer,
 * with only the network faked.
 *
 * @param {any} t
 * @param {(input: string, init: any) => Promise<Response> | Response} upstream
 */
const makeSubject = async (t, upstream) => {
  const secrets = new Map();
  let snapshot;
  const audited = [];
  let nextId = 0;
  const made = makeAnthropicApiKeyIssuerFactory({
    fetch: /** @type {typeof fetch} */ (
      /** @type {unknown} */ (async (input, init) => upstream(input, init))
    ),
    audit: event => audited.push(event),
  });
  t.teardown(() => made.dispose());
  const registry = await makeInferenceProviderRegistry({
    journal: {
      read: async () => snapshot,
      write: async value => {
        snapshot = value;
      },
    },
    secrets: {
      has: async name => secrets.has(name),
      provide: async (name, description, bytesBase64) => {
        const existing = secrets.get(name);
        if (existing !== undefined) return existing.blob;
        if (bytesBase64 === undefined) throw Error('key needed');
        const blob = Far('SecretBlob', {
          readBase64: async () => bytesBase64,
          getDescription: async () => description,
        });
        secrets.set(name, { blob, state: 'active' });
        return blob;
      },
      revoke: async name => {
        secrets.get(name).state = 'revoked';
      },
      state: async name => secrets.get(name)?.state || 'missing',
      listNames: async () => [...secrets.keys()],
    },
    makeIssuer: async ({ descriptor, secret }) =>
      harden({
        openEndpoint: spec =>
          made.factory.openEndpoint(
            harden({
              providerId: descriptor.providerId,
              kind: descriptor.kind,
              defaultModel: descriptor.defaultModel,
            }),
            secret,
            spec,
          ),
        dispose: () => made.factory.disposeProvider(descriptor.providerId),
      }),
    validateLimits: value => harden({ ...value }),
    randomId: () => `id-${`${(nextId += 1)}`.padStart(8, '0')}`,
    now: () => '2026-11-04T00:00:00.000Z',
    modelPrices: harden({
      'claude-test': { inputPerMillion: 1, outputPerMillion: 1 },
    }),
  });
  t.teardown(() => registry.close());
  const directory = registry.directoryFor('owner-alice');
  const created = await E(directory).create(
    harden({
      idempotencyKey: 'create-0000000001',
      displayName: 'Claude',
      kind: 'anthropic',
      defaultModel: 'claude-test',
      keyBase64: CANARY_BASE64,
    }),
  );
  const inference = await E(
    registry.useFor('owner-alice', created.providerId),
  ).grant(
    harden({
      grantId: 'grant-broker-1',
      ownerId: 'owner-alice',
      agentId: 'agent-lal',
      model: 'claude-test',
    }),
  );
  const provider = makeBrokeredMessagesProvider({
    inference,
    model: 'claude-test',
  });
  t.teardown(() => provider.dispose());
  return {
    audited,
    directory,
    provider,
    registry,
    providerId: created.providerId,
    getSnapshot: () => snapshot,
  };
};

const user = harden([{ role: 'user', content: 'hello' }]);

test('a completed turn through the broker settles reported usage and verifies the model', async t => {
  const requests = [];
  const subject = await makeSubject(t, (input, init) => {
    requests.push({ input, headers: init.headers });
    return sseResponse(sse(completion));
  });
  t.is(
    subject.registry.inspect().modelStates[subject.providerId].verification[
      'claude-test'
    ],
    'unverified',
  );
  await subject.provider.chat(user, []);
  t.is(requests.length, 1);
  t.is(requests[0].input, 'https://api.anthropic.com/v1/messages');
  t.is(requests[0].headers['x-api-key'], CANARY);
  await eventually(
    t,
    () =>
      subject.registry.inspect().modelStates[subject.providerId].verification[
        'claude-test'
      ] === 'verified',
    'the first successful turn verifies the model',
  );
  const { turns } = await E(subject.directory).getUsage();
  t.is(turns.length, 1);
  t.like(turns[0], {
    state: 'settled',
    disposition: 'reported',
    chargedTokens: 4,
  });
});

test('a harness abort cancels upstream, charges the reservation, and releases the slot', async t => {
  let signal;
  let cancelled = false;
  let first = true;
  const subject = await makeSubject(t, (_input, init) => {
    if (!first) return sseResponse(sse(completion));
    first = false;
    ({ signal } = init);
    return sseResponse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(sse(completion.slice(0, 2)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const controller = new AbortController();
  const pending = subject.provider.chat(user, [], controller.signal);
  await eventually(t, () => signal !== undefined, 'the turn reached upstream');
  // The agent's single slot is held while the stream is open.
  await t.throwsAsync(subject.provider.chat(user, []), {
    message: /inference-request-refused|agent-concurrency-exhausted/,
  });
  controller.abort(Error('harness aborted'));
  await t.throwsAsync(pending, { message: 'harness aborted' });
  await eventually(
    t,
    () => signal.aborted || cancelled,
    'the abort reached the upstream request',
  );
  let turns = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    ({ turns } = await E(subject.directory).getUsage());
    if (turns.length === 1 && turns[0].state === 'settled') break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  t.like(turns[0], { state: 'settled', disposition: 'estimated' });
  t.is(turns[0].chargedTokens, turns[0].reservedTokens);
  // The released slot admits the next turn.
  await subject.provider.chat(user, []);
});

for (const [status, mapped] of /** @type {Array<[number, string]>} */ ([
  [401, 'Anthropic authentication failed'],
  [429, 'Anthropic rate limit reached'],
])) {
  test(`an upstream ${status} through the broker releases the slot and leaves the model unverified`, async t => {
    let failing = true;
    const subject = await makeSubject(t, () =>
      failing
        ? new Response(`{"error":"bad key ${CANARY}"}`, {
            status,
            headers: { 'content-type': 'application/json' },
          })
        : sseResponse(sse(completion)),
    );
    const error = await t.throwsAsync(subject.provider.chat(user, []), {
      message: mapped,
    });
    t.false(String(error?.stack).includes(CANARY));
    const { refusals } = await E(subject.directory).getUsage();
    t.is(refusals.length, 1);
    await eventually(
      t,
      () =>
        Object.values(subject.registry.inspect().turns).every(
          turn => turn.state === 'settled',
        ),
      'the failed turn settles',
    );
    t.is(
      subject.registry.inspect().modelStates[subject.providerId].verification[
        'claude-test'
      ],
      'unverified',
    );
    failing = false;
    await subject.provider.chat(user, []);
  });
}

test('an upstream 404 through the broker refuses the turn as model-not-available', async t => {
  const subject = await makeSubject(
    t,
    () => new Response('{"error":"no such model"}', { status: 404 }),
  );
  await t.throwsAsync(subject.provider.chat(user, []), {
    message: /model-not-available/,
  });
  const { refusals } = await E(subject.directory).getUsage();
  t.true(refusals.some(row => row.reason === 'model-not-available'));
  t.is(
    subject.registry.inspect().modelStates[subject.providerId].verification[
      'claude-test'
    ],
    'unverified',
  );
});

test.serial(
  'no log, audit row, ledger row, or error carries the key',
  async t => {
    const logged = [];
    const originalConsole = globalThis.console;
    const capture = new Proxy(originalConsole, {
      get(target, name) {
        const value = target[name];
        if (typeof value !== 'function') return value;
        return (...values) => {
          logged.push(values);
          return value.apply(target, values);
        };
      },
    });
    globalThis.console = capture;
    t.teardown(() => {
      globalThis.console = originalConsole;
    });
    const statuses = [401, 429, 500, 200];
    const subject = await makeSubject(t, () => {
      const status = statuses.shift();
      if (status === 200) return sseResponse(sse(completion));
      return new Response(`{"error":"bad key ${CANARY}"}`, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    const errors = [];
    for (let turn = 0; turn < 3; turn += 1) {
      // eslint-disable-next-line no-await-in-loop
      await subject.provider.chat(user, []).catch(error => errors.push(error));
    }
    t.is(errors.length, 3);
    await subject.provider.chat(user, []);
    const usage = await E(subject.directory).getUsage();
    const surfaces = {
      logged: logged.map(values => values.map(String)),
      audited: subject.audited,
      usage,
      snapshot: subject.getSnapshot(),
      errors: errors.map(error => `${error.message}\n${error.stack}`),
    };
    for (const [name, surface] of Object.entries(surfaces)) {
      const text = JSON.stringify(surface, (_key, value) =>
        typeof value === 'bigint' ? `${value}` : value,
      );
      t.false(text.includes(CANARY), `${name} must not carry the key`);
      t.false(
        text.includes(CANARY_BASE64),
        `${name} must not carry the encoded key`,
      );
    }
  },
);
