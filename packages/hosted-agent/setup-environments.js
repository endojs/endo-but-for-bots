// @ts-check
/* global process */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';
import { makePodmanHostEnvironment } from '@endo/sandbox/podman-host-environment.js';
import {
  prepareRuntimeEnv,
  providePrivateDirectory,
  readProvisionedEnvironment,
  assertNoRuntimeLeftovers,
} from './src/hosted-setup.js';
import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './src/current-specifier.js';

const specifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./src/environment-runner.js', import.meta.url).href,
  ),
  'Environment runner',
);

/** Host-only provisioning. Persist construction policy, never ambient credentials.
 * @param {any} host
 * @param {Record<string,string|undefined>} [env]
 */
export const main = async (host, env = process.env) => {
  const namePath = ['environments', 'runner'];
  const required = key => {
    env[key] || Fail`Missing environment setup configuration ${key}`;
    return /** @type {string} */ (env[key]);
  };
  const roots = {
    stateRoot: required('ENDO_ENVIRONMENT_STATE_ROOT'),
    networkDirectory: required('ENDO_ENVIRONMENT_NETWORK_DIR'),
  };
  for (const root of Object.values(roots)) {
    (path.isAbsolute(root) && root !== '/' && path.normalize(root) === root) ||
      Fail`Environment storage directories must be normalized absolute non-root paths`;
  }
  const image = required('ENDO_ENVIRONMENT_IMAGE_REF');
  const listener = required('ENDO_ENVIRONMENT_LISTENER_IMAGE_REF');
  PINNED_IMAGE_REFERENCE_PATTERN.test(image) ||
    Fail`Environment image must be digest-pinned`;
  PINNED_IMAGE_REFERENCE_PATTERN.test(listener) ||
    Fail`Environment listener must be digest-pinned`;
  const ceiling = required('ENDO_ENVIRONMENT_PUBLIC_INTERNET');
  ['0', '1'].includes(ceiling) || Fail`Invalid environment network ceiling`;
  const identity = await E(host).identify('@agent');
  const ownerId = `environment-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
  const runtime = await prepareRuntimeEnv(
    env,
    ownerId,
    roots,
    'Environment runner',
  );
  const nativeEnv = {
    ...makePodmanHostEnvironment(env),
    ...runtime,
    ENDO_ENVIRONMENT_IMAGE_REF: image,
    ENDO_ENVIRONMENT_LISTENER_IMAGE_REF: listener,
    ENDO_ENVIRONMENT_STATE_ROOT: roots.stateRoot,
    ENDO_ENVIRONMENT_NETWORK_DIR: roots.networkDirectory,
    ENDO_ENVIRONMENT_PUBLIC_INTERNET: ceiling,
  };
  for (const key of [
    'ENDO_NINEP_SUDO',
    'ENDO_NINEP_MOUNT_PROGRAM',
    'ENDO_NINEP_UMOUNT_PROGRAM',
  ]) {
    if (env[key]) nativeEnv[key] = env[key];
  }
  if ((await E(host).has('environments')) && (await E(host).has(...namePath))) {
    const retained = await readProvisionedEnvironment(host, {
      label: 'Environment runner',
      namePath,
      expectedSpecifier: specifier,
    });
    for (const key of Object.keys(nativeEnv).filter(name =>
      name.startsWith('ENDO_'),
    )) {
      retained.env[key] === nativeEnv[key] ||
        Fail`Environment runner configuration changed at ${key}; stop and retire its retained owner before replacing it`;
    }
    // Also refuse removal of a recorded construction setting.
    for (const key of Object.keys(retained.env).filter(name =>
      name.startsWith('ENDO_'),
    )) {
      retained.env[key] === nativeEnv[key] ||
        Fail`Environment runner configuration changed at ${key}; stop and retire its retained owner before replacing it`;
    }
    return;
  }
  await assertNoRuntimeLeftovers(runtime.ENDO_SANDBOX_RUNTIME_DIR, ownerId);
  await providePrivateDirectory('Environment storage', roots.stateRoot);
  await providePrivateDirectory('Environment network', roots.networkDirectory);
  if (!(await E(host).has('environments')))
    await E(host).makeDirectory(['environments']);
  const temporary = 'environment.null-powers';
  if (await E(host).has(temporary)) await E(host).remove(temporary);
  await E(host).storeValue(null, temporary);
  try {
    await E(host).makeUnconfined('@main', specifier, {
      powersName: temporary,
      resultName: namePath,
      env: harden(nativeEnv),
    });
  } finally {
    await E(host).remove(temporary);
  }
};
harden(main);
