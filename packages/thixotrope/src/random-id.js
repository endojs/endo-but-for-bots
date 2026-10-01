// @ts-check
import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';

/** @import { RandomPowers } from './platform/random.js' */

/**
 * 128 random bits as lowercase hex: worker ids, swissnums, allocation keys,
 * and transient session keys all use this one shape, so there is one place
 * that says how wide an unguessable identifier is.
 *
 * @param {RandomPowers} random
 */
export const randomHex128 = random => encodeHex(random.randomBytes(16));
harden(randomHex128);

/**
 * Matches exactly what `randomHex128` produces. Hardened, so it must never
 * gain the `g` or `y` flag: `test` would then try to write `lastIndex`.
 */
export const HEX128_PATTERN = /^[0-9a-f]{32}$/;
harden(HEX128_PATTERN);
