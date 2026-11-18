// @ts-check
/**
 * M4 acceptance 1 and 15 (part) through the daemon (W4.8;
 * `designs/m4-interfaces.md` 4, 17), from the `m4` template:
 *
 * 1. Secrets: create, replace with the expected generation (a stale one:
 *    `GENERATION_CONFLICT`), revoke (the next read, a pool round, fails
 *    `REVOKED`), delete only after revoke, `setDescription`; `catalog`
 *    lists label, description, generation, state and bytes and never a
 *    value; the audit reader lists each read as attempted and succeeded,
 *    and pages 1,000 events at a time without losing or repeating one.
 * 15. After a clean stop no value is under the state directory, in the
 *    event log or in the supervisor's stderr.
 *
 * The 1,000-event history is written by sealed replaces through the
 * writer (the CLI path), not by turns.
 *
 *   corepack yarn test:integration test/integration/m4-secrets.test.js
 */
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { subscriptionTextOf } from '../../guest/lib/subscription-texts.js';
import { sealTo } from '../../resources/agent-host/impl/secrets/seal.js';
/* eslint-enable import/no-relative-packages */
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  TOKEN_PREFIXES,
  assertNoCredential,
  credentialText,
  fakeDefaults,
  makePool,
  openSession,
  poolLog,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 secrets test');

const run = integrationEnabled ? test.serial : test.skip;

const BULK = 520;

/**
 * Every catalogue entry, all pages.
 * @param {any} secrets
 */
const catalogue = async secrets => {
  /** @type {any[]} */
  const entries = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(secrets).catalog(
      ...(cursor === undefined ? [] : [cursor]),
    );
    entries.push(...page.entries);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
};

run(
  'acceptance 1, 15: the full Secrets manager through the daemon',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'secrets');
    const server = await startFakeSubscriptionServer({
      defaults: { 'GET /v1/models': fakeDefaults['GET /v1/models'] },
    });
    t.teardown(() => server.close());
    const { secrets, writer, publicKey } = m4;

    // Create, replace with the expected generation, stale refused.
    const secret = await E(secrets).create(
      harden({ label: 'member credential', description: 'first text' }),
    );
    const value = credentialText('claude', { accessToken: tokenOf('one') });
    const g1 = await E(writer).replace(secret, sealTo(publicKey, value));
    const g2 = await E(writer).replace(
      secret,
      sealTo(publicKey, value),
      g1.generation,
    );
    t.true(Number(g2.generation) > Number(g1.generation));
    await t.throwsAsync(
      () => E(writer).replace(secret, sealTo(publicKey, value), g1.generation),
      { message: textOf.secretFailed('GENERATION_CONFLICT') },
    );

    // Description edit; the catalogue: label, description, generation,
    // state, bytes, never a value.
    await E(secret).setDescription('second text');
    const listed = (await catalogue(secrets)).find(
      e => e.label === 'member credential',
    );
    t.like(listed, {
      label: 'member credential',
      description: 'second text',
      generation: g2.generation,
      state: 'active',
      bytes: Buffer.byteLength(value),
    });
    t.deepEqual(Object.keys(listed).sort(), [
      'bytes',
      'description',
      'generation',
      'label',
      'secret',
      'state',
    ]);

    // A read through a pool round: audited as attempted and succeeded.
    const logPath = path.join(m4.state.root, 'secrets-pool.log');
    const { backend } = await makePool(m4, {
      kind: 'claude-pool',
      label: 'Secrets pool',
      members: [{ label: 'the member', credential: secret }],
      baseUrl: server.url,
      logPath,
    });
    const { session, live } = await openSession(m4, backend, {
      modelId: CLAUDE_MODEL,
    });
    server.push({ sse: 'claude-text.sse' });
    const ok = await runTurn(m4, session, live, 'read');
    t.is(ok.status.state, 'completed', ok.status.error);
    const reader = await E(secrets).auditReader();
    const own = await E(reader).page(harden({ secret, limit: 50 }));
    const reads = own.events.filter((/** @type {any} */ e) => e.op === 'read');
    t.true(
      reads.some((/** @type {any} */ e) => e.outcome === 'attempted') &&
        reads.some((/** @type {any} */ e) => e.outcome === 'succeeded'),
      'a read is audited as attempted and succeeded',
    );
    t.false(JSON.stringify(own).includes(value));

    // Delete before revoke is refused; revoke; the next read fails.
    await t.throwsAsync(() => E(secret).delete(), {
      message: textOf.secretFailed('NOT_REVOKED'),
    });
    await E(secret).revoke();
    const before = posts(server).length;
    const refused = await runTurn(m4, session, live, 'after revoke');
    t.is(refused.status.state, 'failed');
    t.is(posts(server).length, before, 'no request after the revoke');
    t.true(
      poolLog(logPath).some(
        l =>
          l.reason === subscriptionTextOf.memberFailed('the member', 'REVOKED'),
      ),
    );
    const revoked = (await catalogue(secrets)).find(
      e => e.label === 'member credential',
    );
    t.is(revoked.state, 'revoked');
    await E(secret).delete();
    t.false(
      (await catalogue(secrets)).some(e => e.label === 'member credential'),
    );

    // 1,000 events in pages: sealed replaces of one Secret, then pages of
    // at most 1,000 until no `next`, each event once, newest first.
    const bulk = await E(secrets).create(
      harden({ label: 'bulk', description: 'audit pages' }),
    );
    for (let i = 0; i < BULK; i += 26) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        Array.from({ length: Math.min(26, BULK - i) }, () =>
          E(writer).replace(bulk, sealTo(publicKey, tokenOf('bulk'))),
        ),
      );
    }
    /** @type {any[]} */
    const pages = [];
    /** @type {number | undefined} */
    let next;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await E(reader).page(
        harden({
          limit: 1000,
          ...(next === undefined ? {} : { before: next }),
        }),
      );
      pages.push(page);
      next = page.next;
    } while (next !== undefined && pages.length < 10);
    t.is(pages[0].events.length, 1000, 'a full page of 1,000');
    const ats = pages.flatMap(p =>
      p.events.map((/** @type {any} */ e) => e.at),
    );
    t.true(ats.length > 1000);
    t.true(
      ats.every((at, i) => i === 0 || Number(at) < Number(ats[i - 1])),
      'newest first, each event once across pages',
    );
    const bulkEvents = pages
      .flatMap(p => p.events)
      .filter(
        (/** @type {any} */ e) =>
          e.label === 'bulk' && e.op === 'replace' && e.outcome === 'succeeded',
      );
    t.is(bulkEvents.length, BULK, 'every replace is listed');
    await t.throwsAsync(() => E(reader).page(harden({ limit: 1001 })));

    // 15.
    await m4.state.stop();
    await assertNoCredential(t, m4, [...TOKEN_PREFIXES], {
      files: [logPath],
      control: 'second text',
    });
  },
);
