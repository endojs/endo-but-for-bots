// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E, Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { makePullRequests } from '../session/rsi-forge.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const asPatch = () =>
  bytesReaderFromIterator([new TextEncoder().encode('diff --git a/x b/x\n')]);
const token = Far('FakeSecret', { readBase64: () => btoa('test-password') });

/** @param {{write?: boolean, actions?: boolean, archiveBody?: ReadableStream<Uint8Array>}} [options] */
const fixture = ({ write = false, actions = false, archiveBody } = {}) => {
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
    if (leaf === `archive/${base}.tar.gz` && archiveBody)
      return new Response(archiveBody);
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

for (const [label, lengths] of /** @type {const} */ ([
  ['one oversized HTTP chunk', [200_003]],
  ['mixed HTTP chunk sizes', [17, 65_536, 200_003, 3]],
])) {
  test(`RSI source delivers exact archive bytes through the default reader for ${label}`, async t => {
    const size = lengths.reduce((sum, length) => sum + length, 0);
    const expected = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const archiveBody = new ReadableStream({
      start(controller) {
        let offset = 0;
        for (const length of lengths) {
          controller.enqueue(expected.subarray(offset, offset + length));
          offset += length;
        }
        controller.close();
      },
    });
    const { broker } = fixture({ archiveBody });
    const { archive, commit } = await E(broker).source('endo');
    t.is(commit, base);
    const actual = new Uint8Array(size);
    let offset = 0;
    for await (const frame of iterateBytesReader(archive)) {
      actual.set(frame, offset);
      offset += frame.length;
    }
    t.is(offset, size);
    t.true(actual.every((byte, i) => byte === expected[i]));
    t.false(archiveBody.locked);
  });
}

test('abandoning a partial RSI archive cancels its HTTP body', async t => {
  let cancelled = false;
  const archiveBody = new ReadableStream(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(200_003));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const { broker } = fixture({ archiveBody });
  const { archive } = await E(broker).source('endo');
  const reader = iterateBytesReader(archive);
  const first = await reader.next();
  t.false(first.done);
  await reader.return(undefined);
  t.true(cancelled);
  t.false(archiveBody.locked);
});

test('RSI source propagates an interrupted HTTP body to the archive consumer', async t => {
  let started = false;
  const archiveBody = new ReadableStream(
    {
      pull(controller) {
        if (started) controller.error(Error('archive download interrupted'));
        else {
          started = true;
          controller.enqueue(Uint8Array.of(7));
        }
      },
    },
    { highWaterMark: 0 },
  );
  const { broker } = fixture({ archiveBody });
  const { archive } = await E(broker).source('endo');
  const reader = iterateBytesReader(archive);
  t.deepEqual((await reader.next()).value, Uint8Array.of(7));
  await t.throwsAsync(reader.next(), {
    message: /archive download interrupted/,
  });
  t.false(archiveBody.locked);
});

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
