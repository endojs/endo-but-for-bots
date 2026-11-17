// @ts-check
import harden from '@endo/harden';

/** @import { EnvironmentPowers } from '../platform/environment.js' */
/**
 * @typedef {number | bigint | string} LimitInput
 * @typedef {object} IronhorseLimitOptions
 * @property {LimitInput} [crankBudget]
 * @property {LimitInput} [bootstrapBudget]
 * @property {LimitInput} [slotCeiling]
 * @property {LimitInput} [chunkCeiling]
 * @property {GcPolicyName} [gcPolicy]
 * @property {LimitInput} [gcSlotAllowance]
 * @property {LimitInput} [gcChunkAllowance]
 * @property {LimitInput} [gcCrankInterval]
 * @property {LimitInput} [requestTimeoutMs]
 */

/**
 * When the worker collects garbage. `allocation` (the default) collects
 * after a crank that grew the live slots by `gcSlotAllowance` or the chunk
 * footprint by `gcChunkAllowance` since the last collection, or that is the
 * `gcCrankInterval`th crank since then, and before the image at close; `every-crank` collects after every crank, as every worker
 * did before (kept so a regression can be bisected). See the worker's
 * `GcPolicy` (`rust/thixotrope-ironhorse-worker/src/main.rs`).
 * @typedef {'allocation' | 'every-crank'} GcPolicyName
 */

/** @type {ReadonlyArray<GcPolicyName>} */
const gcPolicyNames = harden(['allocation', 'every-crank']);

/**
 * Parse exact natural quantities at the configuration boundary. Numbers are
 * accepted for the 32-bit profile; wider budgets use bigint or decimal text.
 * @param {string} name
 * @param {LimitInput} value
 * @param {bigint} maximum
 */
const natural = (name, value, maximum) => {
  if (
    (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff)) ||
    (typeof value === 'string' && !/^[0-9]+$/.test(value)) ||
    !['number', 'bigint', 'string'].includes(typeof value)
  ) {
    throw Error(
      `${name} must be a positive integer; use decimal text or bigint for wide values`,
    );
  }
  const amount = BigInt(value);
  if (amount < 1n || amount > maximum)
    throw Error(`${name} must be between 1 and ${maximum}`);
  return amount;
};

/**
 * Computron allowances use decimal text on JSON wires to preserve u64 values.
 * Arena ceilings fit the VM's u32 address spaces; timer delays fit Node's
 * positive signed-32-bit timer range. Zero does not mean unlimited.
 * @param {IronhorseLimitOptions} [options]
 */
export const makeIronhorseLimits = ({
  crankBudget = 10_000_000n,
  bootstrapBudget = 1_000_000_000n,
  slotCeiling = 1_000_000,
  chunkCeiling = 256 * 1024 * 1024,
  gcPolicy = 'allocation',
  gcSlotAllowance = 128 * 1024,
  gcChunkAllowance = 16 * 1024 * 1024,
  gcCrankInterval = 32,
  requestTimeoutMs = 60_000,
} = {}) => {
  const slots = Number(natural('slotCeiling', slotCeiling, 0xffff_ffffn));
  const chunks = Number(natural('chunkCeiling', chunkCeiling, 0xffff_ffffn));
  if (!gcPolicyNames.includes(gcPolicy)) {
    throw Error(`gcPolicy must be one of ${gcPolicyNames.join(', ')}`);
  }
  // An allowance above half its ceiling would collect after every crank;
  // the worker refuses it too.
  const allowance = (
    /** @type {string} */ name,
    /** @type {LimitInput} */ value,
    /** @type {number} */ ceiling,
  ) => {
    const amount = Number(natural(name, value, 0xffff_ffffn));
    if (amount > ceiling / 2)
      throw Error(`${name} must be at most half its ceiling (${ceiling})`);
    return amount;
  };
  return harden({
    crankBudget: String(
      natural('crankBudget', crankBudget, 0xffff_ffff_ffff_ffffn),
    ),
    bootstrapBudget: String(
      natural('bootstrapBudget', bootstrapBudget, 0xffff_ffff_ffff_ffffn),
    ),
    slotCeiling: slots,
    chunkCeiling: chunks,
    gcPolicy,
    gcSlotAllowance: allowance('gcSlotAllowance', gcSlotAllowance, slots),
    gcChunkAllowance: allowance('gcChunkAllowance', gcChunkAllowance, chunks),
    gcCrankInterval: Number(
      natural('gcCrankInterval', gcCrankInterval, 0xffff_ffffn),
    ),
    requestTimeoutMs: Number(
      natural('requestTimeoutMs', requestTimeoutMs, 0x7fff_ffffn),
    ),
  });
};
harden(makeIronhorseLimits);

/**
 * The limits that bound a persisted heap image. The worker restores an image
 * before reapplying these ceilings, and an arena that already exceeds its
 * ceiling refuses every later allocation, so a lower ceiling could brick an
 * existing vat. Budgets meter each crank afresh from the persisted meter index
 * and the watchdog is operational; those may change in either direction.
 * @type {ReadonlyArray<'slotCeiling' | 'chunkCeiling'>}
 */
export const heapCeilingNames = harden(['slotCeiling', 'chunkCeiling']);

/**
 * The limits that decide when a worker collects garbage, and so in which
 * crank a finalizer runs and its outbound leaves the vat. Recovery replays a
 * journal suffix onto the last image and the hub drops replayed outbound by
 * sequence number, so a replay must collect after the same cranks as the
 * incarnation it replaces: these limits never change for a state directory.
 * @type {ReadonlyArray<'gcPolicy' | 'gcSlotAllowance' | 'gcChunkAllowance' | 'gcCrankInterval'>}
 */
export const gcScheduleNames = harden([
  'gcPolicy',
  'gcSlotAllowance',
  'gcChunkAllowance',
  'gcCrankInterval',
]);

/** @param {EnvironmentPowers} environment */
export const readIronhorseLimits = environment =>
  makeIronhorseLimits({
    crankBudget: environment.get('THIXOTROPE_CRANK_BUDGET'),
    bootstrapBudget: environment.get('THIXOTROPE_BOOTSTRAP_BUDGET'),
    slotCeiling: environment.get('THIXOTROPE_SLOT_CEILING'),
    chunkCeiling: environment.get('THIXOTROPE_CHUNK_CEILING'),
    gcPolicy: /** @type {GcPolicyName | undefined} */ (
      environment.get('THIXOTROPE_GC_POLICY')
    ),
    gcSlotAllowance: environment.get('THIXOTROPE_GC_SLOT_ALLOWANCE'),
    gcChunkAllowance: environment.get('THIXOTROPE_GC_CHUNK_ALLOWANCE'),
    gcCrankInterval: environment.get('THIXOTROPE_GC_CRANK_INTERVAL'),
    requestTimeoutMs: environment.get('THIXOTROPE_REQUEST_TIMEOUT_MS'),
  });
harden(readIronhorseLimits);
