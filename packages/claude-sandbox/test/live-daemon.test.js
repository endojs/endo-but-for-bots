// @ts-nocheck
/* global setTimeout */
/* eslint-disable import/order */

import '@endo/init/debug.js';
import test from 'ava';

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';

import { E } from '@endo/far';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';

import { main as provisionFactory } from '../factory.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));

// The shipped Node-backed Filesystem caplet; minted under a host pet name
// so `createSession` can resolve it by name exactly as the form path does.
const nodeFsModuleHref = pathToFileURL(
  path.join(
    dirname,
    '..',
    '..',
    'platform',
    'src',
    'fs',
    'extended',
    'node-fs-module.js',
  ),
).href;

const makeConfig = name => ({
  statePath: path.join(dirname, 'tmp', name, 'state'),
  ephemeralStatePath: path.join(dirname, 'tmp', name, 'run'),
  cachePath: path.join(dirname, 'tmp', name, 'cache'),
  // The daemon's Unix domain socket path must stay under the ~108-char
  // sun_path limit. Under the repo checkout the per-test path
  // (…/packages/claude-sandbox/test/tmp/<name>/endo.sock) overruns it on
  // CI's long runner path for longer <name>s, so anchor the socket in the
  // OS temp dir with a short random name instead.
  sockPath: path.join(
    os.tmpdir(),
    `endo-cs-${randomBytes(6).toString('hex')}.sock`,
  ),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
});

const prepareHost = async (t, name) => {
  let cancel;
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  cancelled.catch(() => {});
  const config = makeConfig(name);
  await purge(config);
  await start(config);
  t.teardown(async () => {
    await stop(config).catch(() => {});
    cancel(new Error('teardown'));
    try {
      rmSync(path.join(dirname, 'tmp', name), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  const { getBootstrap } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();
  return { host, config, cancelled };
};

test.serial('daemon boots and the host responds', async t => {
  t.timeout(60_000);
  const { host } = await prepareHost(t, 'probe');
  const names = await E(host).list();
  t.true(Array.isArray(names));
});

test.serial(
  'createSession formulates a real ClaudeClient with daemon identity',
  async t => {
    t.timeout(120_000);
    const { host } = await prepareHost(t, 'create-session');

    // A real workspace directory exposed as a first-class Filesystem cap,
    // exactly as DEMO.md step 2 does it.
    const workspaceDir = path.join(
      dirname,
      'tmp',
      'create-session',
      'workspace',
    );
    mkdirSync(workspaceDir, { recursive: true });
    await E(host).makeUnconfined('@main', nodeFsModuleHref, {
      resultName: 'project-fs',
      env: harden({ ENDO_FS_ROOT: workspaceDir }),
    });
    t.true(await E(host).has('project-fs'), 'filesystem cap is stored');

    // Provision the factory on @host (mints the guest profile + the
    // `controller-for-claude-sandbox-factory` exo).
    await provisionFactory(host);
    const factory = await E(host).lookup(
      'controller-for-claude-sandbox-factory',
    );
    t.truthy(factory, 'factory controller resolves');

    // Peer-callable path: returns the ClaudeClient cap without naming it on
    // the host. Validates the #1 formula-identity fix end-to-end — the
    // client is a real formulated cap, not a worker-local remotable.
    const client = await E(factory).createSession(
      harden({
        name: 'live-1',
        filesystem: 'project-fs',
        rootfs: 'oci:docker.io/library/alpine:3.19',
        network: 'private',
      }),
    );

    // `status()` does not provision (no podman/9p needed), so it exercises
    // the formula across the CapTP boundary without standing up a container.
    const status = await E(client).status();
    t.regex(status.sessionId, /^live-1-/, 'session id derives from the name');
    t.is(status.backend, 'podman');
    t.is(status.terminated, false);
    t.is(status.conversationStarted, false);

    // It is *not* stored under a host pet name — the caller's retention is
    // the only GC root (DESIGN.md § Lifecycle).
    t.false(await E(host).has('live-1'), 'createSession does not name on host');

    // The method surface matches the ClaudeClient interface guard.
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(client).__getMethodNames__();
    for (const name of ['send', 'interrupt', 'terminate', 'status', 'help']) {
      t.true(methods.includes(name), `ClaudeClient exposes ${name}()`);
    }

    // terminate() is a no-op when nothing was provisioned (never sent), so
    // it must resolve without a container/mount and flip `terminated`.
    await E(client).terminate();
    const after = await E(client).status();
    t.is(after.terminated, true);
  },
);

test.serial(
  'the @host form path stores a ClaudeClient under its pet name',
  async t => {
    t.timeout(120_000);
    const { host } = await prepareHost(t, 'form-path');

    const workspaceDir = path.join(dirname, 'tmp', 'form-path', 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    await E(host).makeUnconfined('@main', nodeFsModuleHref, {
      resultName: 'project-fs',
      env: harden({ ENDO_FS_ROOT: workspaceDir }),
    });

    await provisionFactory(host);

    // Drive the form the way the operator does: the factory posts a "Create
    // Claude Sandbox" form into @host's inbox; submitting it formulates the
    // session under the chosen pet name. `runFactory` posts the form in the
    // background after the controller resolves, so poll for it.
    const findForm = async () => {
      const messages = await E(host).listMessages();
      return messages.find(
        m => m.type === 'form' && m.description === 'Create Claude Sandbox',
      );
    };
    let form;
    const formDeadline = Date.now() + 20_000;
    while (Date.now() < formDeadline) {
      // eslint-disable-next-line no-await-in-loop
      form = await findForm();
      if (form) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    t.truthy(form, 'factory posted a form to @host');

    await E(host).submit(
      form.number,
      harden({
        name: 'form-client',
        filesystem: 'project-fs',
        rootfs: 'oci:docker.io/library/alpine:3.19',
        network: 'private',
        model: '',
        credentials: '',
        initialPrompt: '',
      }),
    );

    // The factory's inbox loop processes the reply asynchronously; poll for
    // the resulting pet name rather than racing it.
    const deadline = Date.now() + 30_000;
    let stored = false;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if (await E(host).has('form-client')) {
        stored = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    t.true(stored, 'submission stored the ClaudeClient under its pet name');

    const client = await E(host).lookup('form-client');
    const status = await E(client).status();
    t.regex(status.sessionId, /^form-client-/);
    t.is(status.terminated, false);

    // Host-rooted: removing the pet name fires the whenCancelled teardown.
    await E(host).remove('form-client');
    t.false(await E(host).has('form-client'), 'remove deletes the formula');
  },
);
