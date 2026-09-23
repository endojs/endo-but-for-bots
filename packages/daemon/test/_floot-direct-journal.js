// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

// Test-only cross-package fixture: a daemon -> Floot dependency would cycle
// back through Floot's daemon dependency. Private journal internals are not API.
/* eslint-disable import/no-relative-packages */
import { makeStreamingAgent } from '../../floot/agent.js';
import { providePrivateTurnStorage } from '../../floot/src/private-turn-storage.js';
import { makeReplyChannel } from '../../floot/src/stream.js';
/* eslint-enable import/no-relative-packages */

/**
 * Real daemon storage with local, inert provider replies.
 * @param {any} host
 */
export const make = async host => {
  const journal = await providePrivateTurnStorage(host, 'direct-journal');
  let mode = 'idle';
  let calls = 0;
  let lastContext;
  const provider = harden({
    async chatStream(context, _tools, onDelta) {
      calls += 1;
      lastContext = context;
      if (mode === 'seed' && calls === 1) {
        return harden({
          message: {
            role: 'assistant',
            content: `${'Long dialogue '.repeat(800)}PRESERVE-TAIL`,
            tool_calls: [
              {
                id: 'effect',
                type: 'function',
                function: {
                  name: 'effect',
                  arguments: '{}',
                },
              },
            ],
          },
        });
      }
      if (mode === 'seed') {
        onDelta('Partial reply after effect');
        throw Error('Injected provider disconnect');
      }
      if (mode !== 'recall')
        throw Error('Unexpected inference during reconstruction');
      return harden({
        message: { role: 'assistant', content: 'Recall complete' },
      });
    },
  });
  const agent = await makeStreamingAgent(
    host,
    undefined,
    { provider },
    'Test',
    {
      journalPowers: journal,
      extraTools: new Map([
        [
          'effect',
          harden({
            schema: () =>
              harden({
                type: 'function',
                function: {
                  name: 'effect',
                  description: 'Test durable effect',
                  parameters: { type: 'object', properties: {}, required: [] },
                },
              }),
            execute: async () => {
              if (await E(host).has('direct-effect-proof'))
                throw Error('Effect repeated');
              await E(host).storeValue(
                harden({ executions: 1 }),
                'direct-effect-proof',
              );
              return 'Effect happened once';
            },
            help: () => 'Test effect',
          }),
        ],
      ]),
    },
  );
  return Far('DirectJournalTest', {
    seed: async () => {
      mode = 'seed';
      await agent.converse('Perform one effect', makeReplyChannel().writer);
    },
    recall: async () => {
      mode = 'recall';
      await agent.converse('Recall, do not repeat', makeReplyChannel().writer);
      return harden(lastContext);
    },
    inspect: async () =>
      harden({
        transcript: await agent.getTranscript(),
        turns: await agent.getTurns(),
        calls,
      }),
    shutdown: async () => {
      await agent.shutdown();
      await E(journal).close();
    },
  });
};
harden(make);
