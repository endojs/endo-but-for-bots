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
 * @property {LimitInput} [requestTimeoutMs]
 */

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
  requestTimeoutMs = 60_000,
} = {}) =>
  harden({
    crankBudget: String(
      natural('crankBudget', crankBudget, 0xffff_ffff_ffff_ffffn),
    ),
    bootstrapBudget: String(
      natural('bootstrapBudget', bootstrapBudget, 0xffff_ffff_ffff_ffffn),
    ),
    slotCeiling: Number(natural('slotCeiling', slotCeiling, 0xffff_ffffn)),
    chunkCeiling: Number(natural('chunkCeiling', chunkCeiling, 0xffff_ffffn)),
    requestTimeoutMs: Number(
      natural('requestTimeoutMs', requestTimeoutMs, 0x7fff_ffffn),
    ),
  });
harden(makeIronhorseLimits);

/** @param {EnvironmentPowers} environment */
export const readIronhorseLimits = environment =>
  makeIronhorseLimits({
    crankBudget: environment.get('THIXOTROPE_CRANK_BUDGET'),
    bootstrapBudget: environment.get('THIXOTROPE_BOOTSTRAP_BUDGET'),
    slotCeiling: environment.get('THIXOTROPE_SLOT_CEILING'),
    chunkCeiling: environment.get('THIXOTROPE_CHUNK_CEILING'),
    requestTimeoutMs: environment.get('THIXOTROPE_REQUEST_TIMEOUT_MS'),
  });
harden(readIronhorseLimits);
