// @ts-check

/**
 * A credential source yields the bearer for exactly one credential. A backend
 * is made over one source (§ One backend instance per credential), so nothing
 * in a request can name another principal's credential.
 */

/**
 * Decision 5, interim: a root-only file. Present so a deployment without the
 * daemon secret manager (minion.town today) can run the probe.
 *
 * gap: see PR body, Gap 3. The design says no deployment keeps a credential
 * in a file of its own.
 *
 * @param {object} powers
 * @param {(path: string) => Promise<string>} powers.readFile
 * @param {string} powers.path
 * @param {string} powers.credentialId
 */
export const makeFileCredentialSource = ({ readFile, path, credentialId }) =>
  harden({
    credentialId,
    read: async () => (await readFile(path)).trim(),
  });
harden(makeFileCredentialSource);

/**
 * Decision 5: a `SecretBlob` read facet from the daemon secret manager, read
 * fresh per turn. `credentialId` is the secret's `secretId`, never the bytes.
 *
 * @param {object} powers
 * @param {{ readBase64: () => Promise<string> }} powers.blob
 * @param {string} powers.credentialId
 */
export const makeSecretBlobCredentialSource = ({ blob, credentialId }) =>
  harden({
    credentialId,
    read: async () => {
      const base64 = await blob.readBase64();
      return new TextDecoder().decode(
        Uint8Array.from(atob(base64), c => c.charCodeAt(0)),
      );
    },
  });
harden(makeSecretBlobCredentialSource);
