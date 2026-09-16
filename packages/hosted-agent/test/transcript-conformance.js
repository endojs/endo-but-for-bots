// @ts-check
import test from 'ava';

import {
  parseTranscript,
  encodeTranscript,
} from '../src/transcript-records.js';

/**
 * Shared restoration conformance for the hosted CLI adapters.
 *
 * The stack owns the transcript, so every adapter must be able to turn the
 * record stream back into its CLI's native conversation without losing what
 * the records distinguish. These are the properties that hold whatever the
 * native format is; an adapter's own suite adds whatever its format needs.
 *
 * This suite is what makes the accepted format couplings safe. Claude's JSONL
 * schema and OpenCode's database schema were captured by observation, not
 * specification, and the protection for that is a pinned image — which only
 * protects while a pin bump re-runs these tests. A format that drifted
 * silently would resume empty rather than fail, which is the failure mode
 * that hides.
 *
 * @param {object} adapter
 * @param {string} adapter.label
 * @param {(records: readonly any[]) => string | Promise<string>} adapter.restore
 *   Render the records as the CLI's native store.
 * @param {(native: string) => readonly any[] | Promise<readonly any[]>} adapter.readBack
 *   Read that store back as records, so the round trip can be judged.
 */
export const testTranscriptRestoration = ({ label, restore, readBack }) => {
  const conversation = harden([
    { kind: 'message', role: 'user', content: 'build the page' },
    { kind: 'message', role: 'assistant', content: 'reading the workspace' },
    { kind: 'tool-call', id: 'c1', name: 'readFile', args: '{"path":"a"}' },
    { kind: 'tool-result', id: 'c1', content: 'contents of a' },
    { kind: 'message', role: 'assistant', content: 'done' },
  ]);

  test(`${label} restores a conversation without losing its turns`, async t => {
    const records = await readBack(await restore(conversation));
    t.deepEqual(
      records.map(record => record.kind),
      conversation.map(record => record.kind),
      'every record comes back, in order',
    );
    t.deepEqual(
      records.filter(record => record.kind === 'message'),
      conversation.filter(record => record.kind === 'message'),
      'dialogue is unchanged',
    );
  });

  test(`${label} restores a tool call as a tool call with its result`, async t => {
    const records = await readBack(await restore(conversation));
    const call = records.find(record => record.kind === 'tool-call');
    const result = records.find(record => record.kind === 'tool-result');
    // The property most likely to regress silently: a format that flattened
    // tool traffic into prose would still round-trip the dialogue above.
    t.like(call, { name: 'readFile', args: '{"path":"a"}' });
    t.like(result, { content: 'contents of a' });
    t.is(call?.id, result?.id, 'the call and its result stay paired');
  });

  test(`${label} restores an interrupted call as interrupted`, async t => {
    const interrupted = harden([
      { kind: 'message', role: 'user', content: 'go' },
      { kind: 'tool-call', id: 'c1', name: 'build', args: '{}' },
    ]);
    const records = await readBack(await restore(interrupted));
    t.truthy(
      records.find(record => record.kind === 'tool-call'),
      'the call survives rather than being dropped',
    );
  });

  test(`${label} restores a compacted conversation at its boundary`, async t => {
    const compacted = harden([
      ...conversation,
      { kind: 'compaction', summary: 'we built the page' },
      { kind: 'message', role: 'user', content: 'now the footer' },
    ]);
    const records = await readBack(await restore(compacted));
    const text = records
      .filter(record => record.kind === 'message')
      .map(record => record.content)
      .join('\n');
    t.true(text.includes('we built the page'), 'the summary is carried');
    t.true(text.includes('now the footer'), 'the live span is carried');
    t.false(
      text.includes('reading the workspace'),
      'the superseded span is not replayed, or the compaction bought nothing',
    );
  });

  test(`${label} restores the same store from the same records`, async t => {
    // A retried revival must not fork a second conversation out of one
    // history, so restoration cannot depend on randomness or the clock.
    t.is(await restore(conversation), await restore(conversation));
  });

  test(`${label} restores an empty conversation as an empty store`, async t => {
    t.deepEqual(await readBack(await restore([])), []);
  });

  test(`${label} round-trips through the record encoding unchanged`, t => {
    // The stream an adapter is handed is the stream the stack persisted.
    t.deepEqual(parseTranscript(encodeTranscript(conversation)), [
      ...conversation,
    ]);
  });
};
harden(testTranscriptRestoration);
