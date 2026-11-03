// @ts-check

/**
 * The managed credential every CLI adapter's hosted setup mints: a SecretBlob
 * in the daemon's Secrets manager, delegated to a caplet that issues
 * per-session read grants. The provider key never enters a setup formula's
 * environment; the broker reads it through the delegated facet at request
 * time and the slice never sees it.
 *
 * @module
 */

import { btoa } from 'node:buffer';

import { Fail, b } from '@endo/errors';
import { E } from '@endo/eventual-send';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';

const credentialsModuleSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./managed-credentials-module.js', import.meta.url).href,
  ),
  'managed-credentials',
);

/**
 * Import only on first setup. Never overwrite a UI rotation or resurrect a
 * revoked secret from an old environment variable on daemon startup.
 *
 * The resulting cap delegates only a SecretBlob read capability.
 *
 * @param {any} host
 * @param {{ name: string, apiKey?: string, kind: string, label?: string }} spec
 *   `label` names the provider in messages and the secret's description.
 */
export const provideManagedCredentials = async (
  host,
  { name, apiKey, kind, label = 'Provider' },
) => {
  /^[a-z0-9][a-z0-9-]{0,127}$/.test(name) || Fail`Invalid credential name`;
  (name !== 'secrets' && !name.endsWith('-secret-read')) ||
    Fail`Reserved credential name`;
  ['apiKey', 'oauthToken'].includes(kind) || Fail`Invalid credential kind`;
  const path = ['@pins', 'installations', 'credentials', name];
  await E(host).provideDirectory(path.slice(0, -1));
  const legacy = await E(host).has(name);
  const installed = await E(host).has(...path);
  if (legacy || installed) {
    if (
      legacy &&
      installed &&
      (await E(host).identify(name)) !== (await E(host).identify(...path))
    )
      throw Error('Conflicting managed credential bindings');

    const existing = await E(host).lookup(installed ? path : name);
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
    if (legacy) {
      if (!installed) await E(host).copy([name], path);
      if ((await E(host).identify(name)) !== (await E(host).identify(...path)))
        throw Error('Managed credential migration changed identity');
      await E(host).remove(name);
    }
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
      Fail`${b(label)} secret must first be created in Secrets or supplied during initial setup`;
    const bytes = new TextEncoder().encode(apiKey);
    bytes.length <= 8192 || Fail`${b(label)} credential is too large`;
    const importer = await E(host).lookup(['@secrets', 'create']);
    await E(importer).createBase64(
      name,
      `${label} ${kind}`,
      btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
    );
  }
  // Capture the read capability directly; no temporary root alias is needed.
  await E(host).makeUnconfined('@main', credentialsModuleSpecifier, {
    powersName: ['secrets', name],
    resultName: path,
    env: harden({ CREDENTIALS_KIND: kind, CREDENTIALS_LABEL: label }),
  });
};
harden(provideManagedCredentials);
