// @ts-check
/* global process */
// Import bootstrap material once; subsequent transport reads use Secrets.
// Keep the credential identity so existing GitRemote capabilities still work.
import { btoa } from 'node:buffer';
import { E } from '@endo/far';

const CREDENTIAL_PATH = harden([
  '@pins',
  'installations',
  'nixos',
  'forgejo-credential',
]);
const SECRET_NAME = 'forgejo-password';

/**
 * @param {any} agent
 * @param {Record<string, string | undefined>} [env]
 */
export const main = async (agent, env = process.env) => {
  const configuredUrl = env.ENDO_FORGEJO_URL || 'http://127.0.0.1:3000';
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw Error('Invalid ENDO_FORGEJO_URL; expected an absolute HTTP(S) URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol))
    throw Error('Invalid ENDO_FORGEJO_URL; expected an absolute HTTP(S) URL.');
  const username = env.ENDO_FORGEJO_USER || 'floot';
  const catalog = await E(agent).lookup(['@secrets', 'catalog']);
  const entries = await E(catalog).list();
  let entry = entries.find(row =>
    row.petNamePaths.some(
      path =>
        path.length === 2 && path[0] === 'secrets' && path[1] === SECRET_NAME,
    ),
  );
  const installed = await E(agent).has('@pins', 'installations');
  const hasOwner =
    installed && (await E(agent).has('@pins', 'installations', 'nixos'));
  const hasCredential = hasOwner && (await E(agent).has(...CREDENTIAL_PATH));
  const hasLegacy = await E(agent).has('forgejo-credential');
  const existingCredential = hasCredential
    ? await E(agent).lookup(CREDENTIAL_PATH)
    : hasLegacy
      ? await E(agent).lookup('forgejo-credential')
      : undefined;
  if (
    hasCredential &&
    hasLegacy &&
    (await E(agent).identify(...CREDENTIAL_PATH)) !==
      (await E(agent).identify('forgejo-credential'))
  )
    throw Error('Conflicting Forgejo credential bindings');
  if (!entry) {
    if (hasCredential)
      throw Error(
        'Installed Forgejo secret is missing; restore it explicitly in Secrets',
      );
    const password = env.ENDO_FORGEJO_FLOOT_PW || '';
    if (!password) return;
    const bytes = new TextEncoder().encode(password);
    if (!bytes.length || bytes.length > 8192 || password.includes('\0'))
      throw Error('Invalid Forgejo bootstrap password');
    const importer = await E(agent).lookup(['@secrets', 'create']);
    try {
      await E(importer).createBase64(
        SECRET_NAME,
        'Forgejo Git password',
        btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
      );
    } finally {
      bytes.fill(0);
    }
    entry = (await E(catalog).list()).find(row =>
      row.petNamePaths.some(
        path =>
          path.length === 2 && path[0] === 'secrets' && path[1] === SECRET_NAME,
      ),
    );
  }
  if (entry?.summary.state !== 'active')
    throw Error('Forgejo secret is revoked or unavailable');
  for (let n = 2; n < CREDENTIAL_PATH.length; n += 1) {
    const path = CREDENTIAL_PATH.slice(0, n);
    // Ancestors must exist before children can be named.
    // eslint-disable-next-line no-await-in-loop
    await E(agent).provideDirectory(path);
  }
  const secret = await E(agent).lookup(['secrets', SECRET_NAME]);
  await E(agent).provideSecretBasicCredential(CREDENTIAL_PATH, {
    audience: url.origin,
    username,
    secret,
    ...(existingCredential === undefined ? {} : { existingCredential }),
  });
  if (hasLegacy) {
    if (
      (await E(agent).identify(...CREDENTIAL_PATH)) !==
      (await E(agent).identify('forgejo-credential'))
    )
      throw Error('Forgejo credential migration changed identity');
    await E(agent).remove('forgejo-credential');
  }
};
harden(main);
