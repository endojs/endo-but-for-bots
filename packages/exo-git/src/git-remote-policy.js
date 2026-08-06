// @ts-check
/// <reference types="ses"/>

import { q } from '@endo/errors';

/**
 * @import {
 *   GitDirection,
 *   NormalizedRemotePolicy,
 *   RemotePolicy,
 * } from './types.js'
 */

const DEFAULT_POLICY = harden(
  /** @type {Omit<NormalizedRemotePolicy, 'url'>} */ ({
    allowedDirections: harden(['fetch']),
    fetchRefspecs: harden([]),
    pushRefspecs: harden([]),
    allowForcePush: false,
    allowTags: false,
    allowDelete: false,
    allowLocalFileTransport: false,
  }),
);

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
const requirePolicyString = (value, fieldName) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new Error(`${fieldName} must not contain NUL bytes`);
  }
  return value;
};
harden(requirePolicyString);

/**
 * Coerce-free read of a policy or request flag.
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} fieldName
 * @returns {boolean}
 */
export const requireGitRemoteBoolean = (value, fallback, fieldName) => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean: ${q(value)}`);
  }
  return value;
};
harden(requireGitRemoteBoolean);

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string[]}
 */
const requirePolicyStringArray = (value, fieldName) => {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return value.map((item, index) =>
    requirePolicyString(item, `${fieldName}[${index}]`),
  );
};
harden(requirePolicyStringArray);

/**
 * @param {unknown} value
 * @param {boolean} [allowLocalFileTransport]
 * @returns {string}
 */
export const normalizeGitRemoteUrl = (
  value,
  allowLocalFileTransport = false,
) => {
  const urlText = requirePolicyString(value, 'GitRemote policy.url');
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new Error(`GitRemote policy.url is not a valid URL: ${q(urlText)}`);
  }
  if (
    parsed.protocol !== 'https:' &&
    !(allowLocalFileTransport && parsed.protocol === 'file:')
  ) {
    throw new Error(
      `GitRemote policy.url must use https: for the MVP transport: ${q(urlText)}`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `GitRemote policy.url must not include embedded credentials: ${q(urlText)}`,
    );
  }
  return urlText;
};
harden(normalizeGitRemoteUrl);

/**
 * @param {unknown} value
 * @returns {GitDirection[]}
 */
const normalizeDirections = value => {
  const directions = requirePolicyStringArray(
    value || DEFAULT_POLICY.allowedDirections,
    'GitRemote policy.allowedDirections',
  );
  if (directions.length === 0) {
    throw new Error('GitRemote policy.allowedDirections must not be empty');
  }
  for (const direction of directions) {
    if (direction !== 'fetch' && direction !== 'push') {
      throw new Error(
        `GitRemote policy.allowedDirections contains invalid direction ${q(direction)}`,
      );
    }
  }
  return harden(/** @type {GitDirection[]} */ ([...new Set(directions)]));
};
harden(normalizeDirections);

/**
 * @param {string} ref
 * @param {string} fieldName
 */
const assertQualifiedRef = (ref, fieldName) => {
  if (!ref.startsWith('refs/')) {
    throw new Error(
      `${fieldName} must be fully qualified under refs/: ${q(ref)}`,
    );
  }
  if (
    ref.includes('..') ||
    ref.includes('\\') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.includes('@{')
  ) {
    throw new Error(`${fieldName} contains an invalid git ref: ${q(ref)}`);
  }
};
harden(assertQualifiedRef);

/** @param {string} ref */
const isTagRef = ref => ref.startsWith('refs/tags/');
harden(isTagRef);

/** @param {string} ref */
const wildcardCount = ref => [...ref].filter(ch => ch === '*').length;
harden(wildcardCount);

/**
 * @param {string} src
 * @param {string} dst
 * @param {string} fieldName
 */
const assertWildcardShape = (src, dst, fieldName) => {
  const srcWildcards = wildcardCount(src);
  const dstWildcards = wildcardCount(dst);
  if (srcWildcards > 1 || dstWildcards > 1) {
    throw new Error(`${fieldName} may contain at most one wildcard per side`);
  }
  if (srcWildcards !== dstWildcards) {
    throw new Error(
      `${fieldName} wildcard source and destination must match: ${q(`${src}:${dst}`)}`,
    );
  }
  if (
    (srcWildcards === 1 && !src.endsWith('/*')) ||
    (dstWildcards === 1 && !dst.endsWith('/*'))
  ) {
    throw new Error(
      `${fieldName} wildcards must be rooted under a fixed parent: ${q(`${src}:${dst}`)}`,
    );
  }
};
harden(assertWildcardShape);

/**
 * @param {string} refspec
 * @param {string} fieldName
 * @returns {{ force: boolean, src: string, dst: string }}
 */
export const parseGitRefspec = (refspec, fieldName) => {
  const raw = requirePolicyString(refspec, fieldName);
  const force = raw.startsWith('+');
  const body = force ? raw.slice(1) : raw;
  const colon = body.indexOf(':');
  if (colon < 0 || body.indexOf(':', colon + 1) >= 0) {
    throw new Error(
      `${fieldName} must be a single [ + ]<src>:<dst> refspec: ${q(raw)}`,
    );
  }
  const src = body.slice(0, colon);
  const dst = body.slice(colon + 1);
  if (dst === '') {
    throw new Error(`${fieldName} destination must not be empty: ${q(raw)}`);
  }
  return harden({ force, src, dst });
};
harden(parseGitRefspec);

/**
 * @param {string} refspec
 * @param {NormalizedRemotePolicy} policy
 * @param {string} remoteName
 * @param {string} fieldName
 */
const validateFetchRefspec = (refspec, policy, remoteName, fieldName) => {
  const { src, dst } = parseGitRefspec(refspec, fieldName);
  assertQualifiedRef(dst, `${fieldName} destination`);
  if (!dst.startsWith(`refs/remotes/${remoteName}/`)) {
    throw new Error(
      `${fieldName} destination must stay under refs/remotes/${remoteName}/: ${q(dst)}`,
    );
  }
  if (src === '') {
    if (!policy.allowDelete) {
      throw new Error(`${fieldName} deletion requires allowDelete: true`);
    }
    if (dst.includes('*')) {
      throw new Error(`${fieldName} deletion refspecs must not use wildcards`);
    }
    return;
  }
  assertQualifiedRef(src, `${fieldName} source`);
  if ((isTagRef(src) || isTagRef(dst)) && !policy.allowTags) {
    throw new Error(`${fieldName} tag refs require allowTags: true`);
  }
  assertWildcardShape(src, dst, fieldName);
};
harden(validateFetchRefspec);

/**
 * @param {string} refspec
 * @param {NormalizedRemotePolicy} policy
 * @param {string} fieldName
 */
export const validateGitPushRefspec = (refspec, policy, fieldName) => {
  const { force, src, dst } = parseGitRefspec(refspec, fieldName);
  if (force && !policy.allowForcePush) {
    throw new Error(`${fieldName} force-push refspec requires allowForcePush`);
  }
  assertQualifiedRef(dst, `${fieldName} destination`);
  if (src === '') {
    if (!policy.allowDelete) {
      throw new Error(`${fieldName} deletion requires allowDelete: true`);
    }
    if (dst.includes('*')) {
      throw new Error(`${fieldName} deletion refspecs must not use wildcards`);
    }
    return;
  }
  assertQualifiedRef(src, `${fieldName} source`);
  if (!src.startsWith('refs/heads/') && !src.startsWith('refs/tags/')) {
    throw new Error(
      `${fieldName} source must be a local branch or tag ref: ${q(src)}`,
    );
  }
  if ((isTagRef(src) || isTagRef(dst)) && !policy.allowTags) {
    throw new Error(`${fieldName} tag refs require allowTags: true`);
  }
  assertWildcardShape(src, dst, fieldName);
};
harden(validateGitPushRefspec);

/**
 * @param {string} branch
 * @param {string} fieldName
 * @returns {string}
 */
const branchRefFromAllowedBranch = (branch, fieldName) => {
  const value = requirePolicyString(branch, fieldName);
  if (
    value.startsWith('+') ||
    value.includes(':') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new Error(`${fieldName} is not a valid branch selector: ${q(value)}`);
  }
  if (value.startsWith('refs/') && !value.startsWith('refs/heads/')) {
    throw new Error(`${fieldName} must be rooted under refs/heads/`);
  }
  if (value.includes('*') && !value.startsWith('refs/heads/')) {
    throw new Error(
      `${fieldName} wildcard branches must be rooted under refs/heads/`,
    );
  }
  const ref = value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;
  assertQualifiedRef(ref, fieldName);
  if (wildcardCount(ref) > 1 || (ref.includes('*') && !ref.endsWith('/*'))) {
    throw new Error(
      `${fieldName} wildcard must be rooted under a fixed parent: ${q(value)}`,
    );
  }
  return ref;
};
harden(branchRefFromAllowedBranch);

/**
 * @param {string[]} branches
 * @returns {string[]}
 */
const derivePushRefspecsFromBranches = branches =>
  branches.map((branch, index) => {
    const ref = branchRefFromAllowedBranch(
      branch,
      `GitRemote policy.allowedBranches[${index}]`,
    );
    return `${ref}:${ref}`;
  });
harden(derivePushRefspecsFromBranches);

/**
 * Normalize and validate one Git remote policy without reordering any
 * refspec list.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {RemotePolicy} args.policy
 * @returns {NormalizedRemotePolicy}
 */
export const normalizeGitRemotePolicy = ({ name, policy }) => {
  const allowLocalFileTransport = requireGitRemoteBoolean(
    policy.allowLocalFileTransport,
    DEFAULT_POLICY.allowLocalFileTransport,
    'GitRemote policy.allowLocalFileTransport',
  );
  const url = normalizeGitRemoteUrl(policy.url, allowLocalFileTransport);
  const allowedDirections = normalizeDirections(policy.allowedDirections);
  const fetchRefspecs = requirePolicyStringArray(
    policy.fetchRefspecs || DEFAULT_POLICY.fetchRefspecs,
    'GitRemote policy.fetchRefspecs',
  );
  const explicitPushRefspecs = requirePolicyStringArray(
    policy.pushRefspecs || DEFAULT_POLICY.pushRefspecs,
    'GitRemote policy.pushRefspecs',
  );
  const allowedBranches =
    policy.allowedBranches === undefined
      ? []
      : requirePolicyStringArray(
          policy.allowedBranches,
          'GitRemote policy.allowedBranches',
        );
  if (allowedBranches.length > 0 && explicitPushRefspecs.length > 0) {
    throw new Error(
      'GitRemote policy must choose allowedBranches or pushRefspecs, not both',
    );
  }
  const pushRefspecs =
    allowedBranches.length > 0
      ? derivePushRefspecsFromBranches(allowedBranches)
      : explicitPushRefspecs;
  const normalized = harden({
    url,
    allowedDirections,
    fetchRefspecs: harden(fetchRefspecs),
    pushRefspecs: harden(pushRefspecs),
    allowForcePush: requireGitRemoteBoolean(
      policy.allowForcePush,
      DEFAULT_POLICY.allowForcePush,
      'GitRemote policy.allowForcePush',
    ),
    allowTags: requireGitRemoteBoolean(
      policy.allowTags,
      DEFAULT_POLICY.allowTags,
      'GitRemote policy.allowTags',
    ),
    allowDelete: requireGitRemoteBoolean(
      policy.allowDelete,
      DEFAULT_POLICY.allowDelete,
      'GitRemote policy.allowDelete',
    ),
    allowLocalFileTransport,
  });
  for (const [index, refspec] of normalized.fetchRefspecs.entries()) {
    validateFetchRefspec(
      refspec,
      normalized,
      name,
      `GitRemote policy.fetchRefspecs[${index}]`,
    );
  }
  for (const [index, refspec] of normalized.pushRefspecs.entries()) {
    validateGitPushRefspec(
      refspec,
      normalized,
      `GitRemote policy.pushRefspecs[${index}]`,
    );
  }
  if (
    normalized.allowedDirections.includes('push') &&
    normalized.pushRefspecs.length === 0
  ) {
    throw new Error(
      'GitRemote policy allows push but has no pushRefspecs or allowedBranches',
    );
  }
  return normalized;
};
harden(normalizeGitRemotePolicy);

/**
 * Normalize a caller-supplied ref to a full local branch ref.
 *
 * @param {unknown} value
 * @param {string} fieldName
 */
export const normalizeGitRef = (value, fieldName) => {
  const raw =
    typeof value === 'string'
      ? value
      : /** @type {{ name?: unknown }} */ (value || {}).name;
  const ref = requirePolicyString(raw, fieldName);
  if (ref.startsWith('-')) {
    throw new Error(`${fieldName} must not start with "-"`);
  }
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
};
harden(normalizeGitRef);

/**
 * @param {string} ref
 * @param {string} pattern
 * @returns {string | undefined}
 */
export const captureGitRefPattern = (ref, pattern) => {
  if (!pattern.includes('*')) {
    return ref === pattern ? '' : undefined;
  }
  const [prefix, suffix] = pattern.split('*');
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) {
    return undefined;
  }
  return ref.slice(
    prefix.length,
    suffix.length === 0 ? undefined : -suffix.length,
  );
};
harden(captureGitRefPattern);

/**
 * @param {{ src: string, dst: string }} parsed
 * @param {{ src: string, dst: string }} policyRefspec
 */
export const gitRefspecMatchesPattern = (parsed, policyRefspec) => {
  const srcCapture = captureGitRefPattern(parsed.src, policyRefspec.src);
  if (srcCapture === undefined) {
    return false;
  }
  const dstCapture = captureGitRefPattern(parsed.dst, policyRefspec.dst);
  if (dstCapture === undefined) {
    return false;
  }
  const policyHasWildcard =
    policyRefspec.src.includes('*') || policyRefspec.dst.includes('*');
  return !policyHasWildcard || srcCapture === dstCapture;
};
harden(gitRefspecMatchesPattern);
