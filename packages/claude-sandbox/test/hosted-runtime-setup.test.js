// @ts-check
import '@endo/init';
import test from 'ava';
import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  brokerServiceSpecifier,
  prepareNativeRuntimeEnv,
  readBrokerService,
  resolvePinnedImageRef,
} from '../src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());
const digest = `sha256:${'a'.repeat(64)}`;

/** @param {import('ava').ExecutionContext} t */
const makeTmp = async t => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'claude-setup-')),
  );
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('resolvePinnedImageRef pins tags and accepts already-pinned digests', async t => {
  /** @type {string[][]} */
  const inspected = [];
  const exec = async (file, args) => {
    inspected.push([file, ...args]);
    return { stdout: `${digest}\n` };
  };
  t.deepEqual(
    await resolvePinnedImageRef(`oci:localhost/claude@${digest}`, exec),
    { imageRef: `localhost/claude@${digest}`, imageDigest: digest },
  );
  t.deepEqual(inspected, [], 'a pinned reference is never inspected');
  t.deepEqual(
    await resolvePinnedImageRef('oci:localhost/claude:latest', exec),
    // The tag is resolved AWAY: `name:tag@digest` is a reference the native
    // runtime refuses, so the pin drops the tag it was found under.
    { imageRef: `localhost/claude@${digest}`, imageDigest: digest },
  );
  t.deepEqual(inspected, [
    [
      'podman',
      'image',
      'inspect',
      '--format',
      '{{.Digest}}',
      'localhost/claude:latest',
    ],
  ]);
  await t.throwsAsync(
    resolvePinnedImageRef('oci:localhost/claude@sha256:abc', exec),
    { message: /digest is invalid/ },
  );
  await t.throwsAsync(resolvePinnedImageRef('oci:-rm', exec), {
    message: /Invalid Claude sandbox image/,
  });
  await t.throwsAsync(
    resolvePinnedImageRef('oci:localhost/claude:latest', async () => ({
      stdout: 'nope\n',
    })),
    { message: /Cannot resolve a digest/ },
  );
});

test('the native runtime owns the runtime directory itself under a derived label', async t => {
  const tmp = await makeTmp(t);
  const runtime = path.join(tmp, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const roots = {
    workspaceDir: path.join(tmp, 'ws'),
    mcpDir: path.join(tmp, 'mcp'),
    stateDir: path.join(tmp, 'state'),
  };
  const env = {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  };
  const nativeEnv = await prepareNativeRuntimeEnv(env, 'claude-abc', roots);
  t.deepEqual(nativeEnv, {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_SANDBOX_OWNER_ID: 'claude-abc-native',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
  // Idempotent: nothing is created inside the directory.
  t.deepEqual(
    await prepareNativeRuntimeEnv(env, 'claude-abc', roots),
    nativeEnv,
  );
  // A leftover under the native label refuses; the marker is untouched.
  const marker = path.join(runtime, 'claude-abc-native.owner');
  await symlink('endo-sandbox-owner-v1-stale', marker);
  await t.throwsAsync(prepareNativeRuntimeEnv(env, 'claude-abc', roots), {
    message: /still holds .*claude-abc-native\.owner"/,
  });
  t.is(await readlink(marker), 'endo-sandbox-owner-v1-stale');
  await rm(marker);
  // A guest root inside the runtime directory refuses.
  await t.throwsAsync(
    prepareNativeRuntimeEnv(env, 'claude-abc', {
      ...roots,
      mcpDir: path.join(runtime, 'mcp'),
    }),
    { message: /disjoint from Claude guest storage roots/ },
  );
  // A runtime directory spelled through a symlink persists as its canonical
  // path: the runtime's ownership markers land in one directory only.
  const other = path.join(tmp, 'other-runtime');
  await symlink(runtime, other);
  t.deepEqual(
    await prepareNativeRuntimeEnv(
      { ...env, ENDO_SANDBOX_RUNTIME_DIR: other },
      'claude-abc',
      roots,
    ),
    nativeEnv,
  );
  // A non-private runtime directory refuses.
  await chmod(runtime, 0o755);
  await t.throwsAsync(prepareNativeRuntimeEnv(env, 'claude-abc', roots), {
    message: /must be private/,
  });
});

test('the broker service is read by its verified entrypoint with its persisted profile', async t => {
  const config = {
    ownerId: 'claude-broker',
    directory: '/srv/broker',
    imageRef: `localhost/claude@${digest}`,
    imageDigest: digest,
    listenerImageRef: `localhost/listener@sha256:${'c'.repeat(64)}`,
    models: ['claude-sonnet-4-6'],
    credentialKind: 'oauthToken',
  };
  const bindings = new Map([
    [key('claude-sandbox', 'broker-service'), 'broker-id'],
    [key('claude-sandbox', 'other'), 'other-id'],
  ]);
  const environments = new Map([
    ['broker-id', harden({ CLAUDE_BROKER_CONFIG: JSON.stringify(config) })],
    ['other-id', harden({})],
  ]);
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ (
      harden({
        async identify(...parts) {
          return bindings.get(key(...parts));
        },
        async diagnostics() {
          return harden({
            getFormula: async id =>
              harden({
                type: 'make-unconfined',
                properties: {
                  specifier: {
                    kind: 'literal',
                    value:
                      id === 'broker-id'
                        ? brokerServiceSpecifier
                        : 'file:///generic.js',
                  },
                },
              }),
          });
        },
        async getFormulaEnvironment(id) {
          return environments.get(id);
        },
      })
    )
  );
  t.deepEqual(await readBrokerService(host), {
    identifier: 'broker-id',
    config,
  });
  // A persisted profile with an unknown credential kind is refused: no plan
  // could record it.
  environments.set(
    'broker-id',
    harden({
      CLAUDE_BROKER_CONFIG: JSON.stringify({ ...config, credentialKind: 'x' }),
    }),
  );
  await t.throwsAsync(readBrokerService(host), {
    message: /Invalid Claude broker configuration/,
  });
  // A persisted beta list the broker grant would refuse is refused at
  // construction rather than at every session.
  environments.set(
    'broker-id',
    harden({
      CLAUDE_BROKER_CONFIG: JSON.stringify({
        ...config,
        anthropicBeta: 'oauth-2025-04-20, x',
      }),
    }),
  );
  await t.throwsAsync(readBrokerService(host), {
    message: /Invalid Claude broker configuration: anthropicBeta/,
  });
  bindings.set(key('claude-sandbox', 'broker-service'), 'other-id');
  await t.throwsAsync(readBrokerService(host), {
    message: /Claude broker-service has an unsupported entrypoint/,
  });
  bindings.delete(key('claude-sandbox', 'broker-service'));
  await t.throwsAsync(readBrokerService(host), {
    message: /Cannot identify Claude "broker-service"/,
  });
});
