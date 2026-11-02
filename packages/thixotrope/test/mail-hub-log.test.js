// @ts-check
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { makeMailHubLog } from '../scripts/mail-hub-log.mjs';
import { makeNodePowers } from '../src/platform/node/powers.js';

const files = makeNodePowers().syncFiles;

for (const failure of ['none', 'partial-append', 'full-append', 'compaction']) {
  test(`experimental hub log recovers complete snapshots after ${failure}`, async t => {
    const root = await mkdtemp('/tmp/thix-hub-log-');
    t.teardown(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'hub.json');
    files.writeTextAtomic(path, '{"sequence":0}\n');
    let fail = false;
    const operations = [];
    const faulting = harden({
      ...files,
      writeTextAtomic: (target, text, options) => {
        operations.push('replace');
        if (fail && failure === 'compaction') throw Error('injected');
        files.writeTextAtomic(target, text, options);
      },
      appendTextDurable: (target, text) => {
        operations.push('append');
        if (fail && failure === 'partial-append') {
          files.appendTextDurable(target, text.slice(0, 5));
          throw Error('injected');
        }
        files.appendTextDurable(target, text);
        if (fail && failure === 'full-append') throw Error('injected');
      },
    });
    const log = makeMailHubLog(faulting, { maxEntries: 2 });
    t.is(
      JSON.parse(log.readText(path)).sequence,
      0,
      'reads original hub state',
    );
    log.writeTextAtomic(path, '{"sequence":1}\n');
    if (failure === 'compaction') log.writeTextAtomic(path, '{"sequence":2}\n');
    fail = failure !== 'none';
    if (fail)
      t.throws(() => log.writeTextAtomic(path, '{"sequence":3}\n'), {
        message: 'injected',
      });
    else log.writeTextAtomic(path, '{"sequence":2}\n');
    fail = false;
    const restored = makeMailHubLog(faulting, { maxEntries: 2 });
    t.is(
      JSON.parse(restored.readText(path)).sequence,
      failure === 'partial-append' ? 1 : failure === 'full-append' ? 3 : 2,
    );
    restored.writeTextAtomic(path, '{"sequence":4}\n');
    t.is(JSON.parse(makeMailHubLog(files).readText(path)).sequence, 4);
    t.is(
      JSON.parse(files.readText(path)).sequence,
      0,
      'experiment leaves production format alone',
    );
    t.true(operations.includes('append'));
    t.true(operations.includes('replace'));
  });
}

test('experimental hub log rejects corrupted complete records', async t => {
  const root = await mkdtemp('/tmp/thix-hub-log-');
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'hub.json');
  files.writeTextAtomic(
    `${path}.experiment-log`,
    '{"sequence":1}\ncorrupt\n{"sequence":3}\n',
  );
  t.throws(() => makeMailHubLog(files).readText(path), {
    instanceOf: SyntaxError,
  });
  t.throws(
    () => makeMailHubLog(files).writeTextAtomic(path, '{"sequence":4}\n'),
    { instanceOf: SyntaxError },
  );
});
