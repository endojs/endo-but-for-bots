// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/pass-style';
import { makePresetSettings } from '../../preset-settings.js';

const fixture = () => {
  const original = Far('Original');
  const replacement = Far('Replacement');
  let value = original;
  let fail = false;
  let revision = 0;
  let presets = [
    {
      id: 'voice',
      title: 'Voice',
      endowments: [{ petName: 'docs', sourcePath: ['docs'], value: original }],
    },
  ];
  const lookups = [];
  let refreshes = 0;
  const editor = makePresetSettings({
    rootPowers: Far('Root', {
      lookup: (...path) => {
        lookups.push(path);
        return value;
      },
    }),
    factory: Far('Factory', {
      getPresetConfiguration: () =>
        harden({
          revision: String(revision),
          voicePresetId: 'voice',
          presets,
          templates: [],
          builtinIds: ['voice'],
        }),
      savePreset: (preset, expected) => {
        if (fail) throw Error('write failed');
        if (expected !== String(revision)) throw Error('Reload before saving');
        revision += 1;
        presets = [preset];
      },
    }),
    changed: () => {},
    catalogChanged: async () => {
      refreshes += 1;
    },
  });
  return {
    refreshes: () => refreshes,
    editor,
    original,
    replacement,
    lookups,
    presets: () => presets,
    retarget: () => {
      value = replacement;
    },
    fail: flag => {
      fail = flag;
    },
  };
};

test('preset editor resolves explicit grants without exposing capabilities or retargeting retained ones', async t => {
  const f = fixture();
  await f.editor.load();
  const draft = f.editor.getState().configuration?.presets[0];
  t.like(draft.endowments[0], { petName: 'docs', sourcePath: ['docs'] });
  t.false('value' in draft.endowments[0]);
  f.retarget();
  await f.editor.save({ ...draft, title: 'Renamed' });
  t.is(f.presets()[0].endowments[0].value, f.original);
  t.deepEqual(f.lookups, []);
  await f.editor.save({
    ...draft,
    endowments: [{ petName: 'other', sourcePath: ['shared', 'other'] }],
  });
  t.deepEqual(f.lookups, [['shared', 'other']]);
  t.is(f.presets()[0].endowments[0].value, f.replacement);
  t.false(
    'value' in
      (f.editor.getState().configuration?.presets[0].endowments[0] || {}),
  );
});

test('failed preset saves retain the draft baseline and recover after retry', async t => {
  const f = fixture();
  await f.editor.load();
  const draft = f.editor.getState().configuration?.presets[0];
  f.fail(true);
  await f.editor.save({ ...draft, title: 'New title' });
  t.is(f.editor.getState().error, 'write failed');
  t.false(f.editor.getState().busy);
  t.is(f.editor.getState().configuration?.revision, '0');
  f.fail(false);
  await f.editor.save({ ...draft, title: 'New title' });
  t.is(f.editor.getState().error, '');
  t.is(f.editor.getState().configuration?.presets[0].title, 'New title');
});

test('copying or renaming a grant preserves the original capability across devices', async t => {
  const f = fixture();
  await f.editor.load();
  f.retarget();
  let draft = f.editor.getState().configuration?.presets[0];
  await f.editor.save({ ...draft, id: 'copy' });
  t.is(f.presets()[0].endowments[0].value, f.original);
  draft = f.editor.getState().configuration?.presets[0];
  await f.editor.save({
    ...draft,
    endowments: [{ ...draft.endowments[0], petName: 'renamed' }],
  });
  t.is(f.presets()[0].endowments[0].value, f.original);
  t.deepEqual(f.lookups, []);
});

test('reload refreshes settings and the session picker after a remote change', async t => {
  const f = fixture();
  await f.editor.load();
  t.is(f.refreshes(), 1);
  await f.editor.load();
  t.is(f.refreshes(), 2);
});

test('stale retained grants cannot silently resolve to a different local object', async t => {
  const f = fixture();
  await f.editor.load();
  const old = f.editor.getState().configuration?.presets[0];
  await f.editor.save({ ...old, title: 'Updated' });
  await f.editor.load();
  f.retarget();
  await f.editor.save({ ...old, title: 'Stale' });
  t.regex(f.editor.getState().error, /Retained object changed/);
  t.deepEqual(f.lookups, []);
  t.is(f.presets()[0].endowments[0].value, f.original);
});
