// @ts-check
/**
 * Helpers of W5.5's integration tests and perf check (m5-objects,
 * m5-security, perf/exec-m5, the tools.inspect row): the m5o state
 * template (the m1b template's provisioning with the factory's default pool
 * plus the M5 fixture step, so the workspace vat holds the fixture objects
 * of `test/fixtures/m5-objects.js`), the fixtures, and a session created
 * from a user preset that endows chosen fixtures from the operator
 * inventory. AVA skips files starting with an underscore.
 */

import { E } from '@endo/far';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
/* eslint-disable import/no-relative-packages */
import { ANSWER_OVER_FRAME_TEXT } from '../../guest/exec/inspect.js';
import { texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { makeProvision } from '../../scripts/provision-steps.js';
import { m5FixtureName, m5FixtureSource } from '../fixtures/m5-objects.js';
import { ensureTemplate } from '../template/index.js';

/**
 * The outcome of a too-big answer behind an inspector tool, from its
 * recorded result (a text or a StagedText): the exec vat stopped
 * (`inspectTerminated`), the hub refused the answer for size before the
 * exec vat decoded it (`hubRefused`: core CC-027, the inspector's
 * `ANSWER_OVER_FRAME_TEXT`), or the exec vat decoded, cut and staged it
 * (`staged`); undefined for anything else. One predicate for m5-objects'
 * 200 KB help, m5-security's 300 KB granted answer and perf/exec-m5's
 * probe b.
 * @param {any} result
 * @returns {'inspectTerminated' | 'hubRefused' | 'staged' | undefined}
 */
export const tooBigOutcome = result => {
  if (result === textOf.errorResult(texts.inspectTerminated)) {
    return 'inspectTerminated';
  }
  if (result === textOf.errorResult(ANSWER_OVER_FRAME_TEXT)) {
    return 'hubRefused';
  }
  if (
    typeof result === 'object' &&
    result !== null &&
    Number(result.bytes) > 0
  ) {
    return 'staged';
  }
  return undefined;
};
harden(tooBigOutcome);

export const usage = harden({
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/** @param {{ name: string, args: string, times?: number }[]} toolCalls */
export const callRound = toolCalls => ({
  chunks: [{ text: 'tools' }],
  toolCalls,
  usage,
});
export const closing = harden({ chunks: [{ text: 'done' }], usage });

/**
 * One tool call.
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export const call = (name, args) => ({ name, args: JSON.stringify(args) });
/** @param {string} code */
export const exec = code => call('exec', { code });

/**
 * A scripted turn of one tool call per round, then a closing text round.
 * @param {string} input
 * @param {{ name: string, args: string }[]} calls
 */
export const turnOf = (input, calls) => ({
  input,
  rounds: [...calls.map(c => callRound([c])), closing],
});

const fixtureOption = harden({ name: m5FixtureName, source: m5FixtureSource });

/** The m5o template: m1b's provisioning, the default pool, the fixtures. */
export const objectsTemplate = async () => {
  /** @type {any[]} */
  const steps = [];
  const run = makeProvision({
    pool: {},
    m5Fixtures: fixtureOption,
    onStep: report => steps.push(report),
  });
  const template = await ensureTemplate({
    id: 'm5o',
    // The fixture objects' source is evaluated into the workspace; the pool
    // is the factory's default.
    sources: ['test/fixtures/m5-objects.js'],
    extra: { pool: {} },
    /** @param {{ client: any, connect?: any }} context */
    provision: async context => {
      await run(context);
    },
  });
  if (template.built)
    emit({
      metric: 'm5o.template',
      buildMs: template.buildMs,
      steps: steps.map(s => ({ name: s.name, ms: s.ms, skipped: s.skipped })),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  return template;
};

/**
 * The fixture objects of a served state (`makeFixtures().all()`).
 * @param {{ client: any }} state
 */
export const fixturesOf = async state => {
  const fixtures = await state.client.call('lookup', m5FixtureName);
  if (fixtures === undefined) throw Error('the m5o template has no fixtures');
  return E(fixtures).all();
};

/**
 * The operator's catalogue and inventory.
 * @param {any} slice
 */
export const operatorOf = async slice => {
  const operator = await E(slice.harness).getOperator();
  return {
    catalog: await E(operator).getPresets(),
    inventory: await E(operator).getInventory(),
  };
};

/**
 * Put `chosen` fixtures into the operator inventory (once per label) and
 * create a user preset `label` endowing them from the inventory rows.
 * Answers the preset.
 * @param {any} slice
 * @param {Record<string, any>} chosen label -> object
 * @param {{ label: string, backend: any }} options
 */
export const endowedPreset = async (slice, chosen, { label, backend }) => {
  const { catalog, inventory } = await operatorOf(slice);
  const page = await E(inventory).list();
  const held = new Map(
    page.rows.map((/** @type {any} */ r) => [r.label, r.value]),
  );
  const missing = Object.entries(chosen)
    .filter(([name]) => !held.has(name))
    .map(([name, value]) => harden({ label: name, value }));
  if (missing.length > 0) await E(inventory).addAll(harden(missing));
  const rows = (await E(inventory).list()).rows;
  const endowments = rows
    .filter((/** @type {any} */ r) => r.label in chosen)
    .map((/** @type {any} */ r) => harden({ label: r.label, value: r.value }));
  const { revision } = await E(catalog).configuration();
  const { preset } = await E(catalog).create(
    harden({ label, template: 'general', backend, endowments }),
    revision,
  );
  return preset;
};

/**
 * A session from `preset` on `backend`.
 * @param {any} slice
 * @param {any} preset
 * @param {any} backend
 * @param {string} [title]
 */
export const presetSession = (slice, preset, backend, title = 'm5 objects') =>
  E(slice.factory).createSession(
    harden({ title, preset, backend, at: Date.now() }),
  );
