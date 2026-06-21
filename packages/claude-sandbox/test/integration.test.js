// @ts-nocheck
/* global Buffer, process */
/* eslint-disable import/order, no-await-in-loop */

import '@endo/init';
import test from 'ava';

import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { make as makeSandboxAgent } from '@endo/sandbox';

import {
  makeClaudeClient,
  parseStreamJsonLines,
} from '../src/claude-client.js';

// Podman-gated integration test. Skips gracefully (t.pass) when podman
// is unavailable, not rootless, or the test image is absent — so it is
// a no-op in CI hosts without a container runtime, and real coverage on
// a host that has one (e.g. the DESIGN.md "verified status" setup).
//
// It exercises the layer the unit-test mocks fake: a real @endo/sandbox
// podman slice, a real bind-mounted workspace, and a real process's
// stdout flowing over the @endo/exo-stream wire protocol into
// `parseStreamJsonLines` / `ClaudeClient`.

const ALPINE_REF = 'docker.io/library/alpine:3.19';

const StubMountInterface = M.interface('Mount', {
  help: M.call().returns(M.string()),
  hostPath: M.call().returns(M.string()),
});

/** Run a host-side podman command and capture its stdio. */
const podmanRun = async args => {
  await null;
  return new Promise(resolve => {
    let child;
    try {
      child = nodeSpawn('podman', args, { stdio: 'pipe' });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e.message });
      return;
    }
    const o = [];
    const er = [];
    child.stdout?.on('data', c => o.push(c));
    child.stderr?.on('data', c => er.push(c));
    child.once('error', e =>
      resolve({ code: null, stdout: '', stderr: e.message }),
    );
    child.once('close', code =>
      resolve({
        code,
        stdout: Buffer.concat(o).toString('utf8'),
        stderr: Buffer.concat(er).toString('utf8'),
      }),
    );
  });
};

const probePodman = async () => {
  const version = await podmanRun(['--version']);
  if (version.code !== 0) {
    return {
      available: false,
      reason: `podman --version exit ${version.code}`,
    };
  }
  const rootless = await podmanRun([
    'info',
    '--format',
    '{{.Host.Security.Rootless}}',
  ]);
  if (rootless.code !== 0 || rootless.stdout.trim() !== 'true') {
    return { available: false, reason: 'podman not rootless' };
  }
  const imageExists = await podmanRun(['image', 'exists', ALPINE_REF]);
  return { available: true, imagePresent: imageExists.code === 0 };
};

/** @type {{ available: boolean, imagePresent?: boolean, reason?: string }} */
let podman = { available: false, reason: 'not yet probed' };
/** @type {string[]} */
const tmpdirs = [];

test.before(async () => {
  podman = await probePodman();
});

test.after.always(() => {
  for (const dir of tmpdirs) {
    try {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/**
 * A scratch provider that wraps real host paths as Mount caps, mirroring
 * the daemon's `provideMount` / `provideHostPath` round-trip so a real
 * @endo/sandbox podman slice can bind-mount a host directory.
 */
const makeScratchProvider = () => {
  const capToHostPath = new WeakMap();
  const wrap = hostPath => {
    const cap = makeExo('Mount', StubMountInterface, {
      help: () => `stub Mount @ ${hostPath}`,
      hostPath: () => hostPath,
    });
    capToHostPath.set(cap, hostPath);
    return cap;
  };
  const powers = harden({
    provideScratchMount: async petName => {
      const dir = nodeFs.mkdtempSync(
        nodePath.join(nodeOs.tmpdir(), `claude-sandbox-it-${petName}-`),
      );
      tmpdirs.push(dir);
      return wrap(dir);
    },
    provideHostPath: async cap => {
      const path = capToHostPath.get(cap);
      if (path === undefined) throw new Error('unknown Mount cap');
      return path;
    },
  });
  return { powers, makeMountCapForPath: wrap };
};

const makeWorkspaceDir = () => {
  const dir = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'claude-sandbox-ws-'),
  );
  tmpdirs.push(dir);
  return dir;
};

/** Adapt a slice ProcessHandle's stdout into an AsyncIterable<Uint8Array>. */
const procStdout = proc =>
  harden({
    async *[Symbol.asyncIterator]() {
      const stdoutRef = await E(proc).stdout();
      yield* iterateBytesReader(stdoutRef);
    },
  });

test.serial(
  'a real podman slice streams a workspace file as stream-json into the parser',
  async t => {
    if (!podman.available || !podman.imagePresent) {
      t.pass(`podman or alpine image not available: ${podman.reason ?? ''}`);
      return;
    }

    // A real workspace directory holding two NDJSON lines, projected
    // into the slice at /workspace via a real bind mount.
    const ws = makeWorkspaceDir();
    nodeFs.writeFileSync(
      nodePath.join(ws, 'events.ndjson'),
      '{"type":"system","subtype":"init"}\n{"type":"result","is_error":false}\n',
    );

    const { powers, makeMountCapForPath } = makeScratchProvider();
    const factory = await makeSandboxAgent(powers, null, {});
    const workspaceCap = makeMountCapForPath(ws);

    const slice = await E(factory).make(
      harden({
        rootfs: { kind: 'oci', ref: ALPINE_REF },
        mounts: [{ cap: workspaceCap, innerPath: '/workspace', mode: 'rw' }],
        network: 'none',
        env: {},
        cwd: '/workspace',
        backend: 'podman',
      }),
    );
    t.teardown(() => E(slice).dispose());

    const proc = await E(slice).spawn(
      harden(['/bin/sh', '-c', 'cat /workspace/events.ndjson']),
      harden({ cwd: '/workspace', captureStdout: true, captureStderr: true }),
    );

    const events = [];
    for await (const event of parseStreamJsonLines(procStdout(proc))) {
      events.push(event);
    }
    t.deepEqual(events, [
      { type: 'system', subtype: 'init' },
      { type: 'result', is_error: false },
    ]);
  },
);

test.serial(
  'ClaudeClient drives a real claude in a podman slice (CLAUDE_SANDBOX_TEST_IMAGE)',
  async t => {
    const image = process.env.CLAUDE_SANDBOX_TEST_IMAGE;
    if (!podman.available || !image) {
      t.pass(
        podman.available
          ? 'set CLAUDE_SANDBOX_TEST_IMAGE to a claude-bearing OCI image to run'
          : `podman not available: ${podman.reason ?? ''}`,
      );
      return;
    }

    const ws = makeWorkspaceDir();
    const { powers, makeMountCapForPath } = makeScratchProvider();
    const factory = await makeSandboxAgent(powers, null, {});
    const network = process.env.CLAUDE_SANDBOX_TEST_NETWORK || 'private';

    // Provision a real slice; ClaudeClient owns it through a thunk.
    const client = makeClaudeClient({
      sessionId: 'it-claude',
      createdAt: new Date().toISOString(),
      workspaceMountPoint: ws,
      backend: 'podman',
      provision: async () => {
        const cap = makeMountCapForPath(ws);
        const slice = await E(factory).make(
          harden({
            rootfs: { kind: 'oci', ref: image },
            mounts: [{ cap, innerPath: '/workspace', mode: 'rw' }],
            network,
            env: {},
            cwd: '/workspace',
            backend: 'podman',
          }),
        );
        return { slice };
      },
    });
    t.teardown(() => client.terminate());

    // With no credential, claude emits a valid stream-json sequence and
    // exits non-zero (auth failure) — see DESIGN.md "verified status".
    // We assert only that real stream-json reached the parser.
    const reader = await client.send('Say the single word: hi');
    const events = [];
    for (;;) {
      const { done, value } = await reader.next();
      if (done) break;
      events.push(value);
    }
    t.true(events.length > 0, 'received at least one stream-json event');
    t.true(
      events.every(e => typeof e === 'object' && typeof e.type === 'string'),
      'every event is a typed stream-json record',
    );
  },
);
