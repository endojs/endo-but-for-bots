// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E, Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makePullRequests } from '../session/rsi-forge.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const asPatch = () =>
  bytesReaderFromIterator([new TextEncoder().encode('diff --git a/x b/x\n')]);
const token = Far('FakeSecret', { readBase64: () => btoa('test-password') });

const fixture = ({ write = false, actions = false } = {}) => {
  const writes = [];
  let topic;
  let candidate;
  let pull;
  const send = async (url, options) => {
    const { pathname } = new URL(url);
    const [, , , , owner, , ...path] = pathname.split('/');
    const leaf = decodeURIComponent(path.join('/'));
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      writes.push([owner, leaf, body]);
      if (leaf === 'branches') {
        topic = body.new_branch_name;
        candidate = body.old_ref_name;
        return Response.json({});
      }
      if (leaf === 'diffpatch') {
        candidate = head;
        return Response.json({});
      }
      if (leaf === 'pulls') {
        pull = {
          number: 1,
          state: 'open',
          user: { login: 'floot-rsi' },
          base: { ref: 'llm', sha: base, repo: { full_name: 'floot/endo' } },
          head: {
            ref: topic,
            sha: head,
            repo: { full_name: 'floot-rsi/endo' },
          },
        };
        return Response.json(pull);
      }
      throw Error('Unexpected mutation');
    }
    if (pathname === '/api/v1/user')
      return Response.json({
        login: 'floot-rsi',
        is_admin: false,
        restricted: true,
      });
    if (!leaf)
      return Response.json(
        owner === 'floot'
          ? {
              full_name: 'floot/endo',
              permissions: { pull: true, push: write, admin: false },
              private: true,
            }
          : {
              full_name: 'floot-rsi/endo',
              fork: true,
              parent: { full_name: 'floot/endo' },
              has_actions: actions,
              private: true,
            },
      );
    if (leaf === 'branches/llm') return Response.json({ commit: { id: base } });
    if (leaf === `branches/${topic}`)
      return Response.json({ commit: { id: candidate } });
    if (leaf.startsWith('git/commits/'))
      return Response.json({
        sha: head,
        parents: [{ sha: base }],
        commit: {
          message: writes.find(([, op]) => op === 'diffpatch')?.[2].message,
        },
      });
    if (leaf.startsWith('pulls/') && pull) return Response.json(pull);
    return new Response(null, { status: 404 });
  };
  return { writes, broker: makePullRequests(token, 'floot-rsi', send) };
};

test('RSI retries reuse a single fork branch and PR; only pull creation reaches the upstream repository', async t => {
  const { broker, writes } = fixture();
  const result = await E(broker).open('endo', base, 'test', asPatch());
  t.like(result, {
    base,
    head,
    number: 1,
    url: 'https://git.goooooo.ooo/floot/endo/pulls/1',
  });
  t.deepEqual(await E(broker).open('endo', base, 'test', asPatch()), result);
  t.deepEqual(
    writes.map(([owner, op]) => [owner, op]),
    [
      ['floot-rsi', 'branches'],
      ['floot-rsi', 'diffpatch'],
      ['floot', 'pulls'],
    ],
  );
  t.regex(writes[0][2].new_branch_name, /^rsi-[a-f0-9]{64}$/);
  t.is(writes[1][2].branch, writes[0][2].new_branch_name);
});

test('an upstream writer, enabled fork actions, unknown repo or replaced PR head is refused', async t => {
  for (const options of [{ write: true }, { actions: true }]) {
    const { broker, writes } = fixture(options);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(broker).open('endo', base, 'test', asPatch()), {
      message: /read-only upstream/,
    });
    t.deepEqual(writes, []);
  }
  const { broker } = fixture();
  await t.throwsAsync(E(broker).source('../admin'), { message: /Choose endo/ });
  await E(broker).open('endo', base, 'test', asPatch());
  await t.throwsAsync(E(broker).verify('endo', 1, base), {
    message: /changed/,
  });
  t.throws(() => makePullRequests(token, 'floot'), {
    message: /Invalid Forgejo account/,
  });
});

test('withdrawing the private credential prevents a held RSI capability from reading source after revival', async t => {
  const { make } = await import('../session/rsi-forge.js');
  let lookups = 0;
  const dir = Far('Revoked RSI access', {
    lookup: () => {
      lookups += 1;
      throw Error('Credential withdrawn');
    },
  });
  const held = make(dir, undefined);
  await t.throwsAsync(E(held).source('endo'), {
    message: /Credential withdrawn/,
  });
  t.is(lookups, 1);
});
