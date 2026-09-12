// @ts-check
import { atob } from 'node:buffer';

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const Credentials = M.interface('OpencodeCredentials', {
  kind: M.call().returns(M.string()),
  storage: M.call().returns(M.string()),
  issue: M.call(M.string()).returns(M.promise()),
  revoke: M.call(M.string()).returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
const Issued = M.interface('IssuedCredential', {
  materialise: M.call().returns(M.promise()),
  sessionTag: M.call().returns(M.string()),
});

const MAX_GRANTS = 128;

/**
 * Only a SecretBlob is delegated here, never the catalog or mutation
 * authority. Existing containers have already received their token; manager
 * revocation prevents subsequent materialisations, not use of bytes already
 * delivered.
 *
 * @param {any} secret
 * @param {unknown} _context
 * @param {{ env?: { CREDENTIALS_KIND?: string } }} [wrapper]
 */
export const make = (secret, _context, wrapper = {}) => {
  const kind = wrapper.env?.CREDENTIALS_KIND || 'apiKey';
  ['apiKey', 'oauthToken'].includes(kind) || Fail`Invalid credential kind`;
  const grants = new Set();
  return makeExo('OpencodeCredentials', Credentials, {
    kind: () => kind,
    storage: () => 'secrets-manager',
    async issue(tag) {
      grants.size < MAX_GRANTS || Fail`Too many outstanding credential grants`;
      const grant = { tag, valid: true };
      grants.add(grant);
      let consumed = false;
      return makeExo('IssuedCredential', Issued, {
        sessionTag: () => tag,
        async materialise() {
          grant.valid || Fail`Credential grant revoked`;
          !consumed || Fail`Credential grant is single-shot`;
          // Fail-closed: a transient read failure still burns the grant rather
          // than allowing a retry, matching the upstream credential contract.
          consumed = true;
          try {
            const encoded = await E(secret).readBase64();
            grant.valid || Fail`Credential grant revoked`;
            let token;
            try {
              const bytes = Uint8Array.from(atob(encoded), ch =>
                ch.charCodeAt(0),
              );
              (bytes.length > 0 && bytes.length <= 8192) ||
                Fail`Invalid credential size`;
              token = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              throw Error(
                'OpenRouter secret must contain a non-empty UTF-8 token of at most 8192 bytes',
              );
            }
            return token;
          } finally {
            grants.delete(grant);
          }
        },
      });
    },
    async revoke(tag) {
      for (const grant of grants) {
        if (grant.tag === tag) {
          grant.valid = false;
          grants.delete(grant);
        }
      }
    },
    help: () =>
      'OpenRouter credentials backed by Secrets. Rotate or revoke the token in the Secrets manager. Session grants are single-shot.',
  });
};
harden(make);
