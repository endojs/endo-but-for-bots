// @ts-check
import './_m1a-prelude.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/far';
import { exportState, importState } from '../../scripts/export.mjs';
import { names } from '../../scripts/provision-steps.js';

test('archive keeps session effort and ignores old preset efforts on export and import', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'effort-archive-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'archive.jsonl');
  const preset = Far('Preset', {
    describe: () =>
      harden({
        label: 'preset',
        template: 'general',
        endowments: [],
        reasoningEffort: 'legacy',
      }),
  });
  const catalog = Far('PresetCatalog', {
    list: () => harden([preset]),
    configuration: () => harden({ revision: 0 }),
    create: (/** @type {any} */ record) => {
      t.false('reasoningEffort' in record);
      return harden({ preset });
    },
  });
  const backend = Far('Backend', { describe: () => harden({ label: 'pool' }) });
  const factory = Far('SessionFactory', {
    listBackends: () => harden([backend]),
  });
  const operator = Far('Operator', {
    getFactory: () => factory,
    getPresets: () => catalog,
  });
  const internal = Far('SessionInternal', {
    exportState: (/** @type {string} */ next) =>
      next
        ? harden({ part: 'end' })
        : harden({
            config: {
              backendTitle: 'pool',
              modelId: 'm',
              reasoningEffort: 'high',
              preset: { label: 'preset', reasoningEffort: 'legacy' },
            },
            next: 'end',
          }),
    importState: () => {},
  });
  const session = Far('Session', {});
  const root = Far('HarnessRoot', {
    getOperator: () => operator,
    exportState: () => harden({ sessions: [{ title: 'session', internal }] }),
    importSession: (/** @type {any} */ options) => {
      t.is(options.reasoningEffort, 'high');
      return harden({ session, internal });
    },
  });
  const admin = Far('AgentHostAdmin', {
    content: () => undefined,
    writersFor: () => undefined,
  });
  const client = {
    call: (/** @type {string} */ _method, /** @type {string} */ key) =>
      key === names.harness ? root : admin,
  };
  await exportState({ client, file });
  const lines = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const { records } = lines.find(line => line.type === 'presets');
  const { head } = lines.find(line => line.type === 'session');
  t.false('reasoningEffort' in records[0]);
  t.false('reasoningEffort' in head.config.preset);
  t.is(head.config.reasoningEffort, 'high');
  records[0].reasoningEffort = 'legacy';
  head.config.preset.reasoningEffort = 'legacy';
  await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n'));
  const result = await importState({ client, file });
  t.is(result.sessions.length, 1);
  t.is(result.presets, 1);
});
