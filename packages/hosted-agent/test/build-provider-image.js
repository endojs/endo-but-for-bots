// @ts-check
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';

// Explicit operator command. No build or mutable tag is accepted as runtime
// evidence: deployment must supply the observed resulting immutable digest.
const tag = process.argv[2];
if (!tag || !/^[a-z0-9][a-z0-9._:/-]*$/.test(tag))
  throw Error('Provide a local listener image tag');
const profile = process.argv[3];
if (profile !== undefined && profile !== '--codex-public-network')
  throw Error('Unknown listener image profile');
const directory = await mkdtemp(join(tmpdir(), 'endo-provider-build-'));
try {
  await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          profile === '--codex-public-network'
            ? '../../codex-sandbox/src/provider-worker-entry.js'
            : '../src/provider-worker-entry.js',
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(directory, 'provider-worker.mjs'),
    banner: {
      js: "import { createRequire as __endoCreateRequire } from 'node:module'; const require = __endoCreateRequire(import.meta.url);",
    },
    logLevel: 'silent',
  });
  await copyFile(
    fileURLToPath(new URL('../oci/Containerfile', import.meta.url)),
    join(directory, 'Containerfile'),
  );
  await promisify(execFile)(
    'podman',
    [
      'build',
      '--timestamp=1757376000',
      '--layers=false',
      '--tag',
      tag,
      directory,
    ],
    { timeout: 300_000, maxBuffer: 1024 * 1024 },
  );
  const { stdout } = await promisify(execFile)(
    'podman',
    ['image', 'inspect', '--format', '{{.Digest}}', tag],
    { timeout: 30_000, maxBuffer: 4096 },
  );
  process.stdout.write(stdout);
} finally {
  await rm(directory, { recursive: true, force: true });
}
