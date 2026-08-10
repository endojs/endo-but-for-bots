// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { makeClaudeClientResolver, makeSpeechWriter } from '../agent.js';

test('Claude resolver provisions distinct hosted clients', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const provisioned = [];
  const removed = [];
  const provisioner = Far('ClaudeSessionProvisioner', {
    async provision(id) {
      provisioned.push(id);
      names.set(`claude-client-${id}`, harden({ id }));
      return `claude-client-${id}`;
    },
    async remove(id) {
      removed.push(id);
      names.delete(`claude-client-${id}`);
    },
  });
  names.set('claude-session-provisioner', provisioner);
  const powers = harden({
    async has(name) {
      return names.has(name);
    },
    async lookup(name) {
      if (!names.has(name)) throw Error(`missing ${name}`);
      return names.get(name);
    },
    async remove(name) {
      names.delete(name);
    },
  });
  const resolver = makeClaudeClientResolver(powers);

  const first = await resolver.get('session-a');
  const second = await resolver.get('session-b');
  t.not(first, second);
  t.deepEqual(provisioned, ['session-a', 'session-b']);

  await resolver.remove('session-a');
  t.deepEqual(removed, ['session-a']);
  t.false(names.has('claude-client-session-a'));
});

test('the shared ClaudeClient claim survives a factory restart', async t => {
  // No provisioner: sessions fall through to the shared "claude-client". The
  // claim is persisted to the factory petstore, so a resolver from a later
  // incarnation must refuse a different session — otherwise it would silently
  // `--continue` the first session's conversation.
  /** @type {Map<string, unknown>} */
  const names = new Map();
  names.set('claude-client', harden({ kind: 'shared-client' }));
  const powers = harden({
    async has(name) {
      return names.has(name);
    },
    async lookup(name) {
      if (!names.has(name)) throw Error(`missing ${name}`);
      return names.get(name);
    },
    async remove(name) {
      names.delete(name);
    },
    async storeValue(value, name) {
      names.set(name, value);
    },
  });

  const resolver = makeClaudeClientResolver(powers);
  await resolver.get('session-a');
  await t.throwsAsync(() => resolver.get('session-b'), {
    message: /session session-a already holds it/,
  });

  // Simulate a factory restart: a fresh resolver over the same petstore.
  const revived = makeClaudeClientResolver(powers);
  await t.throwsAsync(() => revived.get('session-b'), {
    message: /session session-a already holds it/,
  });
  // The claiming session itself still resolves.
  await t.notThrowsAsync(() => revived.get('session-a'));

  // Removing the claiming session releases the claim for good.
  await revived.remove('session-a');
  const third = makeClaudeClientResolver(powers);
  await t.notThrowsAsync(() => third.get('session-b'));
});

test('speech restart replays accumulated text and carries future deltas', async t => {
  const readers = [];
  const options = [];
  let audioNumber = 0;
  const ttsServer = Far('TtsServer', {
    synthesize(reader, opts) {
      readers.push(reader);
      options.push(opts);
      audioNumber += 1;
      return Far(`AudioReader${audioNumber}`, {});
    },
  });
  const replyLog = [];
  const replyWriter = harden({
    setPhase: phase => replyLog.push({ type: 'phase', phase }),
    delta: text => replyLog.push({ type: 'delta', text }),
    final: text => replyLog.push({ type: 'final', text }),
    toolCall: call => replyLog.push({ type: 'tool_call', call }),
    toolResult: result => replyLog.push({ type: 'tool_result', result }),
    usage: usage => replyLog.push({ type: 'usage', usage }),
    end: () => replyLog.push({ type: 'end' }),
    abort: reason => replyLog.push({ type: 'abort', reason }),
  });

  const speech = makeSpeechWriter(replyWriter, ttsServer, {
    voice: 'en_US-amy-medium',
  });
  await speech.audioReader;
  speech.writer.delta('Hello');
  await E(speech.speechController).restart({
    voice: 'en_GB-alba-medium',
  });
  speech.writer.delta(' world');
  speech.writer.end();

  const collect = async reader => {
    const events = [];
    for await (const event of iterateReader(reader)) events.push(event);
    return events;
  };
  const [initialEvents, restartedEvents] = await Promise.all(
    readers.map(collect),
  );
  t.deepEqual(options, [
    { voice: 'en_US-amy-medium' },
    { voice: 'en_GB-alba-medium' },
  ]);
  t.deepEqual(initialEvents, [
    { type: 'delta', text: 'Hello' },
    { type: 'abort', reason: 'speech settings changed' },
  ]);
  t.deepEqual(restartedEvents, [
    { type: 'delta', text: 'Hello' },
    { type: 'delta', text: ' world' },
    { type: 'end' },
  ]);
  t.deepEqual(replyLog, [
    { type: 'delta', text: 'Hello' },
    { type: 'delta', text: ' world' },
    { type: 'end' },
  ]);
});

test('identifyClient reports the client cap identity used for attach keying', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const ids = new Map([
    ['claude-client-session-a', 'id-per-session'],
    ['claude-client', 'id-shared'],
  ]);
  const powers = harden({
    async has(name) {
      return names.has(name);
    },
    async lookup(name) {
      return names.get(name);
    },
    async remove(name) {
      names.delete(name);
    },
    async identify(name) {
      return ids.get(name);
    },
  });
  const resolver = makeClaudeClientResolver(powers);
  await null;

  // Nothing bound yet: no identity, so container mounts stay unarmed.
  t.is(await resolver.identifyClient('session-a'), undefined);
  // Only the shared client exists: its identity serves the session.
  names.set('claude-client', harden({}));
  t.is(await resolver.identifyClient('session-a'), 'id-shared');
  // A per-session client takes precedence over the shared fallback.
  names.set('claude-client-session-a', harden({}));
  t.is(await resolver.identifyClient('session-a'), 'id-per-session');
  // A bound name that cannot be identified yields undefined rather than a
  // bogus key.
  ids.delete('claude-client-session-a');
  t.is(await resolver.identifyClient('session-a'), undefined);
});
