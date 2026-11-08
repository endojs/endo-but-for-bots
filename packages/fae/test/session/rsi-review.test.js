// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { make } from '../../rsi-review.js';
import { BUILTIN_PRESETS } from '../../session/preset-catalog.js';
import { composePresetPrompt } from '../../session/system-prompt.js';

const head = 'aa'.repeat(20);
const base = 'bb'.repeat(20);
const args = harden({
  repo: 'endo-host',
  number: 12,
  head,
  title: 'test',
  summary: 'Nix change',
});
const files = harden([{ path: 'a.nix', text: 'reviewed contents' }]);
const fixture = () => {
  const calls = [];
  const methods = {
    verify: (repo, number, oid) => {
      if (oid !== head) throw Error('Unknown PR revision');
      return harden({
        repo,
        number,
        base,
        head: oid,
        url: 'https://example.test/pulls/12',
      });
    },
    reviewFiles: (number, oid) => {
      if (number !== 12 || oid !== head) throw Error('Wrong revision');
      return files;
    },
  };
  const broker = Far('Pull verifier', methods);
  const service = Far('Workflow', {
    factory: fid =>
      Far('Bound reviewed factory', {
        start: options => {
          calls.push({ fid, options });
          return harden({ runId: 'run-1', control: Far('Control', {}) });
        },
      }),
  });
  const connection = make(
    Far('Private powers', {
      lookup: name => {
        if (name !== 'settings') throw Error('Unknown');
        return harden({
          broker,
          service,
          factories: { endo: 'endo-fid', 'endo-host': 'host-fid' },
        });
      },
    }),
  );
  return { connection, calls };
};

test('RSI session receives only workspace, shell, pull requests and review submissions', t => {
  const preset = BUILTIN_PRESETS.find(x => x.id === 'rsi');
  if (!preset) throw Error('Missing RSI preset');
  t.deepEqual(
    preset.objects.map(x => x.petName),
    ['workspace', 'shell', 'pull-requests', 'review-deploy'],
  );
  t.is(preset.networkPolicy, 'public-internet');
  t.true(
    composePresetPrompt({ presetId: 'rsi', objects: preset.objects }).includes(
      'review-deploy.propose',
    ),
  );
});

test('a verified pull opens the scoped workflow with immutable reviewed input and a retry key', async t => {
  const { connection, calls } = fixture();
  t.deepEqual(await E(connection).propose(args), { runId: 'run-1' });
  t.deepEqual(calls, [
    {
      fid: 'host-fid',
      options: {
        requestId: `pr-12-${head}`,
        params: {
          title: args.title,
          summary: `Pull request: https://example.test/pulls/12\n${args.summary}`,
          base,
          head,
          files,
        },
      },
    },
  ]);
  t.deepEqual(await E(connection).propose({ ...args, repo: 'endo' }), {
    runId: 'run-1',
  });
  t.is(calls[1].fid, 'endo-fid');
  t.deepEqual(calls[1].options.params.files, []);
});

test('caller cannot set the revision evidence, reviewer, authority or files to deploy', async t => {
  const { connection, calls } = fixture();
  for (const override of [
    { head: 'ff'.repeat(20) },
    { repo: 'unrelated' },
    { number: -1 },
    { reviewers: [] },
    { files: [] },
    { performer: Far('Performer', {}) },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(connection).propose(harden({ ...args, ...override })),
    );
  }
  t.deepEqual(calls, []);
  // eslint-disable-next-line no-underscore-dangle
  const names = await E(/** @type {any} */ (connection)).__getMethodNames__();
  t.false(names.includes('start'));
  t.false(names.includes('apply'));
  t.false(names.includes('approve'));
  t.false(names.includes('revoke'));
});
