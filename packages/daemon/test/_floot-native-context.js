// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

// Test-only imports: no daemon production dependency on Floot.
/* eslint-disable import/no-relative-packages */
import { makeStreamingAgent } from '../../floot/agent.js';
import { providePrivateTurnStorage } from '../../floot/src/private-turn-storage.js';
import { makeReplyChannel } from '../../floot/src/stream.js';
import { makeTurnJournal } from '../../floot/src/turn-journal.js';
/* eslint-enable import/no-relative-packages */

// Deliberately opaque synthetic data, not a claim of native signature validity.
const payload = JSON.stringify({
  signed: 'SYNTHETIC-SIGNATURE',
  redacted: 'SYNTHETIC-OPAQUE-CONTEXT',
  content: `${'Exact native bytes 😀 '.repeat(1500)}OPAQUE-END`,
});
const checkpoint = harden({
  kind: 'native-context',
  format: 'synthetic-native-v1',
  payload,
  context: [
    { kind: 'tool-call', id: 'effect', name: 'effect', args: '{}' },
    { kind: 'tool-result', id: 'effect', content: 'Effect happened once' },
    { kind: 'message', role: 'assistant', content: 'Seed native answer' },
  ],
});

/** @param {any} host */
export const make = async host => {
  const sessions = new Map();
  const provide = async (mode, seeding = false) => {
    if (sessions.has(mode)) return sessions.get(mode);
    const sessionId = `native-${mode}`;
    const storage = await providePrivateTurnStorage(host, sessionId);
    /** @type {{ agent: Awaited<ReturnType<typeof makeStreamingAgent>> | undefined, storage: typeof storage, calls: number, captured: readonly any[] | undefined }} */
    const state = { agent: undefined, storage, calls: 0, captured: undefined };
    state.agent = await makeStreamingAgent(
      host,
      undefined,
      {
        kind: 'hosted',
        provideHostedClient: tools =>
          harden({
            async send(_prompt, options) {
              await null;
              state.calls += 1;
              state.captured = options.transcript;
              const stream = makeBufferedReader();
              if (seeding) {
                stream.push({
                  type: 'tool-call',
                  id: 'effect',
                  name: 'effect',
                  args: '{}',
                });
                const result = await tools.execute('effect', {});
                stream.push({ type: 'tool-result', id: 'effect', result });
                stream.push({ type: 'text-delta', text: 'Seed native answer' });
                if (mode !== 'missing')
                  stream.push({ type: 'native-context', checkpoint });
                stream.push(
                  mode === 'complete'
                    ? { type: 'end' }
                    : { type: 'abort', reason: 'Synthetic native failure' },
                );
              } else {
                stream.push({ type: 'text-delta', text: 'Recall only' });
                stream.push({ type: 'end' });
              }
              return stream.reader;
            },
            async terminate() {
              // Mock backend owns no native process or sandbox.
            },
          }),
      },
      'Test',
      {
        journalPowers: storage,
        ...(seeding ? { nativeContextFormat: checkpoint.format } : {}),
        extraTools: new Map([
          [
            'effect',
            harden({
              schema: () =>
                harden({
                  type: 'function',
                  function: {
                    name: 'effect',
                    description: 'One durable test effect',
                    parameters: {
                      type: 'object',
                      properties: {},
                      required: [],
                    },
                  },
                }),
              execute: async () => {
                await null;
                const proof = `${sessionId}-effect-proof`;
                if (await E(host).has(proof)) throw Error('Effect repeated');
                await E(host).storeValue(harden({ executions: 1 }), proof);
                return 'Effect happened once';
              },
              help: () => 'One test effect',
            }),
          ],
        ]),
      },
    );
    sessions.set(mode, state);
    return state;
  };
  return Far('NativeContextRestartFixture', {
    expected: () => checkpoint,
    seed: async mode => {
      const { agent } = await provide(mode, true);
      await agent.converse('Seed once', makeReplyChannel().writer);
    },
    inspect: async mode => {
      const state = await provide(mode);
      return harden({
        calls: state.calls,
        transcript: await state.agent.getTranscript(),
        turns: await state.agent.getTurns(),
        history: await state.agent.getHistory(),
      });
    },
    recall: async mode => {
      const state = await provide(mode);
      await state.agent.converse(
        'Recall without repeating effects',
        makeReplyChannel().writer,
      );
      return harden(state.captured);
    },
    archive: async mode => {
      const previous = sessions.get(mode);
      await previous.agent.shutdown();
      await E(previous.storage).close();
      sessions.delete(mode);
      const storage = await providePrivateTurnStorage(host, `native-${mode}`);
      try {
        const journal = makeTurnJournal(storage);
        for (let index = 0; index < 290; index += 1) {
          // Empty sealed turns exercise the existing archival threshold; no
          // synthetic backend calls or new effects are performed here.
          // eslint-disable-next-line no-await-in-loop
          const turn = await journal.begin({
            input: 'Archive padding',
            backendId: 'test',
            modelId: 'test',
          });
          // eslint-disable-next-line no-await-in-loop
          await journal.completeTranscript(turn, '0');
          // eslint-disable-next-line no-await-in-loop
          await journal.append(turn, { type: 'finish', state: 'completed' });
        }
        const view = await journal.readView();
        return view;
      } finally {
        await E(storage).close();
      }
    },
    shutdown: async () => {
      await Promise.all(
        [...sessions.values()].map(async state => {
          await state.agent.shutdown();
          await E(state.storage).close();
        }),
      );
    },
  });
};
harden(make);
