// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

// Test-only cross-package imports; no daemon production dependency on Floot.
/* eslint-disable import/no-relative-packages */
import { makeStreamingAgent } from '../../floot/agent.js';
import { providePrivateTurnStorage } from '../../floot/src/private-turn-storage.js';
import { makeTurnJournal } from '../../floot/src/turn-journal.js';
import { makeReplyChannel } from '../../floot/src/stream.js';
/* eslint-enable import/no-relative-packages */

const sessionId = 'archive-context';
const options = harden({
  input: 'seed',
  backendId: 'provider',
  modelId: 'test',
});
const longText = `${'Superseded dialogue '.repeat(800)}OLD-TEXT-END`;

/** @param {any} host */
export const make = async host => {
  let agent;
  let storage;
  let calls = 0;
  let captured;
  const contentReads = [];
  const provideAgent = async () => {
    if (!agent) {
      storage = await providePrivateTurnStorage(host, sessionId);
      const measuredStorage = Far('MeasuredPrivateStorage', {
        list: () => E(storage).list(),
        lookup: name => {
          if (name.startsWith('floot-turn-content-')) contentReads.push(name);
          return E(storage).lookup(name);
        },
        storeValue: (value, name) => E(storage).storeValue(value, name),
        remove: name => E(storage).remove(name),
      });
      agent = await makeStreamingAgent(
        host,
        undefined,
        {
          kind: 'provider',
          provideProvider: () =>
            harden({
              chatStream: async messages => {
                calls += 1;
                captured = messages;
                return harden({
                  message: { role: 'assistant', content: 'Recall complete' },
                });
              },
            }),
        },
        'Test',
        { journalPowers: measuredStorage },
      );
    }
    return agent;
  };
  return Far('ArchivedContextTest', {
    seed: async () => {
      if (agent || (await E(host).has('archive-effect-proof')))
        throw Error('Seed already performed');
      const seedStorage = await providePrivateTurnStorage(host, sessionId);
      try {
        const journal = makeTurnJournal(seedStorage);
        const old = await journal.begin(options);
        await journal.recordTranscript(old, '0', {
          kind: 'message',
          role: 'assistant',
          content: longText,
        });
        await journal.recordTranscript(old, '1', {
          kind: 'tool-call',
          id: 'late',
          name: 'effect',
          args: '{}',
        });
        await journal.append(old, {
          type: 'observed-tool-call',
          callId: 'late',
          name: 'effect',
          args: '{}',
        });
        await journal.append(old, { type: 'finish', state: 'completed' });
        const certified = await journal.begin(options);
        await journal.recordTranscript(certified, '0', {
          kind: 'tool-call',
          id: 'known',
          name: 'read',
          args: JSON.stringify({ text: 'x'.repeat(12_000) }),
        });
        await journal.recordTranscript(certified, '1', {
          kind: 'tool-result',
          id: 'known',
          content: 'KNOWN-SUMMARIZED',
        });
        await journal.append(certified, { type: 'finish', state: 'completed' });
        const boundary = await journal.begin(options);
        await journal.recordTranscript(boundary, '0', {
          kind: 'compaction',
          summary: 'ARCHIVED-SUMMARY',
          retainedTail: [
            { kind: 'message', role: 'assistant', content: 'RETAINED-TAIL' },
          ],
        });
        await journal.append(boundary, { type: 'finish', state: 'completed' });
        const finish = async count => {
          for (let index = 0; index < Number(count); index += 1) {
            // eslint-disable-next-line no-await-in-loop
            const id = await journal.begin(options);
            // eslint-disable-next-line no-await-in-loop
            await journal.append(id, { type: 'finish', state: 'completed' });
          }
        };
        await finish(290);
        await E(host).storeValue(
          harden({ executions: 1 }),
          'archive-effect-proof',
        );
        await journal.append(old, {
          type: 'observed-tool-result',
          callId: 'late',
          result: 'LATE-EFFECT-PROOF',
        });
        await journal.resolve(old, 'Effect independently checked');
        await finish(80);
        return harden({ old, certified, boundary });
      } finally {
        await E(seedStorage).close();
      }
    },
    inspectArchive: async () => {
      if (agent) throw Error('Inspect archive before opening production agent');
      const readerStorage = await providePrivateTurnStorage(host, sessionId);
      try {
        const journal = makeTurnJournal(readerStorage);
        const view = await journal.readView();
        const archived = await journal.listArchived();
        return harden({ view, archived });
      } finally {
        await E(readerStorage).close();
      }
    },
    inspect: async () => {
      const current = await provideAgent();
      return harden({
        calls,
        transcript: await current.getTranscript(),
        history: await current.getHistory(),
        turns: await current.getTurns(),
      });
    },
    open: async () => {
      await provideAgent();
      return calls;
    },
    contentReads: () => harden([...contentReads]),
    recall: async () => {
      const current = await provideAgent();
      await current.converse(
        'Recall without repeating effects',
        makeReplyChannel().writer,
      );
      return harden(captured);
    },
    shutdown: async () => {
      if (agent) await agent.shutdown();
      if (storage) await E(storage).close();
    },
  });
};
harden(make);
