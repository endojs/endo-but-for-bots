// @ts-check
import { decodeBase64 } from '@endo/base64';
import { strictDecodeUtf8 } from '@endo/utf8/strict-decode.js';

/**
 * A transport-only adapter. Material is read for each operation, never retained
 * in its formula or cached across operations. Secret errors never carry bytes.
 * @param {object} options
 * @param {string} options.audience
 * @param {string} options.username
 * @param {any} options.secretSource
 * @param {boolean} [options.revoked]
 * @param {() => Promise<void>} options.onRevoke
 * @returns {import('@endo/exo-git/src/git-credential.js').GitCredentialRecord}
 */
export const makeSecretGitCredentialSource = ({
  audience,
  username,
  secretSource,
  revoked = false,
  onRevoke,
}) => {
  const listeners = new Set();
  const active = () => !revoked && secretSource.state().active;
  return harden({
    kind: 'basic',
    audience,
    getVersion: () => secretSource.state().version * 2n + (revoked ? 1n : 0n),
    isRevoked: () => !active(),
    getMaterial: async () => {
      if (!active()) return harden({ unavailable: true });
      let bytes;
      try {
        const before = secretSource.state().version;
        const { base64 } = await secretSource.read();
        bytes = decodeBase64(base64);
        if (
          !active() ||
          secretSource.state().version !== before ||
          bytes.length === 0 ||
          bytes.length > 8192
        )
          throw Error('Secret unavailable');
        const password = strictDecodeUtf8(bytes);
        if (password.includes('\0')) throw Error('Invalid credential');
        return harden({ username, password });
      } catch {
        return harden({ unavailable: true });
      } finally {
        bytes?.fill(0);
      }
    },
    watchChange: listener => {
      listeners.add(listener);
      const unwatch = secretSource.watch(listener);
      return harden(() => {
        listeners.delete(listener);
        unwatch();
      });
    },
    rotate: () => {
      throw Error('Rotate this credential in Secrets Manager');
    },
    revoke: async () => {
      await onRevoke();
      revoked = true;
      for (const listener of listeners) listener();
    },
  });
};
harden(makeSecretGitCredentialSource);
