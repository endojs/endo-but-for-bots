// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { sessionIdFromLabel, sessionIdHex } from '../src/session.js';

test('sessionId is 32 bytes', t => {
  const id = sessionIdFromLabel('worker-1');
  t.is(id.length, 32);
});

test('sessionId is deterministic', t => {
  const a = sessionIdFromLabel('worker-1');
  const b = sessionIdFromLabel('worker-1');
  t.deepEqual([...a], [...b]);
});

test('sessionId differs for different labels', t => {
  const a = sessionIdFromLabel('worker-1');
  const b = sessionIdFromLabel('worker-2');
  t.notDeepEqual([...a], [...b]);
});

test('sessionId fixture — empty label matches the canonical digest', t => {
  // The Rust crate computes:
  //   SHA-256("slots/session/" || label)
  //
  // For label="" this is SHA-256("slots/session/"), a stable digest
  // that must match byte-for-byte between the two implementations.
  // If this fails either the domain-separation prefix changed or
  // the hashing library produced a different digest.
  const expectedHex =
    '5f8c31bdfa9a8acbc31b7b7dfffeb85df4605dfd4ceb74db6e9f35df8c4ce268';
  const id = sessionIdFromLabel('');
  t.is(sessionIdHex(id), expectedHex);
});

test('sessionId fixture — worker-1 label', t => {
  const expectedHex =
    'f33f8f1cfda07c7c414fef3ab00811aa13b7fa1459690cfc4cccd43b0c5ce547';
  t.is(sessionIdHex(sessionIdFromLabel('worker-1')), expectedHex);
});

test('sessionIdHex returns 64 lowercase hex chars', t => {
  const id = sessionIdFromLabel('worker-42');
  const hex = sessionIdHex(id);
  t.is(hex.length, 64);
  t.regex(hex, /^[0-9a-f]{64}$/);
});
