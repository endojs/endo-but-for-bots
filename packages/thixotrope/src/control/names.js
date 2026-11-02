// @ts-check
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

/**
 * What the supervisor accepts as a workspace name; the registry, shipped by
 * source, checks the same shape.
 */
export const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
harden(WORKSPACE_NAME_PATTERN);

/**
 * @param {unknown} name
 * @returns {asserts name is string}
 */
export const assertWorkspaceName = name => {
  (typeof name === 'string' && WORKSPACE_NAME_PATTERN.test(name)) ||
    Fail`Expected a workspace name: letters, digits, dot, dash and underscore, 64 at most, starting with a letter or digit, got ${q(name)}`;
};
harden(assertWorkspaceName);

/**
 * An installation's name, which is the inventory name its value takes.
 * @param {unknown} name
 * @returns {asserts name is string}
 */
export const assertInstallationName = name => {
  (typeof name === 'string' && name.length > 0) ||
    Fail`Expected an installation name`;
};
harden(assertInstallationName);
