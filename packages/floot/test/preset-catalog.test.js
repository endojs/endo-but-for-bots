// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makePresetCatalog, BUILTIN_PRESETS } from '../src/preset-catalog.js';
import { directoryHost } from './_directory-host.js';

const setup = hooks => {
  const values = new Map();
  const host = Far('PresetHost', directoryHost(values, hooks));
  return { values, host, catalog: makePresetCatalog(host) };
};
const custom = (extra = {}) =>
  harden({
    ...BUILTIN_PRESETS.find(preset => preset.id === 'general'),
    id: 'custom-helper',
    title: 'Helper',
    ...extra,
  });

test('presets and voice selection survive restart without namespace growth; edits are revision checked', async t => {
  const { catalog, host, values } = setup();
  let config = await catalog.read();
  const first = config.revision;
  config = await catalog.save(custom(), first);
  await t.throwsAsync(catalog.selectVoice('custom-helper', first), {
    message: /changed elsewhere/,
  });
  config = await catalog.selectVoice('custom-helper', config.revision);
  for (let n = 0; n < 20; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    config = await catalog.save(
      custom({ title: `Helper ${n}` }),
      config.revision,
    );
  }
  const restored = makePresetCatalog(host);
  t.is((await restored.voice()).title, 'Helper 19');
  t.is((await restored.read()).revision, config.revision);
  t.deepEqual([...values.keys()], ['floot-preset-settings']);
  await t.throwsAsync(restored.remove('custom-helper', config.revision), {
    message: /another voice preset/,
  });
  config = await restored.selectVoice('voice', config.revision);
  config = await restored.remove('custom-helper', config.revision);
  t.false(config.presets.some(preset => preset.id === 'custom-helper'));
  await t.throwsAsync(restored.remove('general', config.revision), {
    message: /reset, not deleted/,
  });
});

test('concurrent preset edits reject the stale writer instead of losing an update', async t => {
  const { catalog } = setup();
  const { revision } = await catalog.read();
  const outcomes = await Promise.allSettled([
    catalog.save(custom(), revision),
    catalog.save(custom({ id: 'custom-second' }), revision),
  ]);
  t.is(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  t.is(outcomes.filter(result => result.status === 'rejected').length, 1);
});

test('commit followed by lost acknowledgment invalidates cached authority and stale edits', async t => {
  let fail = true;
  const { catalog, host } = setup({
    afterStore: () => {
      if (fail) {
        fail = false;
        throw Error('lost ack');
      }
    },
  });
  const { revision } = await catalog.read();
  await t.throwsAsync(catalog.save(custom(), revision), {
    message: 'lost ack',
  });
  const durable = await catalog.read();
  t.true(durable.presets.some(preset => preset.id === 'custom-helper'));
  t.not(durable.revision, revision);
  t.is((await makePresetCatalog(host).read()).revision, durable.revision);
  await t.throwsAsync(catalog.selectVoice('voice', revision), {
    message: /changed elsewhere/,
  });
  t.is(
    (await catalog.selectVoice('custom-helper', durable.revision))
      .voicePresetId,
    'custom-helper',
  );
});

test('failed save leaves durable defaults intact and permits recovery', async t => {
  let fail = true;
  const { catalog } = setup({
    beforeStore: () => {
      if (fail) throw Error('disk failure');
    },
  });
  const { revision } = await catalog.read();
  await t.throwsAsync(catalog.save(custom(), revision), {
    message: 'disk failure',
  });
  t.is((await catalog.read()).revision, revision);
  fail = false;
  t.not((await catalog.save(custom(), revision)).revision, revision);
});

test('default grants require explicit capabilities and unambiguous nonreserved names', async t => {
  const { catalog } = setup();
  const { revision } = await catalog.read();
  const value = Far('AllowedObject', { read: () => 'allowed' });
  for (const petName of [
    '@host',
    'user',
    'tools',
    'x/y',
    '__proto__',
    '.',
    '..',
    'docs@home',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      catalog.save(
        custom({ endowments: [{ petName, sourcePath: ['source'], value }] }),
        revision,
      ),
      { message: /Reserved or invalid/ },
    );
  }
  await t.throwsAsync(
    catalog.save(
      custom({
        endowments: [
          { petName: 'source', sourcePath: ['source'], value: 'locator' },
        ],
      }),
      revision,
    ),
    { message: /object capability/ },
  );
  await t.throwsAsync(
    catalog.save(
      custom({ objects: [{ kind: 'host-powers', petName: 'endo' }] }),
      revision,
    ),
    { message: /Invalid template object/ },
  );
  const saved = await catalog.save(
    custom({
      endowments: [{ petName: 'source', sourcePath: ['source'], value }],
    }),
    revision,
  );
  t.is(
    saved.presets.find(preset => preset.id === 'custom-helper').endowments[0]
      .value,
    value,
  );
});

test('shell presets canonicalize provisioning order and reject missing dependencies', async t => {
  const { catalog } = setup();
  const { revision } = await catalog.read();
  const voice = BUILTIN_PRESETS.find(p => p.id === 'voice');
  await t.throwsAsync(
    catalog.save({ ...voice, objects: [voice.objects[1]] }, revision),
    { message: /requires a workspace/ },
  );
  const saved = await catalog.save(
    { ...voice, objects: [...voice.objects].reverse() },
    revision,
  );
  t.deepEqual(
    saved.presets.find(p => p.id === 'voice').objects.map(o => o.petName),
    ['workspace', 'shell'],
  );
});
