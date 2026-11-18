// @ts-check
/**
 * M4 acceptance 8 and 9 through the daemon (W4.8; `designs/m4-interfaces.md`
 * 5.3, 17), against the fake subscription server on 127.0.0.1, from the
 * `m4` template, one single-member pool of each kind:
 *
 * 8. Claude: a 529 before any delivery is retried and the turn completes;
 *    an overload after a delivery fails with an R4-76 text; an SSE error, a
 *    non-200 and an empty answer give the three R4-76 texts.
 * 9. Codex: `server_is_overloaded` before visible delivery is retried on the
 *    schedule (the production delays 5 s then 10 s, read from the pool's
 *    event log; the full scaled schedule is W4.3's adapter test), after it
 *    is not; a failure event gives symbolic facts only.
 *
 * No provider body (`BODY_MARKER`, the fixtures' prose) is in any reason.
 *
 *   corepack yarn test:integration test/integration/m4-wire.test.js
 */
import '../unit/_m1a-prelude.js';

import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import {
  subscriptionTextOf,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  BODY_MARKER,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';
import {
  CLAUDE_MODEL,
  CODEX_MODEL,
  credentialText,
  fakeDefaults,
  makePool,
  makeValueSecret,
  openSession,
  poolLog,
  posts,
  runTurn,
  startM4,
  tokenOf,
} from './_m4.js';

takeIntegrationLock(test, 'm4 wire test');

const run = integrationEnabled ? test.serial : test.skip;

/** Prose the fixtures carry that must never reach a reason. */
const PROSE = ['FAKE-PROSE', 'req_fake_123', BODY_MARKER];

run(
  'acceptance 8, 9: overload retry before delivery only; fixed failure texts',
  async t => {
    t.timeout(4 * 60_000);
    const m4 = await startM4(t, 'wire');
    const server = await startFakeSubscriptionServer({
      defaults: fakeDefaults,
    });
    t.teardown(() => server.close());

    /**
     * @param {'claude-pool' | 'codex-pool'} kind
     * @param {string} modelId
     */
    const single = async (kind, modelId) => {
      const provider = kind === 'claude-pool' ? 'claude' : 'codex';
      const { secret } = await makeValueSecret(
        m4,
        `${provider} account`,
        credentialText(provider, { accessToken: tokenOf(provider) }),
      );
      const logPath = path.join(m4.state.root, `${provider}.log`);
      const { backend } = await makePool(m4, {
        kind,
        label: `${provider} pool`,
        members: [{ label: `${provider} member`, credential: secret }],
        baseUrl: server.url,
        logPath,
      });
      const opened = await openSession(m4, backend, { modelId });
      return { ...opened, logPath };
    };

    /**
     * @param {any} s
     * @param {string} input
     * @param {any[]} plan
     */
    const turnWith = async (s, input, plan) => {
      server.push(...plan);
      const before = posts(server).length;
      const result = await runTurn(m4, s.session, s.live, input);
      const text = JSON.stringify(result);
      for (const prose of PROSE)
        t.false(text.includes(prose), `${input}: no ${prose}`);
      return { ...result, sent: posts(server).length - before };
    };

    // ---- 8. Claude ----
    const claude = await single('claude-pool', CLAUDE_MODEL);
    const retried = await turnWith(claude, 'claude 529 then text', [
      { status: 529 },
      { sse: 'claude-text.sse' },
    ]);
    t.is(retried.status.state, 'completed', retried.status.error);
    t.is(retried.sent, 2, 'retried once on the same member');
    const late = await turnWith(claude, 'claude overload after a delta', [
      { sse: 'claude-overloaded-late.sse' },
      { sse: 'claude-text.sse' },
    ]);
    t.is(late.status.state, 'failed');
    t.is(late.status.error, subscriptionTexts.claudeInferenceFailed);
    t.is(late.sent, 1, 'not retried after a delivery');
    server.setPlan([]);
    const sseError = await turnWith(claude, 'claude SSE error', [
      { sse: 'claude-error.sse' },
    ]);
    t.is(sseError.status.error, subscriptionTexts.claudeInferenceFailed);
    const http = await turnWith(claude, 'claude non-200', [{ status: 500 }]);
    t.is(http.status.error, subscriptionTextOf.subscriptionHttp(500));
    const empty = await turnWith(claude, 'claude empty', [
      { sse: 'claude-empty.sse' },
    ]);
    t.is(empty.status.error, subscriptionTexts.emptyMessagesOutput);
    const claudeRetries = poolLog(claude.logPath).filter(
      l => l.kind === 'retry',
    );
    t.deepEqual(
      claudeRetries.map(l => l.waitMs),
      [5000],
      'D-M4-4: the first delay of the schedule',
    );

    // ---- 9. Codex ----
    const codex = await single('codex-pool', CODEX_MODEL);
    const codexRetried = await turnWith(codex, 'codex overloaded twice', [
      { sse: 'codex-overloaded.sse' },
      { sse: 'codex-overloaded.sse' },
      { sse: 'codex-text.sse' },
    ]);
    t.is(codexRetried.status.state, 'completed', codexRetried.status.error);
    t.is(codexRetried.sent, 3);
    t.deepEqual(
      poolLog(codex.logPath)
        .filter(l => l.kind === 'retry')
        .map(l => l.waitMs),
      [5000, 10_000],
      'R4-75, R4-105: 5 s then 10 s',
    );
    const codexLate = await turnWith(codex, 'codex overloaded after a delta', [
      { sse: 'codex-overloaded-late.sse' },
      { sse: 'codex-text.sse' },
    ]);
    t.is(codexLate.status.state, 'failed');
    t.is(codexLate.sent, 1, 'not retried after visible delivery');
    t.regex(
      String(codexLate.status.error),
      /^Subscription inference ended unsuccessfully \(response\.failed; code=server_is_overloaded/,
    );
    server.setPlan([]);
    const failed = await turnWith(codex, 'codex failure event', [
      { sse: 'codex-failed.sse' },
    ]);
    t.is(failed.status.state, 'failed');
    t.true(
      String(failed.status.error).startsWith(
        subscriptionTextOf.responsesFailed('response.failed', [
          'code=context_length_exceeded',
          'type=invalid_request_error',
          'param=input',
        ]),
      ),
      String(failed.status.error),
    );
    const codexEmpty = await turnWith(codex, 'codex empty', [
      { sse: 'codex-empty.sse' },
    ]);
    t.is(codexEmpty.status.error, subscriptionTexts.emptyResponsesOutput);
    const codexHttp = await turnWith(codex, 'codex non-200', [{ status: 503 }]);
    t.is(codexHttp.status.error, subscriptionTextOf.subscriptionHttp(503));

    // No prose in the transcripts either.
    for (const s of [claude, codex]) {
      // eslint-disable-next-line no-await-in-loop
      const page = JSON.stringify(await E(s.session).getHistoryPage());
      for (const prose of PROSE) t.false(page.includes(prose));
    }
  },
);
