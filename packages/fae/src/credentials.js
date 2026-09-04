// @ts-check

import { decodeBase64 } from '@endo/base64/decode.js';
import { encodeBase64 } from '@endo/base64/encode.js';
import { Fail, X, makeError, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { strictDecodeUtf8 } from '@endo/utf8/strict-decode.js';

/**
 * Pet name, in an agent's own namespace, of the `SecretBlob` holding the
 * provider auth token. The name is a convention; the *capability* is what
 * carries the authority, and it is delegated explicitly at provisioning time.
 */
export const AUTH_SECRET_PETNAME = 'llm-auth-secret';

/**
 * The daemon's `SecretImporter` bounds a secret at 64 KiB; a provider token is
 * far smaller, and a value near that bound is a configuration mistake rather
 * than a credential.
 */
const MAX_TOKEN_LENGTH = 8192;

/**
 * Encode a provider token for `SecretImporter.createBase64`.
 *
 * Base64 is the wire envelope the secret manager uses because `Uint8Array` is
 * mutable and therefore not passable; the stored bytes are the token's UTF-8
 * encoding.
 *
 * @param {string} token
 * @returns {string}
 */
export const encodeAuthToken = token => {
  (typeof token === 'string' && token !== '') ||
    Fail`Provider auth token must be a non-empty string`;
  // Bound the *bytes*, which is what `readAuthToken` bounds and what the secret
  // manager stores. `String.length` counts UTF-16 code units, so a token of
  // non-ASCII characters could pass here and then be rejected on every read —
  // written once and unreadable forever.
  const bytes = encodeUtf8(token);
  bytes.length <= MAX_TOKEN_LENGTH ||
    Fail`Provider auth token must encode to at most ${q(MAX_TOKEN_LENGTH)} bytes`;
  return encodeBase64(bytes);
};
harden(encodeAuthToken);

/**
 * Read a provider auth token out of a `SecretBlob`.
 *
 * Nothing here echoes the token: a decode failure reports the shape of the
 * problem, never the bytes. A revoked secret rejects, which is the point —
 * revocation must stop the next turn, not merely the next provisioning.
 *
 * @param {any} blob - A `SecretBlob` capability.
 * @returns {Promise<string>}
 */
export const readAuthToken = async blob => {
  const base64 = await E(blob).readBase64();
  typeof base64 === 'string' ||
    Fail`Secret blob returned a non-string payload of type ${q(typeof base64)}`;
  /** @type {Uint8Array} */
  let bytes;
  try {
    bytes = decodeBase64(base64);
  } catch {
    throw Error('Secret blob payload is not valid base64');
  }
  bytes.length > 0 || Fail`Secret blob holds no bytes`;
  bytes.length <= MAX_TOKEN_LENGTH ||
    Fail`Secret blob holds more than ${q(MAX_TOKEN_LENGTH)} bytes; it is not a provider token`;
  /** @type {string} */
  let token;
  try {
    // Strict, so malformed bytes fail here and say so, rather than decoding to
    // replacement characters and failing much later as an authentication error
    // nobody can trace back to the secret.
    token = strictDecodeUtf8(bytes);
  } catch {
    throw Error('Secret blob does not hold UTF-8 text');
  } finally {
    // Zero the intermediate copy. The daemon does the same for its own
    // buffers; the decoded string is immutable and cannot be zeroed, which is
    // why the token is read per provider construction rather than kept beyond
    // the life of the provider presenting it.
    bytes.fill(0);
  }
  token !== '' || Fail`Secret blob holds an empty provider token`;
  return token;
};
harden(readAuthToken);

/** Pet names whose plaintext-fallback warning has already been printed. */
const warnedPetNames = new Set();

/**
 * Resolve the auth token a provider should use.
 *
 * A `SecretBlob` endowed under `AUTH_SECRET_PETNAME` wins: it is durable,
 * auditable, replaceable without re-provisioning, and revocable. A token
 * carried inline in the provider config is the pre-secret-manager arrangement
 * and is still honoured so an existing deployment keeps working, but it is
 * plaintext in the pet store and cannot be rotated or revoked.
 *
 * Read this on every provider construction rather than caching it: a rotated
 * secret keeps the same capability, so a held token is a stale token. The
 * token a provider is currently presenting is necessarily retained for as long
 * as that provider lives; what must not happen is holding it past that.
 *
 * @param {object} options
 * @param {any} options.powers - The namespace that may hold the secret.
 * @param {{ authToken?: string }} [options.config] - Provider config.
 * @param {string} [options.petName]
 * @returns {Promise<string>}
 */
export const resolveAuthToken = async ({
  powers,
  config = {},
  petName = AUTH_SECRET_PETNAME,
}) => {
  await null;
  if (await E(powers).has(petName)) {
    return readAuthToken(await E(powers).lookup(petName));
  }
  const inline = config.authToken;
  if (typeof inline === 'string' && inline !== '') {
    // Once, not once per turn: this is now on the per-turn path, and a
    // deployment that has not migrated would otherwise emit the same line for
    // every message it ever answers.
    if (!warnedPetNames.has(petName)) {
      warnedPetNames.add(petName);
      console.error(
        `[credentials] no ${petName} capability; using the plaintext token in the provider config. Re-run setup to move it into @secrets.`,
      );
    }
    return inline;
  }
  return '';
};
harden(resolveAuthToken);

/**
 * Whether `secrets/<name>` names something.
 *
 * Asked directly, this throws on a daemon that has never held a secret: `has`
 * on a two-segment path looks the prefix up first, and the `secrets` directory
 * is created lazily, by the first `createBase64`. The question "is there a
 * secret by this name" must answer *no* there, not fail — a caller that treats
 * the failure as "the secret manager is unavailable" downgrades to a plaintext
 * token on exactly the daemon where the manager would have worked.
 *
 * @param {object} options
 * @param {any} options.hostAgent
 * @param {string} options.name
 * @returns {Promise<boolean>}
 */
export const hasAuthSecret = async ({ hostAgent, name }) => {
  await null;
  if (!(await E(hostAgent).has('secrets'))) return false;
  try {
    return await E(hostAgent).has('secrets', name);
  } catch (error) {
    // `secrets` is an ordinary mutable pet name and may have been bound to
    // something that is not a directory. Say that, rather than let a caller
    // read a generic failure as "the secret manager is unavailable here" and
    // downgrade to a plaintext token on a daemon that does carry `@secrets`.
    throw makeError(
      X`Pet name ${q('secrets')} does not name a directory, so ${q(`secrets/${name}`)} cannot be resolved; rename or remove it`,
      Error,
      { cause: /** @type {Error} */ (error) },
    );
  }
};
harden(hasAuthSecret);

/**
 * Bind a provider token to a daemon-managed secret and return a locator for the
 * `SecretBlob`, creating the record on first run and replacing its bytes on
 * every run after that.
 *
 * `createBase64` always mints a *new* record and rebinds the pet name to it, so
 * a setup script that called it twice would orphan the first record in the
 * catalog and strand every capability already delegated from it. Replacing
 * through the catalog's admin facet keeps one record, one audit history, and
 * one identity — which is the whole point of holding the token behind a
 * capability rather than a value.
 *
 * `@secrets` is carried only by the daemon's root host, so this fails on a
 * child host. A caller that can still function with a plaintext token should
 * catch and say so rather than silently downgrading.
 *
 * @param {object} options
 * @param {any} options.hostAgent - An agent carrying `@secrets`.
 * @param {string} options.name - Pet name under `secrets/`.
 * @param {string} options.description - Non-secret, human-readable label.
 * @param {string} options.token
 * @returns {Promise<{ secretName: string, locator: string, created: boolean }>}
 */
export const provideAuthSecret = async ({
  hostAgent,
  name,
  description,
  token,
}) => {
  const payload = encodeAuthToken(token);
  await null;
  const existing = await hasAuthSecret({ hostAgent, name });
  let created = false;
  if (existing) {
    const catalog = await E(hostAgent).lookup(['@secrets', 'catalog']);
    const entries = await E(catalog).list();
    const entry = (Array.isArray(entries) ? entries : []).find(candidate =>
      (candidate.petNamePaths || []).some(
        path =>
          Array.isArray(path) &&
          path.length === 2 &&
          path[0] === 'secrets' &&
          path[1] === name,
      ),
    );
    entry ||
      Fail`Pet name ${q(`secrets/${name}`)} is bound to something the secret catalog does not administer`;
    await E(entry.admin).replaceBase64(payload);
    await E(entry.admin).setDescription(description);
  } else {
    const importer = await E(hostAgent).lookup(['@secrets', 'create']);
    await E(importer).createBase64(name, description, payload);
    created = true;
  }
  const locator = await E(hostAgent).locate('secrets', name);
  typeof locator === 'string' ||
    Fail`Secret ${q(name)} was provisioned but could not be located`;
  return harden({
    secretName: name,
    locator: /** @type {string} */ (locator),
    created,
  });
};
harden(provideAuthSecret);
