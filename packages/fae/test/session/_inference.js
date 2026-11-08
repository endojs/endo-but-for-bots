// @ts-check
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';

/**
 * A direct Responses endpoint with deterministic replies. The real provider
 * performs message translation, tool dispatch, and cancellation.
 * @param {(body: any, sessionId: string) => any} answer
 * @param {() => void} [onOpen]
 */
export const makeTestInference = (answer, onOpen = () => {}) => {
  const catalog = Far('TestCatalog', {
    modelCatalog: () =>
      harden({
        accounts: [
          {
            subscriptionId: 'auto',
            state: 'current',
            observedAt: 1,
            models: [
              {
                id: 'm',
                title: 'Model',
                description: '',
                default: true,
                defaultReasoningEffort: null,
                reasoningEfforts: [],
              },
            ],
          },
        ],
      }),
  });
  const subscription = Far('TestSubscription', {
    describe: () => harden({ models: ['m'] }),
    openEndpoint: ({ sessionId }) => {
      onOpen();
      return Far('TestEndpoint', {
        revoke: () => undefined,
        requestByteStream: async ({ body }) => {
          const value = await answer(JSON.parse(body), sessionId);
          const output =
            typeof value === 'string'
              ? [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: value }],
                  },
                ]
              : value;
          const event = JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', output },
          });
          const bytes = new TextEncoder().encode(`data: ${event}\n\n`);
          const chunks = [];
          for (let i = 0; i < bytes.length; i += 8192)
            chunks.push(bytes.subarray(i, i + 8192));
          const reader = bytesReaderFromIterator(chunks[Symbol.iterator]());
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader,
          });
        },
      });
    },
  });
  return harden({
    catalog,
    subscription,
    recipe: { kind: 'subscription-responses', subscription, model: 'm' },
  });
};
harden(makeTestInference);
