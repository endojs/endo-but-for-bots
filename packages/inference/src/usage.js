// @ts-check

/** @import { InferenceBackend, UsageRecord } from './types.js' */

let serial = 0;
/** @param {string} [prefix] */
export const makeRunId = (prefix = 'run') => {
  serial += 1;
  return `${prefix}-${Date.now().toString(36)}-${serial}`;
};
harden(makeRunId);

/**
 * Usage-record enricher (Decision 8). Writes one record per turn to `sink`
 * without widening `InferResult`.
 *
 * @template G
 * @param {InferenceBackend<G>} backend
 * @param {object} options
 * @param {string} options.credentialId  secret manager `secretId` or a label;
 *   never the credential bytes.
 * @param {(record: UsageRecord) => void} options.sink
 * @param {() => number} [options.now]
 * @returns {InferenceBackend<G>}
 */
export const withUsageRecord = (
  backend,
  { credentialId, sink, now = () => Date.now() },
) =>
  harden({
    describe: () => backend.describe(),
    infer: async request => {
      const started = now();
      const result = await backend.infer(request);
      const { kind, provider, version } = backend.describe();
      /** @type {UsageRecord} */
      const record = {
        runId: makeRunId(kind),
        provider,
        backendKind: kind,
        ...(version === undefined ? {} : { backendVersion: version }),
        credentialId,
        startedAt: new Date(started).toISOString(),
        latencyMs: now() - started,
        resultType: result.type,
      };
      if (result.type === 'ok' && result.usage) record.usage = result.usage;
      if (result.type === 'unavailable') record.detail = result.reason;
      if (result.type === 'limit-exceeded') record.detail = result.which;
      sink(harden(record));
      return result;
    },
  });
harden(withUsageRecord);
