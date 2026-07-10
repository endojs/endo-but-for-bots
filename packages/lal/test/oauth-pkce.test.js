import test from '@endo/ses-ava/prepare-endo.js';

import { bytesFromText } from '@endo/bytes/from-string.js';
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generatePkcePair,
} from '../providers/oauth/pkce.js';
import { sha256, getRandomValues } from '../providers/oauth/node-crypto.js';

// RFC 7636 Appendix B golden vector: this verifier hashes to this challenge.
// If the S256 derivation (SHA-256 then base64url-no-pad) ever regresses, this
// exact-equality assertion fails.
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('computeCodeChallenge matches the RFC 7636 Appendix B vector', t => {
  t.is(computeCodeChallenge(RFC7636_VERIFIER, sha256), RFC7636_CHALLENGE);
});

test('generateCodeVerifier yields a 43-char base64url string in the RFC range', t => {
  const verifier = generateCodeVerifier(getRandomValues);
  // 32 bytes base64url-no-pad => 43 chars, within RFC 7636 §4.1's 43..128.
  t.is(verifier.length, 43);
  t.regex(verifier, /^[A-Za-z0-9\-_]+$/u);
});

test('generateCodeVerifier draws from the injected randomness', t => {
  const canned = new Uint8Array(32).fill(0);
  const verifier = generateCodeVerifier(into => {
    into.set(canned);
    return into;
  });
  // 32 zero bytes base64url-encode to 43 'A' characters.
  t.is(verifier, 'A'.repeat(43));
});

test('generatePkcePair pairs a verifier with its own S256 challenge', t => {
  const pair = generatePkcePair({ sha256, getRandomValues });
  t.is(pair.codeChallengeMethod, 'S256');
  t.is(pair.codeChallenge, computeCodeChallenge(pair.codeVerifier, sha256));
});

test('SHA-256 digest length is 32 bytes', t => {
  t.is(sha256(bytesFromText('abc')).length, 32);
});
