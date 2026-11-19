// @ts-check
/**
 * Mail perf (designs/m9-interfaces.md 10.1), through the daemon from the
 * m1a state template (the real factory and session programs).
 *
 * - `mail.post.operator`: the control client's `OperatorMailbox.send` of a
 *   short package to one session, call to answer, back to back over a fixed
 *   window (MAIL_WINDOW_MS, default 60 s); budget median <= 200 ms (the
 *   control hop 37 ms plus two vat round trips of 66 ms, J-9333, J-10192).
 *   Each row carries the deliveries per post from `status().timings`.
 *
 * The session's `inbox` part is built but not registered in the session
 * program (D-M9-19), so the recipient's `deliverMail` answers the not-built
 * text: the row measures the whole relay (factory crank, the delivery into
 * the session vat and its answer, the receipt) without the inbox's record
 * and claim. It says so (`recipient: 'not-built'`).
 *
 * The rows that need a mail turn in the recipient (`mail.sessionToSession`,
 * `mail.throughput`, `mail.inboxCrank`, `mail.hubGrowth`) are printed as
 * not measured, with the reason, until the parts are registered; they never
 * pass silently.
 *
 *   node scripts/run-lock.mjs --exclusive --label mail -- node perf/mail.perf.mjs
 *   PERF_WINDOW_SCALE=0.1 node perf/mail.perf.mjs --shared      # smoke
 */
import { emit, runPerf, stats } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { sliceScript } = await import('../test/fixtures/scripts/m1a-slice.js');
const { makeSlice, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { texts } = await import('../guest/lib/guards/session.js');

const WINDOW_MS = windowMs('MAIL_WINDOW_MS', 60_000);
const WARMUP = 5;

/** Rows that need the registered inbox part (a mail turn in the recipient). */
const needsInbox = harden([
  'mail.sessionToSession',
  'mail.throughput',
  'mail.inboxCrank',
  'mail.hubGrowth',
]);

await runPerf('mail', async ({ provision }) => {
  const template = await sliceTemplate();
  const run = await provision({ template });
  const slice = await makeSlice(run);
  const { backend } = await slice.makeBackend(harden(sliceScript));
  const session = await slice.createSession(backend, 'mail perf');
  const operator = await E(slice.harness).getOperator();
  const mailbox = await E(operator).getMail();
  const draft = harden({ to: [session], body: 'ping', attachments: [] });

  const post = async () => {
    const { results } = await E(mailbox).send(draft);
    return results[0].refused;
  };
  for (let i = 0; i < WARMUP; i += 1) await post();
  const before = await run.counters();
  const w = await runWindow(post, { ms: WINDOW_MS });
  const after = await run.counters();
  const answers = new Set(w.results);
  await stats('mail.post.operator', w.samples, {
    budget: { median: 200 },
    before,
    after,
    extra: {
      ...windowFields(w),
      recipient: answers.has(texts.notBuiltYet) ? 'not-built' : 'inbox',
      by: 'W9.10',
    },
  });

  for (const metric of needsInbox) {
    emit({
      metric,
      measured: false,
      reason:
        'needs the inbox part registered in the session program (m9-interfaces.md D-M9-19: over the limit with it)',
      by: 'W9.10',
    });
  }
});
