// @ts-check
import { spawnSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const result = spawnSync('yarn', ['workspace', '@endo/chat', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) throw Error('Shared web UI build failed');
const destination = new URL(
  '../android/app/src/main/assets/chat/',
  import.meta.url,
);
await rm(destination, { recursive: true, force: true });
await cp(new URL('../../chat/dist/', import.meta.url), destination, {
  recursive: true,
});
