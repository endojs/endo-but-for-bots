// @ts-check
import { Fail, q } from '@endo/errors';

/** @param {string} provider */
export const assertProviderKind = provider => {
  provider === 'anthropic' ||
    provider === 'openrouter' ||
    Fail`Unsupported Floot provider ${q(provider)}`;
};
harden(assertProviderKind);
