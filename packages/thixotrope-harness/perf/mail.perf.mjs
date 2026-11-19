// @ts-check
/** Measured operator and session mail, bounded inbox delivery, throughput and hub growth. */
import { performance } from 'node:perf_hooks';
import { emit, hubJsonBytes, loadAvg, runPerf, stats } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { sliceScript } = await import('../test/fixtures/scripts/m1a-slice.js');
const { connect, TEMPLATE_WORKSPACE } =
  await import('../test/template/index.js');
const { makeSlice, sliceTemplate, waitFor } =
  await import('../test/integration/_m1a-slice.js');
const { names } = await import('../scripts/provision-steps.js');

const window = windowMs('MAIL_WINDOW_MS', 60_000);
const growthWindow = windowMs('MAIL_GROWTH_WINDOW_MS', 120_000);

/** @param {any} mailbox @param {any} session @param {any[]} attachments @param {string} [body] */
const post = async (mailbox, session, attachments, body = 'ping') => {
  const start = performance.now();
  const { results } = await E(mailbox).send(
    harden({ to: [session], body, attachments }),
  );
  const elapsed = performance.now() - start;
  const { postmark, refused } = results[0];
  if (!Number.isSafeInteger(postmark))
    throw Error(refused || 'Missing postmark');
  return { postmark, elapsed };
};

/** @param {any} mailbox @param {number[]} expected */
const dismissReplies = async (mailbox, expected) => {
  const pending = new Set(expected);
  let peak = 0;
  await waitFor(
    async () => {
      const { messages } = await E(mailbox).list();
      peak = Math.max(peak, messages.length);
      for (const m of messages) {
        if (pending.delete(m.inReplyTo)) await E(m.message).dismiss();
      }
      return pending.size === 0;
    },
    60_000,
    'the mail turns and their replies',
  );
  return peak;
};

/** @param {string} name @param {Record<string, any>} args */
const call = (name, args) => ({
  chunks: [{ text: 'tool' }],
  toolCalls: [{ name, args: JSON.stringify(args) }],
});

await runPerf('mail', async ({ provision }) => {
  const run = await provision({ template: await sliceTemplate() });
  const slice = await makeSlice(run);
  const made = await slice.makeBackend(harden(sliceScript));
  const receiver = await slice.createSession(made.backend, 'Mail recipient');
  const mailbox = await E(E(slice.harness).getOperator()).getMail();
  const one = async () => {
    const { postmark, elapsed } = await post(mailbox, receiver, []);
    await dismissReplies(mailbox, [postmark]);
    return elapsed;
  };
  await one();
  const op = await runWindow(one, { ms: window });
  await stats('mail.post.operator', op.results, {
    budget: { median: 200 },
    extra: windowFields(op),
  });

  const senderBackend = await slice.makeBackend(
    harden({
      turns: [
        {
          input: 'remember',
          rounds: [
            call('adopt', {
              messageNumber: 1,
              edgeName: 'target',
              petName: 'target',
            }),
            { chunks: [{ text: 'ready' }] },
          ],
        },
        {
          input: 'forward',
          rounds: [
            call('send', { recipient: ['target'], strings: ['ping'] }),
            { chunks: [{ text: 'sent' }] },
          ],
        },
      ],
    }),
    { label: 'Mail sender' },
  );
  // The receiver for this interval starts with an empty transcript, independent
  // of how many messages the preceding operator window completed.
  const betweenReceiver = await slice.createSession(
    made.backend,
    'Session mail recipient',
  );
  const sender = await slice.createSession(
    senderBackend.backend,
    'Mail sender',
  );
  const receipt = await post(
    mailbox,
    sender,
    [{ label: 'target', value: await E(mailbox).addressOf(betweenReceiver) }],
    'remember',
  );
  await dismissReplies(mailbox, [receipt.postmark]);
  const between = await runWindow(
    async () => {
      const before = made.log().length;
      const { turn } = await slice.submit(sender, 'forward');
      const { turnId, state } = await E(turn).whenFinished();
      if (state !== 'completed') throw Error(`sender ended ${state}`);
      const start = senderBackend
        .log()
        .find(
          line =>
            line.turnId === turnId &&
            line.round === 0 &&
            line.kind === 'round-final',
        );
      const end = await waitFor(
        () =>
          made
            .log()
            .slice(before)
            .find(line => line.kind === 'request'),
        60_000,
        'recipient provider request',
      );
      return Number(end.at) - Number(start.at);
    },
    { ms: window },
  );
  await stats('mail.sessionToSession', between.results, {
    budget: { median: 300 },
    extra: windowFields(between),
  });

  // Import the kept messages in bounded pages. Every sampled delivery starts with 255 kept rows.
  const full = await E(slice.harness).importSession(
    harden({ title: 'Full inbox', backend: made.backend, at: Date.now() }),
  );
  await E(full.internal).importState(harden({ part: 'head' }));
  for (let from = 1; from <= 255; from += 16) {
    const messages = Array.from(
      { length: Math.min(16, 256 - from) },
      (_, i) => ({
        number: from + i,
        type: 'reply',
        fromTitle: 'operator',
        body: 'kept',
        edges: [],
        at: 0,
        state: 'kept',
      }),
    );
    await E(full.internal).importState(harden({ part: 'inbox', messages }));
  }
  await E(full.internal).importState(harden({ part: 'end' }));
  const attached = Array.from({ length: 32 }, (_, i) => ({
    label: `edge-${i}`,
    value: receiver,
  }));
  const hist = async () => (await run.client.call('status')).deliveryHistogram;
  const counts = [];
  const crank = await runWindow(
    async () => {
      const before = await hist();
      const r = await post(mailbox, full.session, attached);
      const after = await hist();
      for (const [i, n] of after.counts.entries())
        counts[i] = (counts[i] || 0) + Number(n) - Number(before.counts[i]);
      await dismissReplies(mailbox, [r.postmark]);
      return after.bounds;
    },
    { ms: window },
  );
  const upper = crank.results[0];
  const total = counts.reduce((a, b) => a + b, 0);
  /** @param {number} q */
  const quantile = q => {
    let n = 0;
    const i = counts.findIndex(c => {
      n += c;
      return n >= total * q;
    });
    return i < 0 || i >= upper.length ? Infinity : upper[i];
  };
  const p95 = quantile(0.95);
  emit({
    metric: 'mail.inboxCrank',
    unit: 'ms',
    counts,
    bounds: upper,
    median: quantile(0.5),
    p95,
    interval: 'all measured deliveries from operator send through receipt',
    budget: { p95: 550 },
    pass: total > 0 && p95 <= 550,
    ...windowFields(crank),
  });
  if (!total || p95 > 550) process.exitCode = 1;

  await E(slice.harness).configure(harden({ backends: [made.backend] }));
  const clients = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      const client = await connect(run.root, { workspace: TEMPLATE_WORKSPACE });
      const root = await client.call('lookup', names.harness);
      const operator = await E(root).getOperator();
      const factory = await E(operator).getFactory();
      const [backend] = await E(factory).listBackends();
      const [preset] = await E(factory).listPresets();
      const [a, b] = await Promise.all(
        [0, 1].map(j =>
          E(factory).createSession(
            harden({
              title: `Mailbox ${i}-${j}`,
              backend,
              preset,
              at: Date.now(),
            }),
          ),
        ),
      );
      clients.push({
        client,
        mailbox: await E(operator).getMail(),
        sessions: [a, b],
        attachments: [
          { label: 'preset', value: preset },
          { label: 'backend', value: backend },
        ],
      });
    }
    /** @param {number} ms @param {boolean} edges */
    const measureThroughput = async (ms, edges) => {
      let largest = 0;
      let posts = 0;
      // Each sender alternates its two recipients. Concurrent consumers share
      // one inbox page request; each consumes only its own reply.
      /** @type {Promise<any> | undefined} */
      let page;
      const readPage = () => {
        page ??= E(mailbox)
          .list()
          .finally(() => {
            page = undefined;
          });
        return page;
      };
      const start = performance.now();
      await Promise.all(
        clients.map(async c => {
          let n = 0;
          do {
            const { postmark } = await post(
              c.mailbox,
              c.sessions[n % 2],
              edges ? c.attachments : [],
            );
            const reply = await waitFor(
              async () => {
                const { messages } = await readPage();
                largest = Math.max(largest, messages.length);
                return messages.find(m => m.inReplyTo === postmark);
              },
              60_000,
              'the recipient turn and its reply',
            );
            await E(reply.message).dismiss();
            posts += 1;
            n += 1;
          } while (performance.now() - start < ms);
        }),
      );
      const elapsedMs = performance.now() - start;
      return { posts, largest, w: { samples: posts, ms, elapsedMs, few: 10 } };
    };
    const rate = await measureThroughput(window, false);
    const perSecond = (rate.posts * 1000) / rate.w.elapsedMs;
    emit({
      metric: 'mail.throughput',
      unit: 'posts/s',
      value: perSecond,
      posts: rate.posts,
      largestInbox: rate.largest,
      loadAvg: loadAvg(),
      budget: { minimum: 3 },
      pass: perSecond >= 3,
      ...windowFields(rate.w),
    });
    if (perSecond < 3) process.exitCode = 1;
    const before = await hubJsonBytes(run.root);
    const growth = await measureThroughput(growthWindow, true);
    for (let i = 0; i < 32; i += 1) await E(mailbox).rev();
    const after = await hubJsonBytes(run.root);
    const ratio = before && after ? after / before : Infinity;
    emit({
      metric: 'mail.hubGrowth',
      unit: 'ratio',
      value: ratio,
      before,
      after,
      posts: growth.posts,
      budget: { maximum: 1.25 },
      pass: ratio <= 1.25,
      ...windowFields(growth.w),
    });
    if (ratio > 1.25) process.exitCode = 1;
  } finally {
    for (const { client } of clients) client.close();
  }
});
