// @ts-check
// The agent host's state layout and its start-up sweep (harness review
// HR-SYN-22, HR-SYN-9): the state directory is worked out once and the blob
// directory, the archive and the subscriptions files hang off it; the blob
// store sweeps once per incarnation, so a rebind neither counts the files on
// disk twice nor deletes this incarnation's unfinished writes; a sweep that
// fails is reported, and the store refuses stagings until one succeeds.
// Node, real files, a fake manager sink.
import '../unit/_m1a-prelude.js';

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

import {
  blobDirIn,
  blobsUncountedText,
  findBlobDir,
  findStateDir,
  makeBlobStore,
} from '../../resources/agent-host/impl/blobs.js';
import { makeAgentHostImpl } from '../../resources/agent-host/impl/index.js';
import { makeFakeBlobSink } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

/** @param {import('ava').ExecutionContext} t */
const tempState = t => {
  const root = mkdtempSync(join(tmpdir(), 'ah-layout-'));
  t.teardown(() => {
    // A test may leave a directory unreadable.
    try {
      chmodSync(blobDirIn(root), 0o700);
    } catch {
      // Not made.
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
};

/**
 * A fake manager sink: the blob half plus `attach`.
 */
const makeSink = () => {
  const fake = makeFakeBlobSink();
  let attaches = 0;
  const sink = Far('AgentHostSink', {
    mintBlobs: () => fake.sink.mintBlobs(),
    /** @param {any[]} blobs */
    resolveBlobs: blobs => fake.sink.resolveBlobs(blobs),
    attach: () => {
      attaches += 1;
      return attaches;
    },
  });
  return { sink, attaches: () => attaches };
};

/**
 * Files of an earlier incarnation: `count` committed texts of `bytes` each.
 * @param {string} blobDir
 * @param {number} count
 * @param {number} bytes
 */
const earlierFiles = async (blobDir, count, bytes) => {
  const earlier = makeBlobStore({
    dir: blobDir,
    sink: makeFakeBlobSink().sink,
  });
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await earlier.stage('e'.repeat(bytes));
  }
};

test('HR-SYN-22: the state directory is found once, from argv[3] only', t => {
  const argv = ['node', 'entry.js', 'x', '/s/bundles/abc.cjs'];
  t.is(findStateDir(argv), '/s');
  t.is(findBlobDir(argv), join('/s', 'agent-host', 'blobs'));
  t.throws(() => findStateDir(['node', 'entry.js']), {
    message:
      'agent host: no state directory (argv[3] is not <state>/bundles/<digest>.cjs)',
  });
});

test('HR-SYN-22: makeAgentHostImpl({ stateDir }) keeps its blobs in <state>/agent-host/blobs', async t => {
  const root = tempState(t);
  const { sink } = makeSink();
  /** @type {any[]} */
  const events = [];
  const impl = makeAgentHostImpl({ stateDir: root, report: e => events.push(e) });
  await impl.bind('agent-host', harden({ sink }));
  t.true(existsSync(blobDirIn(root)), 'the sweep made the blob directory');
  const staged = await impl.blobs.stage('s'.repeat(9000));
  t.is(staged.bytes, 9000);
  t.deepEqual(
    readdirSync(blobDirIn(root)).filter(name => /^b\d+$/.test(name)).length,
    1,
  );
  t.deepEqual(
    events.filter(e => e.store === 'blobs'),
    [],
  );
});

test('HR-SYN-9: one sweep per incarnation; a rebind neither counts the files twice nor deletes this incarnation\'s unfinished writes', async t => {
  const root = tempState(t);
  const blobDir = blobDirIn(root);
  await earlierFiles(blobDir, 3, 10_000);
  writeFileSync(join(blobDir, 'b900.part'), 'an earlier incarnation died');
  const { sink, attaches } = makeSink();
  const impl = makeAgentHostImpl({ stateDir: root, report: () => {} });
  await impl.bind('agent-host', harden({ sink }));
  t.false(existsSync(join(blobDir, 'b900.part')), 'the first sweep deleted it');
  t.is(impl.blobs.usage(undefined).daemon, 30_000);
  // A write of this incarnation that is not committed yet.
  await impl.blobs.stagePending('p'.repeat(5000));
  const parts = () => readdirSync(blobDir).filter(name => name.endsWith('.part'));
  t.is(parts().length, 1);
  await impl.bind('agent-host', harden({ sink }));
  t.is(attaches(), 2);
  t.is(
    impl.blobs.usage(undefined).daemon,
    35_000,
    'the files on disk are counted once, plus what this incarnation staged',
  );
  t.is(parts().length, 1, 'the rebind kept the unfinished write');
  // The store's own sweep answers the same settled sweep.
  await impl.blobs.sweep();
  t.is(impl.blobs.usage(undefined).daemon, 35_000);
  t.is(parts().length, 1);
});

test('HR-SYN-9: a store nobody swept sweeps before its first staging', async t => {
  const root = tempState(t);
  const blobDir = blobDirIn(root);
  await earlierFiles(blobDir, 2, 10_000);
  writeFileSync(join(blobDir, 'b900.part'), 'half');
  const store = makeBlobStore({
    dir: blobDir,
    sink: makeFakeBlobSink().sink,
    quota: { sessionBytes: 1_000_000, daemonBytes: 25_000 },
  });
  // Without the sweep the daemon count would start at 0 and take this.
  await t.throwsAsync(() => store.stage('x'.repeat(10_000)), {
    message: /daemon/,
  });
  t.is(store.usage(undefined).daemon, 20_000);
  t.false(existsSync(join(blobDir, 'b900.part')));
});

test('HR-SYN-9: a sweep that fails is reported; stagings are refused until a sweep succeeds', async t => {
  if (process.getuid?.() === 0) {
    t.pass('root reads any directory');
    return;
  }
  const root = tempState(t);
  const blobDir = blobDirIn(root);
  await earlierFiles(blobDir, 2, 10_000);
  // Writable and searchable, not readable: the sweep's readdir fails.
  chmodSync(blobDir, 0o300);
  const { sink } = makeSink();
  /** @type {any[]} */
  const events = [];
  const impl = makeAgentHostImpl({ stateDir: root, report: e => events.push(e) });
  await impl.bind('agent-host', harden({ sink }));
  t.like(
    events.find(e => e.store === 'blobs'),
    { event: 'sweep-failed', store: 'blobs' },
    'the bind reported the failure and went on',
  );
  t.is(typeof events.find(e => e.store === 'blobs')?.error, 'string');
  await t.throwsAsync(() => impl.blobs.stage('y'.repeat(9000)), {
    message: blobsUncountedText,
  });
  const writer = await impl.blobs.writers.open();
  await t.throwsAsync(() => writer.append('z'.repeat(100)), {
    message: blobsUncountedText,
  });
  t.is(
    readdirSync(join(root, 'agent-host')).includes('blobs'),
    true,
    'the directory is still there',
  );
  // Readable again: the next staging sweeps, counts the files and goes on.
  chmodSync(blobDir, 0o700);
  const staged = await impl.blobs.stage('y'.repeat(9000));
  t.is(staged.bytes, 9000);
  t.is(impl.blobs.usage(undefined).daemon, 29_000);
});

test('HR-SYN-9: no state directory at all is reported at the bind, not thrown', async t => {
  /** @type {any[]} */
  const events = [];
  const { sink } = makeSink();
  const impl = makeAgentHostImpl({
    stateDir: () => {
      throw Error('no state directory here');
    },
    report: e => events.push(e),
  });
  await impl.bind('agent-host', harden({ sink }));
  t.like(events.find(e => e.store === 'blobs'), {
    event: 'sweep-failed',
    error: 'no state directory here',
  });
  await t.throwsAsync(() => impl.blobs.stage('q'.repeat(9000)), {
    message: blobsUncountedText,
  });
});
