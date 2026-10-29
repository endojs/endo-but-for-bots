// @ts-check
/// <reference types="ses"/>

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/prepare-endo.js';

import {
  normalizeGitRemotePolicy,
  normalizeGitRemoteUrl,
  splitGitCapabilityUrl,
} from '../src/git-remote-policy.js';

const TOKEN = 'tok3n-SECRET-0123456789abcdef';

/**
 * Assert that `thunk` throws and that neither the token nor the whole input
 * appears anywhere in the rejection, including its stack.
 *
 * @param {ExecutionContext} t
 * @param {() => unknown} thunk
 * @param {RegExp} message
 * @param {string} [secret]
 */
const throwsWithoutSecret = (t, thunk, message, secret = TOKEN) => {
  const error = t.throws(thunk, { message });
  t.false(String(error?.message).includes(secret), 'message leaks the token');
  t.false(String(error?.stack).includes(secret), 'stack leaks the token');
};

test('splitGitCapabilityUrl separates a capability URL into endpoint and credential fields', t => {
  const split = splitGitCapabilityUrl(
    `https://x-access-token:${TOKEN}@git.minion.town/p/0123abcd`,
  );
  t.deepEqual(split, {
    url: 'https://git.minion.town/p/0123abcd',
    audience: 'https://git.minion.town',
    username: 'x-access-token',
    password: TOKEN,
  });
  t.true(Object.isFrozen(split));
  t.false(split.url.includes(TOKEN));
  t.false(split.audience.includes(TOKEN));
  // The endpoint is what normalizeGitRemoteUrl accepts unchanged.
  t.is(normalizeGitRemoteUrl(split.url), split.url);
});

test('splitGitCapabilityUrl keeps a non-default port in url and audience', t => {
  t.like(splitGitCapabilityUrl(`https://u:${TOKEN}@127.0.0.1:8443/r.git`), {
    url: 'https://127.0.0.1:8443/r.git',
    audience: 'https://127.0.0.1:8443',
    username: 'u',
  });
});

test('splitGitCapabilityUrl defaults a missing username to x-access-token', t => {
  t.like(splitGitCapabilityUrl(`https://:${TOKEN}@git.minion.town/p`), {
    username: 'x-access-token',
    password: TOKEN,
  });
});

test('splitGitCapabilityUrl percent-decodes userinfo', t => {
  t.like(splitGitCapabilityUrl('https://a%40b:p%2Fq%3A@git.minion.town/p'), {
    username: 'a@b',
    password: 'p/q:',
  });
});

test('splitGitCapabilityUrl rejects a non-https URL without echoing it', t => {
  throwsWithoutSecret(
    t,
    () =>
      splitGitCapabilityUrl(`http://x-access-token:${TOKEN}@git.minion.town/p`),
    /^capabilityUrl is not a valid https URL$/,
  );
  throwsWithoutSecret(
    t,
    () => splitGitCapabilityUrl(`file://x:${TOKEN}@/tmp/repo.git`),
    /^capabilityUrl is not a valid https URL$/,
  );
});

test('splitGitCapabilityUrl rejects an unparseable or non-string input without echoing it', t => {
  throwsWithoutSecret(
    t,
    () => splitGitCapabilityUrl(`not a url ${TOKEN}`),
    /^capabilityUrl is not a valid https URL$/,
  );
  throwsWithoutSecret(
    t,
    () => splitGitCapabilityUrl(`https://x:${TOKEN}@[bad/p`),
    /^capabilityUrl is not a valid https URL$/,
  );
  t.throws(() => splitGitCapabilityUrl(/** @type {any} */ (42)), {
    message: /^capabilityUrl is not a valid https URL$/,
  });
  throwsWithoutSecret(
    t,
    () => splitGitCapabilityUrl(`https://x:%E0%A4%A${TOKEN}@git.minion.town/p`),
    /^capabilityUrl is not a valid https URL$/,
  );
});

test('splitGitCapabilityUrl rejects a URL that carries no token', t => {
  t.throws(() => splitGitCapabilityUrl('https://git.minion.town/p'), {
    message: /^capabilityUrl carries no token$/,
  });
  throwsWithoutSecret(
    t,
    () => splitGitCapabilityUrl(`https://${TOKEN}@git.minion.town/p`),
    /^capabilityUrl carries no token$/,
  );
});

test('splitGitCapabilityUrl rejects line breaks in userinfo without echoing them', t => {
  throwsWithoutSecret(
    t,
    () => splitGitCapabilityUrl(`https://x:${TOKEN}%0A@git.minion.town/p`),
    /^capabilityUrl userinfo must not contain NUL or line breaks$/,
  );
});

// Each of the three normalizeGitRemoteUrl rejection sites, reached directly
// and through normalizeGitRemotePolicy (the path every GitRemoteController
// policy update runs).
const redactionCases = [
  {
    label: 'embedded credentials on https:',
    url: `https://x-access-token:${TOKEN}@git.minion.town/p`,
    message:
      /must not include embedded credentials: "https:\/\/\*\*\*:\*\*\*@git\.minion\.town\/p".*splitGitCapabilityUrl/,
  },
  {
    label: 'username-only userinfo on https:',
    url: `https://${TOKEN}@git.minion.town/p`,
    message:
      /must not include embedded credentials: "https:\/\/\*\*\*@git\.minion\.town\/p"/,
  },
  {
    label: 'token-bearing http: URL (scheme check runs first)',
    url: `http://x-access-token:${TOKEN}@git.minion.town/p`,
    message: /must use https: for the MVP transport, not "http:"$/,
  },
  {
    label: 'scheme-less capability URL (parses with the token in its path)',
    url: `x-access-token:${TOKEN}@git.minion.town/p`,
    message: /must use https: for the MVP transport, not "x-access-token:"$/,
  },
  {
    label: 'unparseable token-bearing string',
    url: `https://x-access-token:${TOKEN}@[not a host/p`,
    message: /^GitRemote policy\.url is not a valid URL$/,
  },
];

for (const { label, url, message } of redactionCases) {
  test(`normalizeGitRemoteUrl redacts the ${label}`, t => {
    throwsWithoutSecret(t, () => normalizeGitRemoteUrl(url), message);
  });
  test(`normalizeGitRemotePolicy redacts the ${label}`, t => {
    throwsWithoutSecret(
      t,
      () =>
        normalizeGitRemotePolicy({
          name: 'origin',
          policy: {
            url,
            allowedDirections: ['fetch'],
            fetchRefspecs: [],
            pushRefspecs: [],
          },
        }),
      message,
    );
  });
}

test('normalizeGitRemoteUrl names the rejected scheme', t => {
  t.throws(() => normalizeGitRemoteUrl('http://github.com/example/repo.git'), {
    message: /must use https: for the MVP transport, not "http:"$/,
  });
});
