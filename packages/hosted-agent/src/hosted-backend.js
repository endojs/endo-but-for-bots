// @ts-check

import { Fail } from '@endo/errors';
import { M } from '@endo/patterns';

/** The only Endo authority a hosted backend receives from Floot. */
export const HostedToolSetInterface = M.interface('HostedToolSet', {
  describe: M.call().returns(M.promise()),
  execute: M.call(M.string(), M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedToolSetInterface);

/**
 * Provider-neutral facets for a hosted agent backend.
 *
 * `interrupt()` is a terminal barrier. `destroy()` is idempotent for lifecycle
 * replay when no live admin facet survives.
 */
export const HostedTurnBackendInterface = M.interface('HostedTurnBackend', {
  send: M.call(M.string())
    .optional(M.recordOf(M.string(), M.any()))
    .returns(M.promise()),
  models: M.call().returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  acknowledge: M.call(M.string()).returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedTurnBackendInterface);

export const HostedTurnBackendAdminInterface = M.interface(
  'HostedTurnBackendAdmin',
  {
    terminate: M.call().returns(M.promise()),
    help: M.call().returns(M.string()),
  },
);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedTurnBackendAdminInterface);

export const HostedBackendFactoryInterface = M.interface(
  'HostedBackendFactory',
  {
    describe: M.call().returns(M.promise()),
    listModels: M.call().returns(M.promise()),
    create: M.call(M.record(), M.remotable('HostedToolSet')).returns(
      M.promise(),
    ),
    destroy: M.call(M.record()).returns(M.promise()),
    help: M.call().returns(M.string()),
  },
);
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(HostedBackendFactoryInterface);

/**
 * Validate and project the exact capability-free descriptor fields Floot uses
 * for selection and recovery.
 *
 * @param {any} descriptor
 */
export const assertHostedBackendDescriptor = descriptor => {
  (descriptor &&
    typeof descriptor === 'object' &&
    Object.keys(descriptor).sort().join(',') ===
      'continuity,id,kind,title,toolOwnership') ||
    Fail`Hosted backend descriptor must be a record`;
  (typeof descriptor.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(descriptor.id)) ||
    Fail`Hosted backend descriptor has an invalid id`;
  (typeof descriptor.title === 'string' && descriptor.title !== '') ||
    Fail`Hosted backend descriptor has an invalid title`;
  descriptor.kind === 'hosted' ||
    Fail`Hosted backend descriptor must have kind hosted`;
  (typeof descriptor.continuity === 'string' && descriptor.continuity !== '') ||
    Fail`Hosted backend descriptor must declare continuity`;
  (typeof descriptor.toolOwnership === 'string' &&
    descriptor.toolOwnership !== '') ||
    Fail`Hosted backend descriptor must declare tool ownership`;
  return harden({
    id: descriptor.id,
    title: descriptor.title,
    kind: descriptor.kind,
    continuity: descriptor.continuity,
    toolOwnership: descriptor.toolOwnership,
  });
};
harden(assertHostedBackendDescriptor);

/**
 * Validate and project Floot's exact capability-free model catalog DTO.
 *
 * Provider adapters are responsible for translating their native protocol into
 * this record before it crosses the backend seam.
 *
 * @param {any} candidate
 */
export const normalizeHostedModelDescriptor = candidate => {
  (candidate &&
    typeof candidate === 'object' &&
    Object.keys(candidate).sort().join(',') ===
      'default,defaultReasoningEffort,description,id,reasoningEfforts,title') ||
    Fail`Hosted model descriptor must be a record`;
  const id = /** @type {unknown} */ (candidate.id);
  (typeof id === 'string' && id !== '' && id.length <= 256) ||
    Fail`Hosted model descriptor has an invalid id`;
  const title = candidate.title;
  (typeof title === 'string' && title !== '' && title.length <= 1024) ||
    Fail`Hosted model descriptor has an invalid title`;
  const description = candidate.description;
  (typeof description === 'string' && description.length <= 16_384) ||
    Fail`Hosted model descriptor has an invalid description`;
  const rawEfforts = candidate.reasoningEfforts;
  (Array.isArray(rawEfforts) &&
    rawEfforts.length <= 64 &&
    rawEfforts.every(
      effort =>
        typeof effort === 'string' && effort !== '' && effort.length <= 64,
    ) &&
    new Set(rawEfforts).size === rawEfforts.length) ||
    Fail`Hosted model descriptor has invalid reasoning efforts`;
  typeof candidate.default === 'boolean' ||
    Fail`Hosted model descriptor has an invalid default marker`;
  const defaultReasoningEffort = candidate.defaultReasoningEffort;
  defaultReasoningEffort === null ||
    (typeof defaultReasoningEffort === 'string' &&
      rawEfforts.includes(defaultReasoningEffort)) ||
    Fail`Hosted model descriptor has an invalid default reasoning effort`;
  return harden({
    id,
    title,
    description,
    default: candidate.default,
    defaultReasoningEffort,
    reasoningEfforts: harden([...rawEfforts]),
  });
};
harden(normalizeHostedModelDescriptor);
