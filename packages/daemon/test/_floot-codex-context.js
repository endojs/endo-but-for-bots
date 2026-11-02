// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

// Real client/journal, deliberately fake app-server and sandbox helper. This
// fixture tests daemon persistence, not CLI rollout parsing or native execution.
/* eslint-disable import/no-relative-packages */
import { makeCodexClient } from '../../codex-sandbox/src/codex-client.js';
import {
  adaptEndoTools,
  withEndoToolInstructions,
} from '../../codex-sandbox/src/endo-tools.js';
import { makeStreamingAgent } from '../../floot/agent.js';
import { providePrivateTurnStorage } from '../../floot/src/private-turn-storage.js';
import { makeReplyChannel } from '../../floot/src/stream.js';
/* eslint-enable import/no-relative-packages */

const sessionId = 'codex-context';
const ledgerName = 'codex-context-ledger';
const nativeName = 'codex-context-native';
const proofName = 'codex-context-effect';

/** @param {any} host */
export const make = async host => {
  const storage = await providePrivateTurnStorage(host, sessionId);
  const saved = (await E(host).has(ledgerName))
    ? await E(host).lookup(ledgerName)
    : {};
  const native = (await E(host).has(nativeName))
    ? { ...(await E(host).lookup(nativeName)) }
    : {};
  const messages = makeBufferedReader();
  const requests = [];
  const restores = [];
  const captures = [];
  const savedStates = [];
  const acknowledgements = [];
  let turnId;
  let threadId;
  let client;
  let starts = 0;
  const reply = (id, result) => messages.push(harden({ id, result }));
  const notify = (method, params) => messages.push(harden({ method, params }));
  const finish = async () => {
    native[threadId] = turnId;
    await E(host).storeValue(harden({ ...native }), nativeName);
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'answer',
      delta: `Answer ${turnId}`,
    });
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
  };
  const transport = {
    messages: iterateReader(messages.reader),
    async send(message) {
      await null;
      requests.push(message);
      if (!message.method) {
        if (message.id !== 'effect-request' || !message.result?.success)
          throw Error('Unexpected mock tool response');
        notify('item/completed', {
          threadId,
          turnId,
          item: {
            type: 'dynamicToolCall',
            id: 'effect-call',
            tool: 'effect',
            arguments: {},
            status: 'completed',
            contentItems: message.result.contentItems,
          },
        });
        await finish();
        return;
      }
      if (message.id === undefined) return;
      switch (message.method) {
        case 'account/read':
          reply(message.id, {
            account: { type: 'apiKey' },
            requiresOpenaiAuth: false,
          });
          break;
        case 'initialize':
          reply(message.id, {
            codexHome: '/codex-home',
            platformFamily: 'unix',
            platformOs: 'linux',
            userAgent: 'daemon-test',
          });
          break;
        case 'thread/start':
          threadId = 'native-seed';
          reply(message.id, { thread: { id: threadId } });
          break;
        case 'thread/resume':
          threadId = message.params.threadId;
          if (message.params.path) native[threadId] = 'rollout-1';
          reply(message.id, { thread: { id: threadId } });
          break;
        case 'thread/turns/list':
          reply(message.id, {
            data: native[threadId]
              ? [{ id: native[threadId], status: 'completed' }]
              : [],
            nextCursor: null,
            backwardsCursor: null,
          });
          break;
        case 'thread/read':
          reply(message.id, {
            thread: {
              id: threadId,
              path: `/codex-home/sessions/${threadId}.jsonl`,
            },
          });
          break;
        case 'turn/start': {
          starts += 1;
          turnId = threadId === 'native-seed' ? 'turn-seed' : 'turn-recalled';
          reply(message.id, { turn: { id: turnId, status: 'inProgress' } });
          notify('turn/started', {
            threadId,
            turn: { id: turnId, status: 'inProgress' },
          });
          if (threadId === 'native-seed') {
            notify('item/started', {
              threadId,
              turnId,
              item: {
                type: 'dynamicToolCall',
                id: 'effect-call',
                tool: 'effect',
                arguments: {},
              },
            });
            messages.push(
              harden({
                id: 'effect-request',
                method: 'item/tool/call',
                params: {
                  threadId,
                  turnId,
                  callId: 'effect-call',
                  tool: 'effect',
                  arguments: {},
                },
              }),
            );
          } else await finish();
          break;
        }
        default:
          throw Error(`Unexpected mock request ${message.method}`);
      }
    },
    async close() {
      messages.close();
    },
  };
  const agent = await makeStreamingAgent(
    host,
    undefined,
    {
      kind: 'hosted',
      provideHostedClient: tools => {
        const adapted = adaptEndoTools(tools);
        client = makeCodexClient({
          sessionId,
          threadId: saved.threadId,
          savedToolSetId: saved.toolSetId,
          savedRecovery: saved.recovery,
          toolSetId: adapted.toolSetId,
          cwd: '/workspace',
          developerInstructions: 'Test prompt',
          start: async () => transport,
          saveThreadState: async value => {
            await E(host).storeValue(value, ledgerName);
            savedStates.push(value);
          },
          makeNativeIdentity: () => ({
            sessionId: 'native-restored',
            timestamp: '2026-09-24T00:00:00.000Z',
          }),
          nativeContext: {
            capture: async request => {
              await null;
              const capture = harden({
                sessionId: request.sessionId,
                turnId: request.turnId,
                baseInstructions: 'Synthetic native base',
                payload: `${'Opaque native bytes 😀 '.repeat(500)}${request.turnId}\n`,
              });
              captures.push(capture);
              return capture;
            },
            restore: async request => {
              await null;
              restores.push(request);
              return {
                sessionId: request.target.sessionId,
                rolloutPath: `/codex-home/sessions/${request.target.sessionId}.jsonl`,
                sha256: 'mock-hash',
              };
            },
            cancel: async () => {},
            close: async () => {},
          },
          dynamicTools: adapted.dynamicTools,
          callTool: (name, args) =>
            tools.execute(adapted.originalName(name), args),
        });
        return Far('ObservedCodexClient', {
          send: (prompt, options) =>
            E(client).send(
              prompt,
              withEndoToolInstructions(options, 'Test prompt'),
            ),
          interrupt: () => E(client).interrupt(),
          terminate: () => E(client).terminate(),
          acknowledge: async checkpoint => {
            const turns = await agent.getTurns();
            const latest = turns.at(-1);
            if (
              !latest ||
              latest.state !== 'completed' ||
              latest.transcriptComplete !== true ||
              latest.backendCheckpoint !== checkpoint ||
              !latest.transcript.some(row => row.kind === 'native-context')
            )
              throw Error(
                'Checkpoint acknowledged before journal native context and finish',
              );
            acknowledgements.push(checkpoint);
            await E(client).acknowledge(checkpoint);
          },
        });
      },
    },
    'Test prompt',
    {
      journalPowers: storage,
      nativeContextFormat: 'codex-rollout-v1',
      extraTools: new Map([
        [
          'effect',
          harden({
            schema: () =>
              harden({
                type: 'function',
                function: {
                  name: 'effect',
                  description: 'One effect',
                  parameters: { type: 'object', properties: {}, required: [] },
                },
              }),
            execute: async () => {
              await null;
              if (await E(host).has(proofName)) throw Error('Effect repeated');
              await E(host).storeValue(harden({ executions: 1 }), proofName);
              return 'Effect happened once';
            },
            help: () => 'One effect',
          }),
        ],
      ]),
    },
  );
  return Far('FlootCodexContextFixture', {
    converse: () =>
      agent.converse(
        'Continue without repeating effects',
        makeReplyChannel().writer,
      ),
    inspect: async () =>
      harden({
        starts,
        requests: harden([...requests]),
        restores: harden([...restores]),
        captures: harden([...captures]),
        savedStates: harden([...savedStates]),
        acknowledgements: harden([...acknowledgements]),
        turns: await agent.getTurns(),
        transcript: await agent.getTranscript(),
        history: await agent.getHistory(),
      }),
    shutdown: async () => {
      await agent.shutdown();
      await E(storage).close();
    },
  });
};
harden(make);
