// @ts-check
/**
 * M0 perf check "install of a 300 k factory bundle" (CORE-1b,
 * milestones.md M0; architecture.md section 11): the control `install` of a
 * program of about 300,000 characters, end to end. The supervisor's
 * installer stages the program into the new vat with `evaluateSource`
 * (pkg/src/core/evaluate-source.js), whose staging chunk CORE-1b sets.
 *
 *   cd packages/thixotrope-harness && node perf/install.perf.mjs
 *
 * INSTALL_N (default 3) installs of the ASCII program, each into a fresh
 * vat, then one install of a program with a large non-ASCII literal (BMP
 * three-byte characters and surrogate pairs) whose content the vat checks.
 * INSTALL_CHARS (default 300,000) sets the program size;
 * THIXOTROPE_CRANK_BUDGET overrides the budget.
 */
import { performance } from 'node:perf_hooks';

import {
  crankBudget,
  deliveries,
  emit,
  runPerf,
  single,
  stats,
} from './_harness.mjs';

// After the harness module (it locks down first, J-0131).
const { E } = await import('@endo/far');
// eslint-disable-next-line import/no-relative-packages -- core internals, measured here
const staging = await import('../../thixotrope/src/core/evaluate-source.js');

const N = Number(process.env.INSTALL_N ?? 3);
const CHARS = Number(process.env.INSTALL_CHARS ?? 300_000);
/** M0 perf table: install of a 300 k factory bundle. */
const BUDGET_MS = 30_000;

/**
 * The staging chunk the core uses: the named constant since CORE-1b, the
 * literal 1,024 before it.
 */
const stagingChunkChars =
  /** @type {any} */ (staging).STAGING_CHUNK_CHARS ?? 1024;

/**
 * A factory program of about `chars` UTF-16 units: many small functions
 * built when the namespace evaluates, and a string literal whose length and
 * checksum the made object reports.
 * @param {number} chars
 * @param {string} text the literal's content (no quote or backslash)
 */
const makeFactory = (chars, text) => {
  const head = `({ make: (() => {\n  const fns = [];\n  const text = '${text}';\n`;
  const tail = `  return () => Far('Big', {
    ping: () => 1,
    count: () => fns.length,
    check: () => { let sum = 0; for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) % 2147483647; return [text.length, sum]; },
  });
})() })`;
  const lines = [head];
  let length = head.length + tail.length;
  let i = 0;
  for (;;) {
    const line = `  fns.push((a, b) => { const v${i} = a * ${i % 97} + b; return v${i} % 7 === 3 ? 'three' : v${i}; });\n`;
    if (length + line.length > chars) break;
    lines.push(line);
    length += line.length;
    i += 1;
  }
  lines.push(tail);
  return { source: lines.join(''), functions: i };
};

/** @param {string} text */
const checksum = text => {
  let sum = 0;
  for (let i = 0; i < text.length; i += 1)
    sum = (sum * 31 + text.charCodeAt(i)) % 2_147_483_647;
  return [text.length, sum];
};

/** @param {string} source */
const utf8Bytes = source => Buffer.byteLength(source, 'utf8');

await runPerf('install', async ({ provision }) => {
  const run = await provision();
  const settings = { stagingChunkChars, sourceTarget: CHARS };
  let count = 0;

  /**
   * Install one program into a fresh vat, check what it made.
   * @param {string} metricPrefix
   * @param {{ source: string, functions: number }} program
   * @param {string} text
   */
  const installOnce = async (metricPrefix, program, text) => {
    count += 1;
    const name = `i${count}`;
    const before = await run.counters();
    const t0 = performance.now();
    let error;
    try {
      await run.client.call('install', name, program.source, []);
    } catch (e) {
      error = String(/** @type {Error} */ (e)?.message ?? e).slice(0, 300);
    }
    const ms = performance.now() - t0;
    const after = await run.counters();
    let ok = error === undefined;
    if (ok) {
      const vat = await run.client.call('lookup', name);
      const [functions, check] = await Promise.all([
        E(vat).count(),
        E(vat).check(),
      ]);
      const expected = checksum(text);
      ok =
        functions === program.functions &&
        check[0] === expected[0] &&
        check[1] === expected[1];
      if (!ok) error = `content mismatch: ${functions} ${check} ${expected}`;
    }
    await run.client.call('remove', name).catch(() => {});
    if (!ok) {
      process.exitCode = 1;
      emit({ metric: `${metricPrefix}.error`, error, ms, pass: false });
    }
    return { ms, ok, before, after };
  };

  // The ASCII program: the shape of a bundled factory.
  const ascii = makeFactory(CHARS, 'plain ASCII text');
  const samples = [];
  let first;
  let last;
  for (let i = 0; i < N; i += 1) {
    const r = await installOnce(
      'install.factory300k',
      ascii,
      'plain ASCII text',
    );
    if (!r.ok) break;
    samples.push(r.ms);
    first ??= r.before;
    last = r.after;
  }
  if (samples.length && first && last) {
    await stats('install.factory300k', samples, {
      budget: { median: BUDGET_MS, max: BUDGET_MS },
      before: first,
      after: last,
      ops: samples.length,
      root: run.root,
      extra: {
        ...settings,
        sourceChars: ascii.source.length,
        utf8Bytes: utf8Bytes(ascii.source),
        stagedMessages: Math.ceil(ascii.source.length / stagingChunkChars),
      },
    });
  }

  // A program with a large non-ASCII literal: runs of three-byte
  // characters (the frameBytes worst case) and surrogate pairs, so chunk
  // boundaries fall inside pairs. The vat's checksum shows nothing split.
  const units = [];
  let unitsLength = 0;
  while (unitsLength < CHARS / 3) {
    units.push('€'.repeat(9000), '\u{1f600}é\u{1d11e}'.repeat(1500));
    unitsLength += 9000 + 1500 * 5;
  }
  const text = units.join('');
  const mixed = makeFactory(CHARS, text);
  const r = await installOnce('install.factory300kMixed', mixed, text);
  await single('install.factory300kMixed', r.ms, {
    budget: { value: BUDGET_MS },
    extra: {
      ...settings,
      ok: r.ok,
      sourceChars: mixed.source.length,
      utf8Bytes: utf8Bytes(mixed.source),
      textChars: text.length,
      stagedMessages: Math.ceil(mixed.source.length / stagingChunkChars),
      deliveries: deliveries(r.before, r.after, 1),
    },
  });
  emit({ metric: 'install.done', crankBudget, stagingChunkChars });
});
