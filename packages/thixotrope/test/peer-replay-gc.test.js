// @ts-check
import test from '@endo/ses-ava/test.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test.serial(
  'journal replay peers do not emit Node finalizer frames',
  async t => {
    t.timeout(15_000);
    const controller = new AbortController();
    t.teardown(() => controller.abort());
    const { stdout } = await execute(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(new URL('./_peer-replay-gc.mjs', import.meta.url)),
      ],
      { signal: controller.signal },
    );
    t.is(stdout.trim(), 'no nondeterministic GC frames; replay answered');
  },
);
