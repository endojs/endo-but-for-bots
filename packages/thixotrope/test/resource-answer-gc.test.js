// @ts-check
import test from '@endo/ses-ava/test.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test.serial(
  'host answer obligations retain their resolver until settlement',
  async t => {
    t.timeout(15_000);
    const controller = new AbortController();
    t.teardown(() => controller.abort());
    const { stdout } = await execute(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(new URL('./_resource-answer-gc.mjs', import.meta.url)),
      ],
      { signal: controller.signal },
    );
    t.regex(
      stdout.trim(),
      /pending resolver retained; settled resolver released; restart rejected$/,
    );
  },
);
