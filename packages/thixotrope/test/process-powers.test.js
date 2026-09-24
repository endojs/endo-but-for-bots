// @ts-check
import test from '@endo/ses-ava/test.js';
import { EventEmitter } from 'node:events';
import { execPath } from 'node:process';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';

import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeProcessPowers } from '../src/platform/node/processes.js';

for (const fd of [0]) {
  for (const operation of ['write', 'end']) {
    test.serial(`input ${fd} ${operation} reports a closed pipe`, async t => {
      t.timeout(5000);
      const { processes } = makeNodePowers();
      const child = processes.spawn(
        execPath,
        [
          '-e',
          `require('node:fs').closeSync(${fd});
           console.log('ready');
           setInterval(() => {}, 1000);`,
        ],
        { stdio: ['pipe', 'pipe', 'inherit', 'pipe'] },
      );
      t.teardown(async () => {
        child.kill('SIGKILL');
        await child.exited;
      });
      const output = child.lines(1)[Symbol.asyncIterator]();
      t.is((await output.next()).value, 'ready');
      const input = child.input(fd);
      t.truthy(input);
      input?.[operation]('payload');
      const error = await child.failed;
      t.regex(error.message, /EPIPE/);
      child.kill('SIGKILL');
      await child.exited;
    });
  }
}

test.serial('process powers preserve normal input and output', async t => {
  t.timeout(5000);
  const child = makeNodePowers().processes.spawn(
    execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  t.teardown(async () => {
    child.kill('SIGKILL');
    await child.exited;
  });
  child.input(0)?.end('hello\n');
  const lines = [];
  for await (const line of child.lines(1)) lines.push(line);
  t.deepEqual(lines, ['hello']);
  t.is(await child.exited, 0);
});

test('readline forwards read failures without throwing in the host', async t => {
  t.timeout(5000);
  const output = new PassThrough();
  t.teardown(() => output.destroy());
  const nativeChild = Object.assign(new EventEmitter(), {
    stdio: [null, output],
    pid: 1,
  });
  const processes = makeProcessPowers({
    childProcess: /** @type {any} */ ({ spawn: () => nativeChild }),
    readline,
  });
  const child = processes.spawn('fixture', [], { stdio: ['ignore', 'pipe'] });
  const iterator = child.lines(1)[Symbol.asyncIterator]();
  const next = iterator.next();
  const failure = Error('readable failure');
  output.destroy(failure);
  t.is(await child.failed, failure);
  await t.throwsAsync(next, { message: 'readable failure' });
});
