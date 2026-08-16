// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { Far } from '@endo/pass-style';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';
import { makePromiseKit } from '@endo/promise-kit';

import { make } from '../src/plugin.js';
import { featureChange } from './fixtures/feature-change.js';

const RawInterface = (/** @type {string} */ name) =>
  M.interface(name, {}, { defaultGuards: 'raw' });

/**
 * Real exo participants behind the plugin's delivery seam: the seam
 * discovers `request`/`form` methods via `__getMethodNames__` (which
 * `makeExo` provides), attenuates via an actual `readOnly()` call, and
 * `call`s CI and merge as plain eventual sends. This is the Phase 6
 * integration cut that runs in CI; a live-lal wiring needs a daemon and
 * an LLM key.
 */
const makeParticipants = () => {
  /** @type {{ description: string, attachments: any, resolve: (v: unknown) => void }[]} */
  const implementerInbox = [];
  const implementer = makeExo(
    'StubImplementer',
    RawInterface('StubImplementer'),
    {
      /**
       * @param {string} description
       * @param {any} attachments
       */
      request: (description, attachments) => {
        const { promise, resolve } = makePromiseKit();
        implementerInbox.push({ description, attachments, resolve });
        return promise;
      },
    },
  );

  /** @type {{ resolve: (v: unknown) => void }[]} */
  const reviewerInbox = [];
  const makeReviewer = (/** @type {string} */ name) =>
    makeExo(name, RawInterface(name), {
      request: () => {
        const { promise, resolve } = makePromiseKit();
        reviewerInbox.push({ resolve });
        return promise;
      },
    });

  /** @type {{ fields: any, resolve: (v: unknown) => void }[]} */
  const approverInbox = [];
  const approver = makeExo('StubApprover', RawInterface('StubApprover'), {
    /**
     * @param {string} _description
     * @param {any} fields
     */
    form: (_description, fields) => {
      const { promise, resolve } = makePromiseKit();
      approverInbox.push({ fields, resolve });
      return promise;
    },
  });

  /** @type {string[]} */
  const ciRuns = [];
  const ci = makeExo('StubCi', RawInterface('StubCi'), {
    /** @param {string} branch */
    run: branch => {
      ciRuns.push(branch);
      return 'green';
    },
  });

  /** @type {string[]} */
  const merges = [];
  const reader = makeExo('StubRepoReader', RawInterface('StubRepoReader'), {
    kind: () => 'reader',
  });
  const repo = makeExo('StubRepo', RawInterface('StubRepo'), {
    readOnly: () => reader,
    /** @param {string} branch */
    merge: branch => {
      merges.push(branch);
      return 'merged';
    },
  });

  return {
    participants: {
      implementer,
      reviewers: [makeReviewer('SecReviewer'), makeReviewer('StyleReviewer')],
      ci,
      approver,
      repo,
    },
    implementerInbox,
    reviewerInbox,
    approverInbox,
    ciRuns,
    merges,
    reader,
  };
};

/** @param {number} [rounds] */
const flush = async (rounds = 25) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

test('the unconfined plugin drives real exo participants end to end', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const storeRoot = await E(root).makeDirectory('workflow-store', {});
  const powers = Far('Powers', {
    /** @param {string} name */
    lookup: name => {
      if (name === 'workflow-store') {
        return storeRoot;
      }
      throw Error(`unknown power ${name}`);
    },
  });
  const context = Far('Context', {
    whenCancelled: () => new Promise(() => {}),
  });

  const service = await make(powers, context, {});
  const stubs = makeParticipants();

  await E(service).define('feature-change', featureChange);
  const { observer } = await E(service).start('feature-change', {
    input: { request: 'add dark mode', branch: 'feat/dark-mode' },
    participants: stubs.participants,
  });
  await flush();

  // The seam found the implementer's `request` method via
  // `__getMethodNames__` and attached the repo writer.
  t.is(stubs.implementerInbox.length, 1);
  const [implementation] = stubs.implementerInbox;
  t.is(
    implementation.description,
    'Implement: "add dark mode" on "feat/dark-mode"',
  );
  t.is(implementation.attachments.repo, stubs.participants.repo);
  implementation.resolve({ changeSet: 'cs-1' });
  await flush();
  t.is((await E(observer).status()).state, 'reviewing');

  // The fanout attenuated the repo through a real readOnly() call.
  t.is(stubs.reviewerInbox.length, 2);
  for (const review of stubs.reviewerInbox.splice(0)) {
    review.resolve({ verdict: 'approve' });
  }
  await flush();

  // CI ran as an eventual send with the raw branch argument.
  t.deepEqual(stubs.ciRuns, ['feat/dark-mode']);
  await flush();

  // The approver's form arrived with the declared fields.
  t.is(stubs.approverInbox.length, 1);
  const [approval] = stubs.approverInbox;
  t.deepEqual(approval.fields, [{ name: 'decision', label: 'Approve merge?' }]);
  approval.resolve({ decision: 'yes' });
  await flush();

  t.deepEqual(stubs.merges, ['feat/dark-mode']);
  const status = await E(observer).status();
  t.is(status.state, 'done');
  t.is(status.final, 'succeeded');

  // Capability settlements were aliased, never journaled raw: the
  // change-set record is data, but every journal value is
  // JSON-representable by construction.
  const journal = await E(observer).exportJournal();
  t.notThrows(() => JSON.stringify(journal));
  t.is(journal[journal.length - 1].type, 'run.finished');
});
