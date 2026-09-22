// @ts-check

import { Fail } from '@endo/errors';

/**
 * @typedef {{version: 1, sessionId: string, ownerId: string, incarnation: string,
 * releaseId: string, roles: string[], adapterRef: string}} ProducerManifest
 * @typedef {{manifest: ProducerManifest, evidence: string}} ProducerProof
 * @typedef {{role: string, operationId: string}} Admission
 * @typedef {{revision: string, manifest: ProducerManifest,
 * phase: 'active'|'retiring'|'stopped'|'retired', admissions: Admission[],
 * shutdown?: ProducerProof, receipt?: ProducerProof}} ProducerRecord
 * @typedef {{read(): Promise<ProducerRecord | undefined>,
 * compareAndAppend(expected: string | undefined, next: ProducerRecord): Promise<void>}} ProducerStore
 * @typedef {{admit(manifest: ProducerManifest, admission: Admission, request: unknown): Promise<unknown>,
 * fenceAndStop(manifest: ProducerManifest): Promise<ProducerProof>,
 * reconcile(manifest: ProducerManifest, shutdown: ProducerProof): Promise<ProducerProof>}} ProducerAdapter
 */

/** @param {unknown} value */
export const assertNativeProducerText = value => {
  (typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/u.test(value)) ||
    Fail`Invalid producer identity`;
};
harden(assertNativeProducerText);

/** @param {ProducerManifest} manifest */
const manifestKey = manifest => {
  manifest.version === 1 || Fail`Unsupported producer manifest version`;
  for (const field of [
    manifest.sessionId,
    manifest.ownerId,
    manifest.incarnation,
    manifest.releaseId,
    manifest.adapterRef,
  ])
    assertNativeProducerText(field);
  (Array.isArray(manifest.roles) &&
    manifest.roles.length > 0 &&
    manifest.roles.length <= 32) ||
    Fail`Invalid producer roles`;
  for (const role of manifest.roles) assertNativeProducerText(role);
  new Set(manifest.roles).size === manifest.roles.length ||
    Fail`Duplicate producer role`;
  return JSON.stringify([
    manifest.version,
    manifest.sessionId,
    manifest.ownerId,
    manifest.incarnation,
    manifest.releaseId,
    manifest.adapterRef,
    manifest.roles,
  ]);
};

/** @param {ProducerManifest} manifest */
export const assertNativeProducerManifest = manifest => {
  manifestKey(manifest);
  return harden(manifest);
};
harden(assertNativeProducerManifest);

/**
 * Portable ordering core, not a native reaper or a cross-worker lock.
 *
 * The injected store must be durable and linearizable, including read after an
 * uncertain write. Compare-and-append must never overwrite a competing revision.
 * The adapter is trusted host-private authority, not model-provided authority.
 * Before EVERY effect (including a delayed admission), it must consult the
 * durable manifest/fence and journal exact resource identities before creation.
 * Admissions are named unprivileged operations, never arbitrary root commands.
 * Before effects, the adapter must bind each operation ID to its validated
 * immutable command/profile payload (or digest), rejecting changed-payload reuse.
 * The core's role/ID intent alone does not authorize arbitrary request fields.
 * fenceAndStop must durably deny future effects and prove all pending starts and
 * descendants stopped. reconcile may remove only those exact recorded native
 * resources, never shared credentials or retained workspace contents.
 * Adapter operations must be retryable by immutable identity; proof evidence is
 * opaque here and must be validated by the adapter against its own durable state.
 *
 * This core deliberately never resumes an uncertain admission. Its durable
 * intent remains until retirement proves that even a lost/delayed request cannot
 * create further resources. A failed store operation poisons this instance;
 * reconstruction must read authoritative storage instead of guessing its result.
 *
 * @param {{manifest: ProducerManifest, store: ProducerStore, adapter: ProducerAdapter}} options
 */
export const makeNativeProducerLifecycle = ({ manifest, store, adapter }) => {
  const key = manifestKey(manifest);
  harden(manifest);
  /** @type {ProducerRecord | undefined} */
  let record;
  let fenced = false;
  let poisoned = false;
  let loaded = false;
  /** @type {Promise<void>} */
  let ordering = Promise.resolve();
  /** @type {Promise<ProducerProof> | undefined} */
  let retiring;
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  const assertHealthy = () => {
    !poisoned || Fail`Producer storage outcome is uncertain`;
  };
  /**
   * @template T
   * @param {() => Promise<T>} operation
   */
  const serial = operation => {
    const result = ordering.then(operation);
    ordering = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  /** @param {ProducerRecord} value */
  const validate = value => {
    manifestKey(value.manifest) === key || Fail`Producer manifest changed`;
    /^(0|[1-9][0-9]{0,63})$/u.test(value.revision) ||
      Fail`Invalid producer revision`;
    ['active', 'retiring', 'stopped', 'retired'].includes(value.phase) ||
      Fail`Invalid producer phase`;
    Array.isArray(value.admissions) || Fail`Invalid producer admissions`;
    const ids = new Set();
    for (const admission of value.admissions) {
      assertNativeProducerText(admission.operationId);
      manifest.roles.includes(admission.role) || Fail`Unapproved producer role`;
      !ids.has(admission.operationId) || Fail`Duplicate producer operation`;
      ids.add(admission.operationId);
    }
    if (value.phase === 'stopped' || value.phase === 'retired')
      assertProof(value.shutdown);
    if (value.phase === 'retired') assertProof(value.receipt);
    return harden(value);
  };
  /**
   * @param {ProducerProof | undefined} proof
   * @returns {ProducerProof}
   */
  const assertProof = proof => {
    if (!proof) throw Error('Missing producer proof');
    manifestKey(proof.manifest) === key ||
      Fail`Producer proof identity changed`;
    assertNativeProducerText(proof.evidence);
    return harden(proof);
  };
  const load = async () => {
    assertHealthy();
    if (!loaded) {
      try {
        const found = await store.read();
        record = found === undefined ? undefined : validate(found);
        loaded = true;
      } catch (error) {
        poisoned = true;
        throw error;
      }
    }
    return record;
  };
  /** @param {Omit<ProducerRecord, 'revision' | 'manifest'>} next */
  const write = async next => {
    assertHealthy();
    const value = validate({
      ...next,
      manifest,
      revision: record ? `${BigInt(record.revision) + 1n}` : '0',
    });
    try {
      await store.compareAndAppend(record?.revision, value);
      record = value;
    } catch (error) {
      poisoned = true;
      throw error;
    }
    return value;
  };
  const initialize = () =>
    serial(async () => {
      !fenced || Fail`Producer is retiring`;
      const found = await load();
      if (!found) return write({ phase: 'active', admissions: [] });
      found.phase === 'active' || Fail`Producer incarnation cannot restart`;
      return found;
    });
  /**
   * @param {string} role
   * @param {string} operationId
   * @param {unknown} request
   */
  const admit = (role, operationId, request) => {
    if (fenced) return Promise.reject(Error('Producer is retiring'));
    // Retain the whole continuation before its first await, including dispatch.
    const operation = serial(async () => {
      !fenced || Fail`Producer is retiring`;
      assertNativeProducerText(operationId);
      manifest.roles.includes(role) || Fail`Unapproved producer role`;
      const found = await load();
      if (!found || found.phase !== 'active')
        throw Error('Producer is not active');
      !found.admissions.some(item => item.operationId === operationId) ||
        Fail`Producer operation already admitted`;
      const admission = harden({ role, operationId });
      await write({ ...found, admissions: [...found.admissions, admission] });
      !fenced || Fail`Producer is retiring`;
      return admission;
    }).then(admission => {
      !fenced || Fail`Producer is retiring`;
      return adapter.admit(manifest, admission, request).then(result => {
        !fenced || Fail`Producer is retiring`;
        return result;
      });
    });
    pending.add(operation);
    void operation
      .finally(() => pending.delete(operation))
      .catch(() => undefined);
    return operation;
  };
  const retire = () => {
    fenced = true;
    retiring ??= serial(async () => {
      const found = await load();
      if (!found) throw Error('Missing producer manifest is not cleanup proof');
      let current = found;
      if (current.phase === 'retired') return assertProof(current.receipt);
      if (current.phase === 'active')
        current = await write({ ...current, phase: 'retiring' });
      if (current.phase === 'retiring') {
        const shutdown = assertProof(await adapter.fenceAndStop(manifest));
        // Adapter proof includes effects whose RPC has not returned. Local
        // continuations must also drain before handing this incarnation off.
        await Promise.allSettled([...pending]);
        current = await write({ ...current, phase: 'stopped', shutdown });
      }
      const shutdown = assertProof(current.shutdown);
      const receipt = assertProof(await adapter.reconcile(manifest, shutdown));
      await write({ ...current, phase: 'retired', receipt });
      return receipt;
    }).catch(error => {
      retiring = undefined;
      throw error;
    });
    return retiring;
  };
  const status = () => serial(load);
  return harden({ initialize, admit, retire, status });
};
harden(makeNativeProducerLifecycle);
