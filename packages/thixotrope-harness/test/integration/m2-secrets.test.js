// @ts-check
/**
 * M2 acceptance 7 (milestones.md M2; m2-interfaces.md 2.5, 9; W2.9)
 * through the daemon, against the fake provider server on 127.0.0.1
 * (D-M2-4), from the m1a state template:
 *
 * - An OpenRouter backend reads its key through a ReadGrant of a Secret.
 * - Replace the key (a sealed box, as the CLI path sends it): the next turn
 *   uses the new key, without a restart (R4-82: the key is read every
 *   round). The server records which of the test's keys it saw through the
 *   `credentialTag` option, never the value.
 * - Revoke the Secret: the next turn fails with the recorded reason
 *   `textOf.secretFailed('REVOKED')`, no request reaches the server, and no
 *   provider body is in any reason (a 401 with a body marker is tried too).
 * - After a clean stop, no encoding of any key value appears anywhere under
 *   the state directory (heaps, snapshots, journals, the hub image and log,
 *   blobs, the archive, logs); a control text is found, so the grep reads
 *   those encodings.
 *
 * A plain-string replace (not sealed) of a second Secret is recorded as an
 * observation (`m2.secrets.plainValue`): where a plain value sent from a
 * client lands is reported, not asserted, because the contract's client
 * path is the sealed box (m2-interfaces.md 9.2).
 *
 * The wrapping key file is made under H/tmp (outside the state directory,
 * D-6) through THIX_HARNESS_SECRETS_KEY and removed at the end. Key values
 * are built at run time (`makeTestSecretValue`).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-secrets -- \
 *     corepack yarn test test/integration/m2-secrets.test.js
 */
import '../unit/_m1a-prelude.js';

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { sealTo } from '../../resources/agent-host/impl/secrets/seal.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  BODY_MARKER,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { makeSlice, requestId, sliceTemplate, waitFor } from './_m1a-slice.js';
import { grepState, makeTestSecretValue } from './_m2-secrets.js';

takeIntegrationLock(test, 'm2 secrets test');

const run = integrationEnabled ? test.serial : test.skip;

const MODEL = 'acme/alpha-a';
const CONTROL = 'control text for the state grep';
const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;
const keyDir = path.join(harnessTmp, `w29-key-${process.pid}`);

/**
 * @param {Record<string, unknown>} row
 */
const record = async row =>
  emit({ ...row, ...(await runIdentity()), crankBudget, loadAvg: loadAvg() });

/**
 * Submit and wait for the turn's `end` or `abort`.
 * @param {any} slice
 * @param {any} session
 * @param {any} live
 * @param {string} input
 */
const turn = async (slice, session, live, input) => {
  const from = /** @type {number} */ (live.deliveries.length);
  const receipt = await E(slice.composer).submit(session, input, requestId());
  const { turnId } = await E(receipt.turn).getStatus();
  const last = await waitFor(
    () =>
      live.deliveries.find(
        (/** @type {any} */ d, /** @type {number} */ i) =>
          i >= from &&
          (d.event.type === 'end' || d.event.type === 'abort') &&
          d.event.turnId === turnId,
      ),
    60_000,
    `turn ${input}: end`,
    10,
  );
  const status = await E(receipt.turn).getStatus();
  return { turnId, last: last.event, status };
};

run(
  'acceptance 7: replace the key, the next turn uses it; revoke, the next turn fails without a body; no value in the state directory',
  async t => {
    t.timeout(4 * 60_000);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    t.teardown(() => rmSync(keyDir, { recursive: true, force: true }));
    process.env.THIX_HARNESS_SECRETS_KEY = path.join(keyDir, 'secrets.key');

    const first = makeTestSecretValue('first');
    const second = makeTestSecretValue('second');
    const plain = makeTestSecretValue('plain');
    /** @param {string} value */
    const credentialTag = value =>
      ({ [first]: 'first', [second]: 'second', [plain]: 'plain' })[value] ??
      (value === '' ? 'none' : 'other');
    const server = await startFakeProviderServer({
      credentialTag,
      // The model catalogue a creation consults (R4-21, R4-104).
      plan: [
        {
          match: { method: 'GET', path: '/api/v1/models' },
          file: 'openrouter-models.json',
          repeat: 20,
        },
      ],
    });
    t.teardown(() => server.close());

    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);

    const secrets = await E(slice.admin).getSecrets();
    const secret = await E(secrets).create(
      harden({ label: 'provider key', description: CONTROL }),
    );
    const writer = await E(secrets).openWriter();
    const publicKey = await E(writer).publicKey();
    const g1 = await E(writer).replace(secret, sealTo(publicKey, first));
    const keyGrant = await E(secret).makeReadGrant();
    const backend = await E(slice.admin).makeBackend(
      harden({
        kind: 'openrouter',
        label: 'OpenRouter',
        keyGrant,
        modelId: MODEL,
        baseUrl: server.openRouterBaseUrl,
      }),
    );
    const session = await E(slice.factory).createSession(
      harden({
        title: CONTROL,
        preset: slice.chatOnly,
        backend,
        modelId: MODEL,
        at: Date.now(),
      }),
    );
    const live = await slice.subscribe(session);
    const posts = () => server.requests().filter(r => r.method === 'POST');

    // 1. The first key.
    server.push({ sse: 'openrouter-text.sse' });
    const a = await turn(slice, session, live, 'turn with the first key');
    t.is(a.last.type, 'end');
    t.is(posts()[0].credential, 'first');

    // 2. Replace (sealed, with the expected generation): the next turn uses
    // the new key, no restart. A stale generation is refused.
    const g2 = await E(writer).replace(
      secret,
      sealTo(publicKey, second),
      g1.generation,
    );
    t.true(Number(g2.generation) > Number(g1.generation));
    await t.throwsAsync(
      () => E(writer).replace(secret, sealTo(publicKey, first), g1.generation),
      { message: textOf.secretFailed('GENERATION_CONFLICT') },
    );
    server.push({ sse: 'openrouter-text.sse' });
    const b = await turn(slice, session, live, 'turn with the second key');
    t.is(b.last.type, 'end');
    t.is(posts()[1].credential, 'second');
    t.is(posts().length, 2);

    // 3. A provider failure with a body: the reason carries the status only.
    server.push({
      status: 401,
      body: { error: { message: `${BODY_MARKER} unauthorized` } },
    });
    const c = await turn(slice, session, live, 'turn refused by the server');
    t.is(c.status.state, 'failed');
    t.is(c.status.error, textOf.openRouterHttp(401));
    t.false(JSON.stringify(c).includes(BODY_MARKER));

    // 4. Revoke: the next turn fails with the secret's reason, no request.
    await E(secret).revoke();
    const info = await E(secret).describe();
    t.is(info.state, 'revoked');
    const before = posts().length;
    const d = await turn(slice, session, live, 'turn after the revoke');
    t.is(d.status.state, 'failed');
    t.is(d.status.error, textOf.secretFailed('REVOKED'));
    t.is(d.last.type, 'abort');
    t.false(JSON.stringify(d).includes(BODY_MARKER));
    t.is(posts().length, before, 'no request after the revoke');

    // The reasons as recorded in the transcript (the history page).
    const page = await E(session).getHistoryPage();
    const text = JSON.stringify(page);
    t.false(text.includes(BODY_MARKER), 'no provider body in any record');
    // (as JSON text: its quotes are escaped)
    t.true(
      text.includes(
        JSON.stringify(textOf.secretFailed('REVOKED')).slice(1, -1),
      ),
    );

    // The audit names reads; never a value.
    const audit = await E(secret).audit();
    t.true(Number(audit.length) > 0);
    t.false(JSON.stringify(audit).includes(first));

    // Observation: a plain string sent by a client.
    const other = await E(secrets).create(
      harden({ label: 'plain key', description: 'plain replace' }),
    );
    await E(writer).replace(other, plain);

    // 5. Clean stop, then grep the whole state directory.
    await state.stop();
    const control = await grepState(state.root, CONTROL);
    t.true(control.length > 0, 'the control text is found');
    const controlEncodings = [...new Set(control.map(h => h.encoding))];
    const hits = [
      ...(await grepState(state.root, first)),
      ...(await grepState(state.root, second)),
    ];
    t.deepEqual(
      hits.map(
        ({ file, encoding }) =>
          `${path.relative(state.root, file)} (${encoding})`,
      ),
      [],
      'no encoding of either key value under the state directory',
    );
    const plainHits = await grepState(state.root, plain);
    await record({
      metric: 'm2.secrets.grep',
      files: /** @type {any} */ (control).files,
      bytes: /** @type {any} */ (control).bytes,
      controlEncodings,
      hits: hits.length,
    });
    await record({
      metric: 'm2.secrets.plainValue',
      hits: plainHits.map(
        ({ file, encoding }) =>
          `${path.relative(state.root, file)} (${encoding})`,
      ),
    });
    await state.cleanup();
  },
);
