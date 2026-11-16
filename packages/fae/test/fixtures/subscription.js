// @ts-check
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';

// A formula-backed subscription: its capability survives loss of the test
// client's connection and the daemon, unlike a Far created in the test process.
export const make = () => {
  let opened = 0;
  let revoked = 0;
  return Far('DurableTestSubscription', {
    describe: () => harden({ models: ['test-luna'] }),
    openEndpoint: ({ sessionId }) => {
      opened += 1;
      let closed = false;
      return Far('TestResponsesEndpoint', {
        requestByteStream: request => {
          if (closed) throw Error('Endpoint already revoked');
          const body = JSON.parse(request.body);
          const userMessages = body.input
            .filter(message => message.role === 'user')
            .map(message => message.content);
          let terminalOutput;
          if (userMessages.at(-1)?.includes('terminal-fixture')) {
            const userIndex = body.input.findLastIndex(message => message.role === 'user');
            const number = /\[Inbox message #(\d+)\]/.exec(userMessages.at(-1))[1];
            const calls = body.input.slice(userIndex + 1).filter(item => item.type === 'function_call');
            const name = calls.some(item => item.name === 'reply') ? 'dismiss' : 'reply';
            terminalOutput = calls.some(item => item.name === 'dismiss')
              ? [{ type: 'reasoning', id: `terminal-${number}`, encrypted_content: 'retained-terminal-context' }]
              : [{
                type: 'function_call', id: `${name}-item-${number}`, call_id: `${name}-call-${number}`,
                name, status: 'completed',
                arguments: JSON.stringify({ messageNumber: Number(number), ...(name === 'reply' ? { strings: [JSON.stringify({ sessionId, userMessages })] } : {}) }),
              }];
          }
          const event = {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: terminalOutput ?? [{
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{
                  type: 'output_text',
                  text: JSON.stringify({ sessionId, userMessages }),
                }],
              }],
            },
          };
          const bytes = new TextEncoder().encode(
            `data: ${JSON.stringify(event)}\n\n`,
          );
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator((function* chunks() {
              for (let offset = 0; offset < bytes.length; offset += 17) {
                yield bytes.slice(offset, offset + 17);
              }
            })()),
          });
        },
        revoke: () => {
          if (closed) throw Error('Endpoint revoked twice');
          closed = true;
          revoked += 1;
        },
      });
    },
    counts: () => harden({ opened, revoked }),
  });
};
harden(make);
