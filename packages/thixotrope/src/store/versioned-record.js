// @ts-check
import harden from '@endo/harden';

/**
 * The one check a versioned record on disk makes of its version, with the
 * two refusals every such record composes: one from a newer build, which
 * this build cannot serve, and one older or malformed, which needs
 * migration or a fresh state directory. A record this build wrote is the
 * supported version, and passes.
 * @param {string} what the record, as a message names it
 * @param {unknown} version what the record says
 * @param {number} supported what this build writes
 */
export const assertRecordVersion = (what, version, supported) => {
  if (typeof version === 'number' && version > supported)
    throw Error(
      `A newer build wrote the ${what}: version ${version} exceeds supported version ${supported}; use that build or migrate to a fresh state directory`,
    );
  if (version !== supported)
    throw Error(
      `Incompatible ${what}: this build requires version ${supported}; migrate or use a fresh state directory`,
    );
};
harden(assertRecordVersion);
