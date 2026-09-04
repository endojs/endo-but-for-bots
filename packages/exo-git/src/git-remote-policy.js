// @ts-check
/// <reference types="ses"/>

import { Fail, q } from '@endo/errors';
import { M, matches, mustMatch } from '@endo/patterns';

/**
 * @import {
 *   GitDirection,
 *   NormalizedRemotePolicy,
 *   RemotePolicy,
 * } from './types.js'
 */

const NonEmptyStringShape = M.and(M.string(), M.gt(''));
const BooleanShape = M.boolean();

const DEFAULT_POLICY = harden(
  /** @type {Omit<NormalizedRemotePolicy, 'url' | 'defaultPullRef'>} */ ({
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
  matches(value, NonEmptyStringShape) ||
    Fail`${fieldName} must be a non-empty string`;
  const stringValue = /** @type {string} */ (value);
  !stringValue.includes('\0') || Fail`${fieldName} must not contain NUL bytes`;
  return stringValue;
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
  try {
    mustMatch(value, BooleanShape);
  } catch {
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
  const arrayValue = Array.isArray(value)
    ? value
    : Fail`${fieldName} must be an array of strings`;
  return arrayValue.map((item, index) =>
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
  parsed.protocol === 'https:' ||
    (allowLocalFileTransport && parsed.protocol === 'file:') ||
    Fail`GitRemote policy.url must use https: for the MVP transport: ${q(urlText)}`;
  !(
    matches(parsed.username, NonEmptyStringShape) ||
    matches(parsed.password, NonEmptyStringShape)
  ) ||
    Fail`GitRemote policy.url must not include embedded credentials: ${q(urlText)}`;
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
  directions.length > 0 ||
    Fail`GitRemote policy.allowedDirections must not be empty`;
  for (const direction of directions) {
    direction === 'fetch' ||
      direction === 'push' ||
      Fail`GitRemote policy.allowedDirections contains invalid direction ${q(direction)}`;
  }
  return harden(/** @type {GitDirection[]} */ ([...new Set(directions)]));
};
harden(normalizeDirections);

/**
 * @param {string} ref
 * @param {string} fieldName
 */
const assertQualifiedRef = (ref, fieldName) => {
  ref.startsWith('refs/') ||
    Fail`${fieldName} must be fully qualified under refs/: ${q(ref)}`;
  !(
    ref.includes('..') ||
    ref.includes('\\') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.includes('@{')
  ) || Fail`${fieldName} contains an invalid git ref: ${q(ref)}`;
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
  !(srcWildcards > 1 || dstWildcards > 1) ||
    Fail`${fieldName} may contain at most one wildcard per side`;
  srcWildcards === dstWildcards ||
    Fail`${fieldName} wildcard source and destination must match: ${q(`${src}:${dst}`)}`;
  !(
    (srcWildcards === 1 && !src.endsWith('/*')) ||
    (dstWildcards === 1 && !dst.endsWith('/*'))
  ) ||
    Fail`${fieldName} wildcards must be rooted under a fixed parent: ${q(`${src}:${dst}`)}`;
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
  (colon >= 0 && body.indexOf(':', colon + 1) < 0) ||
    Fail`${fieldName} must be a single [ + ]<src>:<dst> refspec: ${q(raw)}`;
  const src = body.slice(0, colon);
  const dst = body.slice(colon + 1);
  dst !== '' || Fail`${fieldName} destination must not be empty: ${q(raw)}`;
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
  const requiredPrefix = `refs/remotes/${remoteName}/`;
  dst.startsWith(requiredPrefix) ||
    Fail`${fieldName} destination must stay under ${requiredPrefix}: ${q(dst)}`;
  if (src === '') {
    policy.allowDelete ||
      Fail`${fieldName} deletion requires allowDelete: true`;
    !dst.includes('*') ||
      Fail`${fieldName} deletion refspecs must not use wildcards`;
    return;
  }
  assertQualifiedRef(src, `${fieldName} source`);
  !((isTagRef(src) || isTagRef(dst)) && !policy.allowTags) ||
    Fail`${fieldName} tag refs require allowTags: true`;
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
  !(force && !policy.allowForcePush) ||
    Fail`${fieldName} force-push refspec requires allowForcePush`;
  assertQualifiedRef(dst, `${fieldName} destination`);
  if (src === '') {
    policy.allowDelete ||
      Fail`${fieldName} deletion requires allowDelete: true`;
    !dst.includes('*') ||
      Fail`${fieldName} deletion refspecs must not use wildcards`;
    return;
  }
  assertQualifiedRef(src, `${fieldName} source`);
  src.startsWith('refs/heads/') ||
    src.startsWith('refs/tags/') ||
    Fail`${fieldName} source must be a local branch or tag ref: ${q(src)}`;
  !((isTagRef(src) || isTagRef(dst)) && !policy.allowTags) ||
    Fail`${fieldName} tag refs require allowTags: true`;
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
  !(
    value.startsWith('+') ||
    value.includes(':') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) || Fail`${fieldName} is not a valid branch selector: ${q(value)}`;
  !(value.startsWith('refs/') && !value.startsWith('refs/heads/')) ||
    Fail`${fieldName} must be rooted under refs/heads/`;
  !(value.includes('*') && !value.startsWith('refs/heads/')) ||
    Fail`${fieldName} wildcard branches must be rooted under refs/heads/`;
  const ref = value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;
  assertQualifiedRef(ref, fieldName);
  !(wildcardCount(ref) > 1 || (ref.includes('*') && !ref.endsWith('/*'))) ||
    Fail`${fieldName} wildcard must be rooted under a fixed parent: ${q(value)}`;
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
 * @param {string[]} fetchRefspecs
 * @param {string | undefined} defaultPullRef
 * @returns {{ force: boolean, src: string, dst: string } | undefined}
 */
const selectPullMapping = (fetchRefspecs, defaultPullRef) => {
  const mappings = fetchRefspecs.map(refspec =>
    parseGitRefspec(refspec, 'GitRemote policy.fetchRefspecs[]'),
  );
  if (defaultPullRef === undefined) {
    return mappings.find(
      ({ src, dst }) => src !== '' && !src.includes('*') && !dst.includes('*'),
    );
  }
  const fieldName = 'GitRemote policy.defaultPullRef';
  const ref = requirePolicyString(defaultPullRef, fieldName);
  assertQualifiedRef(ref, fieldName);
  !ref.includes('*') ||
    Fail`${fieldName} must select a concrete fetch refspec source: ${q(ref)}`;
  const matchingMappings = mappings.filter(
    ({ src, dst }) =>
      src === ref && src !== '' && !src.includes('*') && !dst.includes('*'),
  );
  matchingMappings.length > 0 ||
    Fail`${fieldName} does not select a configured concrete fetch refspec: ${q(ref)}`;
  matchingMappings.length === 1 ||
    Fail`${fieldName} is ambiguous across ${matchingMappings.length} configured concrete fetch refspecs: ${q(ref)}`;
  return matchingMappings[0];
};
harden(selectPullMapping);

/**
 * Normalize and validate one Git remote policy without reordering any
 * refspec list. `defaultPullRef`, when present, names the fully qualified
 * source of exactly one concrete fetch refspec.
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
  const derivedPushRefspecs =
    allowedBranches.length > 0
      ? derivePushRefspecsFromBranches(allowedBranches)
      : [];
  // A normalized policy round-trips its derived pushRefspecs back in as
  // `policy.pushRefspecs` on the next mutation (every setter but
  // setAllowedBranches/setPushRefspecs spreads the previous normalized
  // policy verbatim). That echo is not a caller-supplied conflict, so only
  // reject when the explicit pushRefspecs disagree with what allowedBranches
  // would derive.
  !(
    allowedBranches.length > 0 &&
    explicitPushRefspecs.length > 0 &&
    (explicitPushRefspecs.length !== derivedPushRefspecs.length ||
      explicitPushRefspecs.some(
        (refspec, index) => refspec !== derivedPushRefspecs[index],
      ))
  ) ||
    Fail`GitRemote policy must choose allowedBranches or pushRefspecs, not both`;
  const pushRefspecs =
    allowedBranches.length > 0 ? derivedPushRefspecs : explicitPushRefspecs;
  const normalized = harden({
    url,
    allowedDirections,
    fetchRefspecs: harden(fetchRefspecs),
    pushRefspecs: harden(pushRefspecs),
    ...(policy.allowedBranches === undefined
      ? {}
      : { allowedBranches: harden(allowedBranches) }),
    ...(policy.defaultPullRef === undefined
      ? {}
      : {
          defaultPullRef: requirePolicyString(
            policy.defaultPullRef,
            'GitRemote policy.defaultPullRef',
          ),
        }),
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
  !(
    normalized.allowedDirections.includes('push') &&
    normalized.pushRefspecs.length === 0
  ) ||
    Fail`GitRemote policy allows push but has no pushRefspecs or allowedBranches`;
  selectPullMapping(normalized.fetchRefspecs, normalized.defaultPullRef);
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
  !ref.startsWith('-') || Fail`${fieldName} must not start with "-"`;
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

/**
 * Resolve the local fetch destination used by an unqualified pull.
 * An omitted default preserves the legacy first-concrete-refspec rule.
 *
 * @param {NormalizedRemotePolicy} policy
 * @returns {string | undefined}
 */
export const getGitRemotePullDestination = policy =>
  selectPullMapping(policy.fetchRefspecs, policy.defaultPullRef)?.dst;
harden(getGitRemotePullDestination);
