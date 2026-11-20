// Diagnostic-only stock operator prefix and forwarded-mail window.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const parent = process.env.THIX_FORWARD_OUTPUT_PARENT ?? os.tmpdir();
const dir = await mkdtemp(path.join(parent, 'mail-forward-probe-'));
await writeFile(path.join(dir, 'forward-probe'), '', { mode: 0o600 });
process.env.THIX_HARNESS_FORWARD_PROBE_DIR = dir;
process.env.THIX_MAIL_FORWARD_TRACE = path.join(dir, 'forward-worker.jsonl');
console.log(JSON.stringify({ type: 'forward-trace', directory: dir }));
try {
  await import('./mail.perf.mjs');
} finally {
  if (!process.env.KEEP_STATE && !process.env.THIX_FORWARD_OUTPUT_PARENT) {
    await rm(dir, { recursive: true, force: true });
  }
}
