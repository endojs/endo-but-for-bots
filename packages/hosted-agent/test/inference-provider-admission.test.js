// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  compactInferenceTurnEvents,
  effectiveInferenceLimits,
  foldInferenceTurnEvents,
  inferenceAdmissionRefusal,
  inferenceUsageAt,
} from '../src/inference-provider-admission.js';

const reservation = harden({
  type: 'reserved',
  version: 1,
  turnId: 'turn-1',
  ownerId: 'owner-1',
  providerId: 'provider-1',
  grantId: 'grant-1',
  agentId: 'agent-1',
  model: 'claude-test',
  day: '2026-10-30',
  admittedAt: '2026-10-30T00:00:01.000Z',
  admittedAtMs: 1000,
  reservedTokens: 100,
});

const settlement = harden({
  type: 'settled',
  turnId: 'turn-1',
  disposition: 'reported',
  usage: harden({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }),
  chargedTokens: 15,
  overrun: false,
  settledAt: '2026-10-30T00:00:02.000Z',
  settledAtMs: 2000,
});

test('effective limits use one composition rule', t => {
  t.deepEqual(
    effectiveInferenceLimits(
      harden({
        concurrentTurns: 3,
        requestsPerMinute: 5,
        dailyDollars: 2,
      }),
      harden({
        concurrentTurns: 2,
        requestsPerMinute: 10,
        dailyTokens: 1000,
      }),
    ),
    {
      concurrentTurns: 2,
      requestsPerMinute: 5,
      dailyTokens: 1000,
    },
  );
});

test('turn facts fold as of a requested time', t => {
  const events = harden([reservation, settlement]);
  t.like(foldInferenceTurnEvents(events, 1500)['turn-1'], {
    state: 'reserved',
    reservedTokens: 100,
  });
  t.like(foldInferenceTurnEvents(events, 2500)['turn-1'], {
    state: 'settled',
    disposition: 'reported',
    chargedTokens: 15,
  });
});

test('compaction drops old complete facts and retains live reservations', t => {
  const oldReservation = harden({
    ...reservation,
    turnId: 'turn-old',
    day: '2026-10-29',
    admittedAtMs: Date.parse('2026-10-29T00:00:00.000Z'),
  });
  const oldSettlement = harden({
    ...settlement,
    turnId: 'turn-old',
    settledAtMs: Date.parse('2026-10-29T00:00:01.000Z'),
  });
  const liveReservation = harden({
    ...reservation,
    turnId: 'turn-live',
    day: '2026-10-29',
    admittedAtMs: Date.parse('2026-10-29T00:00:02.000Z'),
  });
  const compacted = compactInferenceTurnEvents(
    harden([oldReservation, oldSettlement, liveReservation]),
    Date.parse('2026-10-30T00:00:00.000Z'),
  );
  t.deepEqual(
    compacted.map(event => event.turnId),
    ['turn-live'],
  );
});

test('admission is a pure decision over a usage snapshot', t => {
  const events = harden([reservation]);
  const before = JSON.stringify(events);
  const refusal = inferenceAdmissionRefusal({
    usage: inferenceUsageAt(events, Date.parse('2026-10-30T00:00:01.500Z')),
    scopes: harden([
      {
        name: 'owner',
        limits: harden({
          concurrentTurns: 1,
          requestsPerMinute: 10,
          dailyTokens: 1000,
        }),
        field: 'ownerId',
        value: 'owner-1',
      },
    ]),
    reservedTokens: 100,
    reservedCostMicros: undefined,
  });
  t.is(refusal, 'owner-concurrency-exhausted');
  t.is(JSON.stringify(events), before);
});

test('compaction keeps a reservation admitted after a backward clock step', t => {
  const admittedAtMs = Date.parse('2026-10-30T00:00:10.000Z');
  const futureReservation = harden({
    ...reservation,
    turnId: 'turn-ahead',
    day: '2026-10-30',
    admittedAtMs,
  });
  const futureSettlement = harden({
    ...settlement,
    turnId: 'turn-ahead',
    settledAtMs: admittedAtMs + 1,
  });
  // The clock stepped back a day; the reservation looks admitted tomorrow.
  const asOf = admittedAtMs - 86_400_000;
  t.deepEqual(
    compactInferenceTurnEvents(harden([futureReservation]), asOf).map(
      event => event.turnId,
    ),
    ['turn-ahead'],
  );
  t.deepEqual(
    compactInferenceTurnEvents(
      harden([futureReservation, futureSettlement]),
      asOf,
    ).map(event => event.turnId),
    ['turn-ahead', 'turn-ahead'],
  );
});
