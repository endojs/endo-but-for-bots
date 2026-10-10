// @ts-check
import test from '@endo/ses-ava/test.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test.serial(
  'stalled view setup cannot retain a closed socket lexical scope',
  async t => {
    t.timeout(5000);
    const controller = new AbortController();
    t.teardown(() => controller.abort());
    const { stdout } = await execute(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(new URL('./_inventory-view-gc.mjs', import.meta.url)),
      ],
      { signal: controller.signal },
    );
    t.is(stdout.trim(), 'released socket; cancelled late subscription');
  },
);
