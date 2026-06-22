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
import { main as provisionCredentials } from '../credentials.js';

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

// The per-session powers `evaluate` resolves `sandbox-factory` / `fs-mounter`
// eagerly (caps-by-reference) under the factory's directory, so they must
// exist before a session is created. The real flow mints them in setup-host.js;
// here we mint trivial stubs (setup-host.js mints the real ones; status()/the
// unname path never call them).
const mintStub = (host, resultPath) =>
  E(host).evaluate(
    '@main',
    `Far('stub', { help: () => 'stub' })`,
    harden([]),
    harden([]),
    resultPath,
  );

// provisionFactory creates the `claude-sandbox/` directory; the factory caplet
// runs with SANDBOX_NAMESPACE='claude-sandbox', so the infra it endows lives at
// claude-sandbox/{sandbox-factory,fs-mounter}.
const provisionSandboxDeps = async host => {
  await mintStub(host, ['claude-sandbox', 'sandbox-factory']);
  await mintStub(host, ['claude-sandbox', 'fs-mounter']);
};

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

test.serial(
  'provisioning nests under directories, keeps the host root clean, and is idempotent',
  async t => {
    t.timeout(120_000);
    const { host } = await prepareHost(t, 'nesting');

    await provisionFactory(host);

    // The factory's objects (controller + guest agent/handle) landed inside
    // the directory — proving the post-makeUnconfined `move`s ran.
    for (const name of ['controller', 'profile', 'handle']) {
      // eslint-disable-next-line no-await-in-loop
      const present = await E(host).has('claude-sandbox', name);
      t.true(present, `claude-sandbox/${name} exists`);
    }

    // The host root is clean: no temp names left over from the move dance,
    // and none of the pre-nesting top-level names.
    const root = await E(host).list();
    for (const n of [
      'claude-sandbox-guest',
      'claude-sandbox-agent',
      'controller-for-claude-sandbox-factory',
      'profile-for-claude-sandbox-factory',
    ]) {
      t.false(
        root.includes(n),
        `host root polluted with ${n}: ${root.join(', ')}`,
      );
    }
    t.true(root.includes('claude-sandbox'), 'the directory itself is at root');

    // A readme value documents the directory's objects + sharing security.
    const readme = await E(host).lookup(['claude-sandbox', 'readme']);
    t.is(typeof readme, 'string');
    t.regex(readme, /controller/);
    t.regex(readme, /NEVER share/);

    // Idempotent: a second run is a no-op (no throw, same controller, no dup).
    const c1 = await E(host).lookup(['claude-sandbox', 'controller']);
    await t.notThrowsAsync(() => provisionFactory(host));
    const c2 = await E(host).lookup(['claude-sandbox', 'controller']);
    t.is(c1, c2, 'no duplicate controller on re-run');

    // The credentials provisioner nests into its own directory the same way.
    await provisionCredentials(host);
    for (const name of ['controller', 'profile', 'handle']) {
      // eslint-disable-next-line no-await-in-loop
      const present = await E(host).has('claude-credentials', name);
      t.true(present, `claude-credentials/${name} exists`);
    }
    const root2 = await E(host).list();
    t.false(
      root2.includes('claude-credentials-guest'),
      'no credentials temp residue at root',
    );
    const credReadme = await E(host).lookup(['claude-credentials', 'readme']);
    t.regex(credReadme, /never leaves this peer/i);
  },
);

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

    // Provision the factory on @host (creates the `claude-sandbox/` dir with
    // its controller + guest profile/handle).
    await provisionFactory(host);
    await provisionSandboxDeps(host);
    const factory = await E(host).lookup(['claude-sandbox', 'controller']);
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
    await provisionSandboxDeps(host);

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

test.serial(
  'createSession builds per-session powers, unnames it, and leaves no residue',
  async t => {
    t.timeout(120_000);
    const { host } = await prepareHost(t, 'powers');

    const workspaceDir = path.join(dirname, 'tmp', 'powers', 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    await E(host).makeUnconfined('@main', nodeFsModuleHref, {
      resultName: 'project-fs',
      env: harden({ ENDO_FS_ROOT: workspaceDir }),
    });
    await provisionFactory(host);
    await provisionSandboxDeps(host);
    const factory = await E(host).lookup(['claude-sandbox', 'controller']);

    const client = await E(factory).createSession(
      harden({
        name: 'live-1',
        filesystem: 'project-fs',
        rootfs: 'oci:docker.io/library/alpine:3.19',
        network: 'private',
      }),
    );

    // The client is alive — `status()` resolves across CapTP — even though
    // its per-session powers cap was unnamed immediately after
    // `makeUnconfined`. That proves the make-unconfined `powers` dependency
    // edge keeps the powers formula reachable for the client's lifetime
    // (otherwise the unname would have collected powers and cancelled the
    // client via thisDiesIfThatDies).
    const status = await E(client).status();
    t.is(status.terminated, false);

    // No per-session `*-powers` pet name lingers in the host petstore, and no
    // shared `sandbox-powers` exists (that earlier design was replaced). So
    // the peer-rooted session adds zero host-petstore residue.
    const names = await E(host).list();
    t.false(
      names.some(n => n.endsWith('-powers')),
      `no per-session powers residue; saw: ${names.join(', ')}`,
    );
    t.false(await E(host).has('sandbox-powers'));
  },
);

test.serial(
  'concurrent createSession calls each get distinct powers and leave no residue',
  async t => {
    t.timeout(120_000);
    const { host } = await prepareHost(t, 'concurrent');

    const workspaceDir = path.join(dirname, 'tmp', 'concurrent', 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    await E(host).makeUnconfined('@main', nodeFsModuleHref, {
      resultName: 'project-fs',
      env: harden({ ENDO_FS_ROOT: workspaceDir }),
    });
    await provisionFactory(host);
    await provisionSandboxDeps(host);
    const factory = await E(host).lookup(['claude-sandbox', 'controller']);

    // Two sessions formulated concurrently. Each builds its own per-session
    // powers (unique name from the monotonic counter), names it, references
    // it from its client, then unnames it — all interleaved. If the unname
    // raced (shared name, or remove before the client edge), one client
    // would be dead or a `*-powers` name would survive.
    const [a, b] = await Promise.all([
      E(factory).createSession(
        harden({
          name: 'conc-a',
          filesystem: 'project-fs',
          rootfs: 'oci:docker.io/library/alpine:3.19',
          network: 'private',
        }),
      ),
      E(factory).createSession(
        harden({
          name: 'conc-b',
          filesystem: 'project-fs',
          rootfs: 'oci:docker.io/library/alpine:3.19',
          network: 'private',
        }),
      ),
    ]);

    // Both clients are alive with distinct session ids.
    const [sa, sb] = await Promise.all([E(a).status(), E(b).status()]);
    t.regex(sa.sessionId, /^conc-a-/);
    t.regex(sb.sessionId, /^conc-b-/);
    t.not(sa.sessionId, sb.sessionId);
    t.is(sa.terminated, false);
    t.is(sb.terminated, false);

    // Neither concurrent unname left a residue.
    const names = await E(host).list();
    t.false(
      names.some(n => n.endsWith('-powers')),
      `no per-session powers residue after concurrent creates; saw: ${names.join(', ')}`,
    );
  },
);
