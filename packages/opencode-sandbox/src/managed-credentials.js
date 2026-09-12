// @ts-check
import { btoa } from 'node:buffer';

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';

import { toCurrentSpecifier } from './current-specifier.js';

/**
 * Import only on first setup. Never overwrite a UI rotation or resurrect a
 * revoked secret from an old environment variable on daemon startup.
 *
 * The resulting cap delegates only a SecretBlob read capability: the
 * OpenRouter key never enters the setup formula store, and it is materialised
 * once per session incarnation inside the sandbox slice.
 *
 * @param {any} host
 * @param {{ name: string, apiKey?: string, kind: string }} spec
 */
export const provideManagedCredentials = async (
  host,
  { name, apiKey, kind },
) => {
  /^[a-z0-9][a-z0-9-]{0,127}$/.test(name) || Fail`Invalid credential name`;
  (name !== 'secrets' && !name.endsWith('-secret-read')) ||
    Fail`Reserved credential name`;
  ['apiKey', 'oauthToken'].includes(kind) || Fail`Invalid credential kind`;
  if (await E(host).has(name)) {
    const existing = await E(host).lookup(name);
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(existing).__getMethodNames__();
    (methods.includes('storage') &&
      methods.includes('issue') &&
      methods.includes('revoke')) ||
      Fail`Credential name is bound to something that is not a managed credential`;
    (await E(existing).storage()) === 'secrets-manager' ||
      Fail`Unexpected credential storage`;
    (await E(existing).kind()) === kind ||
      Fail`Credential kind changed; configure a new credential name`;
    return;
  }
  const catalog = await E(host).lookup(['@secrets', 'catalog']);
  const entries = await E(catalog).list();
  const entry = entries.find(candidate =>
    candidate.petNamePaths.some(
      p => p.length === 2 && p[0] === 'secrets' && p[1] === name,
    ),
  );
  if (!entry) {
    (typeof apiKey === 'string' && apiKey.length > 0) ||
      Fail`OpenRouter secret must first be created in Secrets or supplied during initial setup`;
    const bytes = new TextEncoder().encode(apiKey);
    bytes.length <= 8192 || Fail`OpenRouter credential is too large`;
    const importer = await E(host).lookup(['@secrets', 'create']);
    await E(importer).createBase64(
      name,
      `OpenRouter ${kind}`,
      btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
    );
  }
  // powersName is a single pet name. The formula captures the read capability,
  // not the alias, so removing this temporary alias does not break
  // reincarnation.
  const temporary = `${name}-secret-read`;
  if (await E(host).has(temporary)) await E(host).remove(temporary);
  try {
    await E(host).copy(['secrets', name], [temporary]);
    if (await E(host).has(name)) await E(host).remove(name);
    await E(host).makeUnconfined(
      '@main',
      toCurrentSpecifier(
        new URL('./managed-credentials-module.js', import.meta.url).href,
      ),
      {
        powersName: temporary,
        resultName: name,
        env: harden({ CREDENTIALS_KIND: kind }),
      },
    );
  } finally {
    await E(host).remove(temporary);
  }
};
harden(provideManagedCredentials);
