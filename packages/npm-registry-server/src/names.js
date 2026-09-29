// @ts-check

import { q } from '@endo/errors';
import { RegistryHttpError } from './errors.js';

const SCOPED_NAME = /^@([a-z0-9][a-z0-9._~-]*)\/([a-z0-9][a-z0-9._~-]*)$/u;
const UNSCOPED_NAME = /^[a-z0-9][a-z0-9._~-]*$/u;
const MAX_NAME_LENGTH = 214;

/**
 * Canonicalize an npm package name taken from a request path or a publish
 * document. npm percent-encodes the scope separator (`@scope%2fname`) while
 * other clients send the slash spelling; both collapse to `@scope/name`.
 * Uppercase, whitespace, and URL-reserved characters are refused rather than
 * normalized, so two spellings can never address one package differently.
 *
 * @param {string} raw
 * @returns {string}
 */
export const canonicalizePackageName = raw => {
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw RegistryHttpError(400, `Invalid package name encoding ${q(raw)}`);
  }
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !(SCOPED_NAME.test(name) || UNSCOPED_NAME.test(name))
  ) {
    throw RegistryHttpError(400, `Invalid package name ${q(name)}`);
  }
  return name;
};
harden(canonicalizePackageName);

/**
 * Encode a canonical package name for a registry URL path segment, in the
 * spelling npm itself uses (`@scope%2fname`).
 *
 * @param {string} name
 * @returns {string}
 */
export const encodePackageName = name => name.replace('/', '%2f');
harden(encodePackageName);

/**
 * The file name npm uses for a version's tarball: the unscoped part of the
 * package name, a hyphen, the version, and `.tgz`.
 *
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export const tarballFileName = (name, version) => {
  const slash = name.indexOf('/');
  const base = slash < 0 ? name : name.slice(slash + 1);
  return `${base}-${version}.tgz`;
};
harden(tarballFileName);

/**
 * Whether a grant's package allowlist covers a canonical name. Entries are
 * exact names or a whole scope spelled `@scope/*`.
 *
 * @param {readonly string[]} allowlist
 * @param {string} name
 * @returns {boolean}
 */
export const allowlistCovers = (allowlist, name) =>
  allowlist.some(entry =>
    entry.endsWith('/*') ? name.startsWith(entry.slice(0, -1)) : entry === name,
  );
harden(allowlistCovers);
