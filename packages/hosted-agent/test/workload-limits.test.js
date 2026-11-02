// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  DEFAULT_WORKLOAD_LIMITS,
  readWorkloadLimit,
  readWorkloadBytes,
} from '../src/workload-limits.js';
import { readPublicEgressLimits } from '../src/public-egress.js';
import { readBrokerWorkloadEnv } from '../src/provider-broker-service.js';

test('workload defaults are generous finite guards, not wire bounds', t => {
  t.is(DEFAULT_WORKLOAD_LIMITS.transcriptChars, 1024 ** 3);
  t.is(DEFAULT_WORKLOAD_LIMITS.transcriptRecords, 1024 ** 2);
  t.is(DEFAULT_WORKLOAD_LIMITS.contentChars, 256 * 1024 ** 2);
  t.deepEqual(readPublicEgressLimits({}), {
    maxConnections: 1024,
    maxBytes: 1024n ** 4n,
    timeoutMs: 86_400_000,
  });
  t.is(DEFAULT_WORKLOAD_LIMITS.inferenceTimeoutMs, 3_600_000);
});

test('integer settings reject malformed input and timer overflow', t => {
  t.is(readWorkloadLimit({}, 'LIMIT', 42), 42);
  t.is(readWorkloadLimit({ LIMIT: '' }, 'LIMIT', 42), 42);
  t.is(readWorkloadLimit({ LIMIT: '0' }, 'LIMIT', 42, { min: 0 }), 0);
  t.is(
    readWorkloadLimit({ LIMIT: '4294967295' }, 'LIMIT', 42, {
      max: 0xffff_ffff,
    }),
    0xffff_ffff,
  );
  for (const LIMIT of [
    '0',
    '-1',
    '1.5',
    '1e3',
    'Infinity',
    'NaN',
    ' ',
    '0xff',
    '2147483648',
  ]) {
    t.throws(() => readWorkloadLimit({ LIMIT }, 'LIMIT', 42), {
      message: /Invalid workload limit/,
    });
  }
});

test('byte counts use bigint without rounding, truncation or a numeric ceiling', t => {
  t.is(
    readWorkloadBytes({ LIMIT: '18446744073709551616' }, 'LIMIT', 1n),
    2n ** 64n,
  );
  for (const LIMIT of ['0', '-1', '1.5', 'Infinity', '1e6']) {
    t.throws(() => readWorkloadBytes({ LIMIT }, 'LIMIT', 1n), {
      message: /Invalid workload limit/,
    });
  }
});

test('broker construction persists only validated workload knobs', t => {
  const env = {
    ENDO_PUBLIC_EGRESS_MAX_CONNECTIONS: '2048',
    ENDO_PUBLIC_EGRESS_MAX_BYTES: '10995116277760',
    ENDO_PUBLIC_EGRESS_TIMEOUT_MS: '172800000',
    ENDO_PROVIDER_REQUEST_TIMEOUT_MS: '7200000',
    UNRELATED: 'not forwarded',
  };
  const { UNRELATED, ...wanted } = env;
  t.is(UNRELATED, 'not forwarded');
  t.deepEqual(readBrokerWorkloadEnv(env), wanted);
  t.deepEqual(readPublicEgressLimits(env), {
    maxConnections: 2048,
    maxBytes: 10n * 1024n ** 4n,
    timeoutMs: 172_800_000,
  });
  t.throws(
    () => readBrokerWorkloadEnv({ ENDO_PROVIDER_REQUEST_TIMEOUT_MS: 'NaN' }),
    { message: /Invalid workload limit/ },
  );
});
