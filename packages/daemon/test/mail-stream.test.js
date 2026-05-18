// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/far';
import { makeMailStream } from '../src/mail-stream.js';
import { makeRefIterator } from '../src/ref-reader.js';

/**
 * Drain the stream reader's events into a flat array.  Resolves when the
 * reader signals done (which only happens after end() or abort()).
 * The reader exo exposes the AsyncIterator shape (next/return/throw);
 * makeRefIterator wraps it as a JS-side async iterable.
 *
 * @param {ReturnType<typeof makeMailStream>['reader']} reader
 */
const drainEvents = async reader => {
  const events = [];
  for await (const event of makeRefIterator(reader)) {
    events.push(event);
  }
  return events;
};

test('writer emits append, phase, end events in order', async t => {
  const stream = makeMailStream();

  const eventsP = drainEvents(stream.reader);

  await E(stream.writer).append('hello ');
  await E(stream.writer).setPhase('responding');
  await E(stream.writer).append('world');
  await E(stream.writer).end();

  const events = await eventsP;
  t.deepEqual(events, [
    { type: 'append', text: 'hello ' },
    { type: 'phase', phase: 'responding' },
    { type: 'append', text: 'world' },
    { type: 'end' },
  ]);

  const final = await stream.finalization;
  t.deepEqual(final, {
    status: 'ended',
    text: 'hello world',
    phase: 'responding',
  });
});

test('initial phase is recorded in finalization but not emitted as an event', async t => {
  const stream = makeMailStream({ initialPhase: 'thinking' });

  const eventsP = drainEvents(stream.reader);

  await E(stream.writer).append('hi');
  await E(stream.writer).end();

  const events = await eventsP;
  t.deepEqual(events, [{ type: 'append', text: 'hi' }, { type: 'end' }]);

  const final = await stream.finalization;
  t.deepEqual(final, { status: 'ended', text: 'hi', phase: 'thinking' });
});

test('abort emits an abort event and finalises with partial text', async t => {
  const stream = makeMailStream();

  const eventsP = drainEvents(stream.reader);

  await E(stream.writer).append('partial');
  await E(stream.writer).abort('user cancelled');

  const events = await eventsP;
  t.deepEqual(events, [
    { type: 'append', text: 'partial' },
    { type: 'abort', reason: 'user cancelled' },
  ]);

  const final = await stream.finalization;
  t.deepEqual(final, {
    status: 'aborted',
    text: 'partial',
    phase: undefined,
    reason: 'user cancelled',
  });
});

test('empty stream: end immediately after open emits only end', async t => {
  const stream = makeMailStream();

  const eventsP = drainEvents(stream.reader);

  await E(stream.writer).end();

  const events = await eventsP;
  t.deepEqual(events, [{ type: 'end' }]);

  const final = await stream.finalization;
  t.deepEqual(final, { status: 'ended', text: '', phase: undefined });
});

test('phase-only stream: no text appended, only phase events', async t => {
  const stream = makeMailStream();

  const eventsP = drainEvents(stream.reader);

  await E(stream.writer).setPhase('thinking');
  await E(stream.writer).setPhase('responding');
  await E(stream.writer).end();

  const events = await eventsP;
  t.deepEqual(events, [
    { type: 'phase', phase: 'thinking' },
    { type: 'phase', phase: 'responding' },
    { type: 'end' },
  ]);

  const final = await stream.finalization;
  t.is(final.status, 'ended');
  t.is(final.text, '');
});

test('late subscribers replay buffered events', async t => {
  const stream = makeMailStream();

  // Produce events before any subscriber starts iterating.
  await E(stream.writer).append('one ');
  await E(stream.writer).append('two ');
  await E(stream.writer).setPhase('responding');
  await E(stream.writer).append('three');
  await E(stream.writer).end();

  // Subscribe afterwards; we should still see every event.
  const events = await drainEvents(stream.reader);
  t.deepEqual(events, [
    { type: 'append', text: 'one ' },
    { type: 'append', text: 'two ' },
    { type: 'phase', phase: 'responding' },
    { type: 'append', text: 'three' },
    { type: 'end' },
  ]);
});

test('append/setPhase reject after end()', async t => {
  const stream = makeMailStream();
  await E(stream.writer).end();
  await t.throwsAsync(E(stream.writer).append('late'), {
    message: /closed/,
  });
  await t.throwsAsync(E(stream.writer).setPhase('late'), {
    message: /closed/,
  });
});

test('end() after end() is a no-op (idempotent)', async t => {
  const stream = makeMailStream();
  await E(stream.writer).end();
  await E(stream.writer).end();
  const final = await stream.finalization;
  t.is(final.status, 'ended');
});

test('abort() after end() is a no-op', async t => {
  const stream = makeMailStream();
  await E(stream.writer).append('done');
  await E(stream.writer).end();
  await E(stream.writer).abort('too late');
  const final = await stream.finalization;
  t.is(final.status, 'ended');
});

test('recipient cancels iteration mid-stream', async t => {
  const stream = makeMailStream();

  const collected = [];
  const iterator = makeRefIterator(stream.reader);

  await E(stream.writer).append('first');
  const r1 = await iterator.next();
  collected.push(r1.value);

  await E(stream.writer).append('second');
  // Recipient stops iterating before the stream ends.
  await iterator.return(undefined);
  const r3 = await iterator.next();
  t.is(r3.done, true);

  // Sender continues to operate normally and the stream eventually ends.
  await E(stream.writer).append('third');
  await E(stream.writer).end();

  const final = await stream.finalization;
  t.deepEqual(final, {
    status: 'ended',
    text: 'firstsecondthird',
    phase: undefined,
  });
  t.deepEqual(collected, [{ type: 'append', text: 'first' }]);
});
