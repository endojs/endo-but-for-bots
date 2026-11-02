// @ts-check
import test from 'ava';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../oci/dev/build.sh', import.meta.url));
const digest = `sha256:${'a'.repeat(64)}`;

test('all CLI runtime overlays use the shared base, without extra apt installs', async t => {
  const overlays = await Promise.all(
    ['claude', 'codex', 'opencode'].map(backend =>
      readFile(
        new URL(`../../${backend}-sandbox/oci/Containerfile`, import.meta.url),
        'utf8',
      ),
    ),
  );
  for (const text of overlays) {
    t.true(text.includes(`ARG ENDO_DEV_IMAGE\nFROM \${ENDO_DEV_IMAGE}`));
    t.false(text.includes('apt-get'));
  }
  const base = await readFile(
    new URL('../oci/dev/Containerfile', import.meta.url),
    'utf8',
  );
  t.true(base.includes('node:22.23.2-bookworm-slim@sha256:48e4b67d'));
  t.true(base.includes('20260920T000000Z'));
  for (const tool of [
    'curl',
    'git',
    'ripgrep',
    'build-essential',
    'python3-pip',
    'python3-venv',
    'openssl',
    'tar',
  ]) {
    t.true(base.includes(tool));
  }
});

test('shared builder rejects mutable overrides before invoking the engine', async t => {
  await t.throwsAsync(
    exec('sh', [script], {
      env: {
        ...process.env,
        ENDO_DEV_IMAGE: 'localhost/dev:latest',
        ENGINE: '/does-not-exist',
      },
    }),
    { message: /must be an immutable/ },
  );
});

test('shared builder normalizes bare Podman IDs, supports reuse, and rejects platform mismatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'endo-dev-image-test-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const engine = join(directory, 'engine');
  await writeFile(
    engine,
    `#!/bin/sh\nset -eu\n[ "$1 $2" = 'image inspect' ]\ncase "$4" in\n  '{{.Os}}/{{.Architecture}}') printf '%s\\n' "$TEST_PLATFORM" ;;\n  '{{.Id}}') printf '%s\\n' '${digest.slice(7)}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    ENGINE: engine,
    ENDO_DEV_IMAGE: digest,
    TEST_PLATFORM: 'linux/amd64',
  };
  const { stdout } = await exec('sh', [script], { env });
  t.is(stdout, `${digest}\n`);
  const reused = await exec('sh', [script], {
    env: { ...env, ENDO_DEV_IMAGE: stdout.trim() },
  });
  t.is(reused.stdout, stdout);
  await t.throwsAsync(exec('sh', [script, 'linux/arm64'], { env }), {
    message: /platform mismatch/,
  });
});

test('the Docker base build omits Podman-only flags and keeps stdout machine-readable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'endo-dev-docker-test-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const engine = join(directory, 'docker');
  await writeFile(
    engine,
    `#!/bin/sh\nset -eu\ncase "$1" in\n build)\n  for arg in "$@"; do\n   case "$arg" in --layers*|--timestamp*) exit 4 ;; esac\n  done\n  echo 'build output' ;;\n image)\n  case "$4" in\n   '{{.Os}}/{{.Architecture}}') echo linux/amd64 ;;\n   '{{.Id}}') echo '${digest}' ;;\n   *) exit 1 ;;\n  esac ;;\n *) exit 1 ;;\nesac\n`,
    { mode: 0o700 },
  );
  const { stdout, stderr } = await exec('sh', [script], {
    env: { ...process.env, ENGINE: engine, ENDO_DEV_IMAGE: '' },
  });
  t.is(stdout, `${digest}\n`);
  t.true(stderr.includes('build output'));
  const overlays = [
    '../../claude-sandbox/oci/build.sh',
    '../../codex-sandbox/oci/build-reproducible.sh',
  ];
  const results = await Promise.all(
    overlays.map(path =>
      exec('sh', [fileURLToPath(new URL(path, import.meta.url))], {
        env: { ...process.env, ENGINE: engine, ENDO_DEV_IMAGE: digest },
      }),
    ),
  );
  for (const result of results) t.true(result.stdout.includes('build output'));
});
