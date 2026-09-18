// @ts-check

import { Fail, q } from '@endo/errors';

import { PORTABLE_NAME_PATTERN } from './policy.js';

/**
 * Read host construction policy from a daemon formula, without defaults or
 * number coercion. Runtime acquisition validates directory ownership before
 * touching resources. These are never slice-client options.
 * @param {Record<string, string | undefined>} env
 */
export const readRuntimeConfig = env => {
  /** @param {string} name */
  const required = name => {
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw Fail`Missing runtime configuration ${q(name)}`;
    }
    return value;
  };
  /** @param {string} name */
  const natural = name => {
    const value = required(name);
    /^(0|[1-9][0-9]*)$/.test(value) ||
      Fail`Runtime configuration ${q(name)} must be a decimal natural number`;
    return BigInt(value);
  };
  const directory = required('ENDO_SANDBOX_RUNTIME_DIR');
  const ownerId = required('ENDO_SANDBOX_OWNER_ID');
  PORTABLE_NAME_PATTERN.test(ownerId) ||
    Fail`Invalid runtime owner ${q(ownerId)}`;
  const maxBytes = natural('ENDO_SANDBOX_GENERATED_MAX_BYTES');
  const maxEntries = natural('ENDO_SANDBOX_GENERATED_MAX_ENTRIES');
  maxEntries > 0n || Fail`Runtime generated-file entry budget must be positive`;
  return harden({ directory, ownerId, maxBytes, maxEntries });
};
harden(readRuntimeConfig);
