// @ts-check
/**
 * Perf check "images" (`designs/m8-interfaces.md` 13 and 14): the adapter's
 * cost of image results in provider requests (Node, no vat).
 *
 *   cd packages/thixotrope-harness && node perf/images.perf.mjs
 *
 * Rows:
 * - `images.requestBuild.<wire>`: per new 2 MiB image, the extra time to
 *   build a request body (the wire's messages and their JSON) with one
 *   `viewImage` result over the same transcript with a text result; the
 *   Messages API (Anthropic API and Claude pool) and Responses (Codex
 *   pool). Each operation takes an envelope the decode cache (20 entries)
 *   does not hold. Budget median 15 ms.
 * - `images.manyInOneRound` (probe of section 14): 64 `viewImage` results
 *   of 2 MiB in one transcript: the Messages body carries the newest 20 as
 *   image blocks and 44 receipts; its build time and size, recorded.
 *
 * Not here (they need the session's `viewImage` entry in the tool table,
 * which waits for the PM's ruling on the session-program cap; see the
 * journal): `images.view`, `images.viewFromVat`, `images.frameIntoVat`, and
 * `images.contextPrepare` (a session context holding 20 image results).
 *
 * IMAGES_WINDOW_MS (20 s per wire and baseline), scaled by
 * PERF_WINDOW_SCALE. About 2 minutes.
 */
import { runPerf, single, stats } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { encodeImageEnvelope } =
  await import('../resources/agent-host/impl/providers/images.js');
const { anthropicMessages } =
  await import('../resources/agent-host/impl/providers/anthropic.js');
const { codexInput } =
  await import('../resources/agent-host/impl/subscriptions/responses.js');

const WINDOW_MS = windowMs('IMAGES_WINDOW_MS', 20_000);

/** 2 MiB, a multiple of 3 below it so the base64 has no padding. */
const IMAGE_BYTES = 2 * 1024 * 1024 - 2;

/** Envelopes more than the decode cache holds, each distinct. */
const POOL = 24;

/** @param {number} seed */
const pngEnvelope = seed => {
  const raw = Buffer.alloc(IMAGE_BYTES, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(raw);
  return encodeImageEnvelope({
    mediaType: 'image/png',
    data: raw.toString('base64'),
  });
};

/**
 * A transcript with `results` tool results of the named tool.
 * @param {string} name
 * @param {string[]} results
 */
const transcriptOf = (name, results) =>
  harden([
    { kind: 'message', role: 'user', content: 'look at these' },
    ...results.flatMap((content, i) => [
      {
        kind: 'tool-call',
        id: `t1/r0/c${i}`,
        name,
        args: '{"petName":"shot"}',
      },
      { kind: 'tool-result', id: `t1/r0/c${i}`, content },
    ]),
    { kind: 'message', role: 'assistant', content: 'seen' },
  ]);

/** @param {number[]} values */
const median = values => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const wires = harden({
  messages: (/** @type {any[]} */ transcript) =>
    JSON.stringify(anthropicMessages(transcript, 'claude-haiku-4-5')).length,
  responses: (/** @type {any[]} */ transcript) =>
    JSON.stringify(codexInput(transcript, 'gpt-5')).length,
});

await runPerf('images', async () => {
  const pool = Array.from({ length: POOL }, (_, i) => pngEnvelope(i + 1));
  const text = transcriptOf('exec', ['a short text result']);
  for (const [wire, build] of Object.entries(wires)) {
    const baseline = await runWindow(
      async () => {
        build(text);
      },
      { ms: WINDOW_MS / 4, min: 10 },
    );
    const base = median(baseline.samples);
    let i = 0;
    const w = await runWindow(
      async () => {
        build(transcriptOf('viewImage', [pool[i % POOL]]));
        i += 1;
      },
      { ms: WINDOW_MS, min: 10 },
    );
    await stats(
      `images.requestBuild.${wire}`,
      w.samples.map(ms => ms - base),
      {
        budget: { median: 15 },
        extra: { ...windowFields(w), baselineMs: +base.toFixed(3) },
      },
    );
  }

  // Probe: 64 image results in one round.
  const many = transcriptOf(
    'viewImage',
    Array.from({ length: 64 }, (_, k) => pool[k % POOL]),
  );
  const t0 = performance.now();
  const messages = anthropicMessages(many, 'claude-haiku-4-5');
  const bodyBytes = JSON.stringify(messages).length;
  const ms = performance.now() - t0;
  const blocks = messages.flatMap((/** @type {any} */ m) =>
    Array.isArray(m.content) ? m.content : [],
  );
  const results = blocks.filter(
    (/** @type {any} */ b) => b.type === 'tool_result',
  );
  const native = results.filter(
    (/** @type {any} */ b) =>
      Array.isArray(b.content) &&
      b.content.some((/** @type {any} */ c) => c.type === 'image'),
  ).length;
  await single('images.manyInOneRound', ms, {
    extra: {
      results: results.length,
      native,
      receipts: results.length - native,
      bodyBytes,
      gate: native === 20 && results.length === 64,
    },
  });
  if (native !== 20 || results.length !== 64) process.exitCode = 1;
});
