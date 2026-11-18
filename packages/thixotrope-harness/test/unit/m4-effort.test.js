// @ts-check
// The reasoning-effort resolver (M4 W4.1; designs/m4-interfaces.md 5.4,
// H-6, H-7; R4-21..R4-23): appended last to `optionResolvers`;
// `reasoningEffort` no longer refused as "not yet"; on a pool the pool's
// `resolveEffort` decides and its answer is stored (absent: none); a
// preset default in `resolved.reasoningEffort` (M5) wins over the option;
// on an API or scripted backend any effort is refused.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { m4Texts } from '../../guest/lib/texts-m4.js';
import {
  optionResolvers,
  resolveCreateOptions,
} from '../../guest/factory/session-options.js';
import { subscriptionEffort } from '../../guest/factory/subscription-options.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const preset = Far('Preset', {
  snapshot: () => harden({ label: 'chat-only' }),
});

/**
 * A fake pool backend: `efforts` per model, `fallback` its default.
 * @param {{ kind?: string, efforts?: string[], fallback?: string }} [options]
 */
const makePool = ({
  kind = 'codex-pool',
  efforts = ['low', 'high', 'max'],
  fallback,
} = {}) => {
  /** @type {any[]} */
  const asked = [];
  const backend = Far('Backend', {
    describe: () => harden({ kind, label: 'pool' }),
    /** @param {string} [modelId] */
    resolveModel: modelId => harden({ modelId: modelId ?? 'model-a' }),
    /** @param {{ modelId: string, reasoningEffort?: string }} request */
    resolveEffort: request => {
      asked.push(request);
      const { reasoningEffort } = request;
      if (reasoningEffort === undefined)
        return harden(
          fallback === undefined ? {} : { reasoningEffort: fallback },
        );
      if (!efforts.includes(reasoningEffort))
        throw Error(m4Texts.unsupportedEffort);
      return harden({ reasoningEffort });
    },
  });
  return { backend, asked };
};

test('the resolver is the last entry of the hook table', t => {
  t.is(optionResolvers.at(-1), subscriptionEffort);
});

test('a pool stores the effort it accepts and refuses one it does not offer', async t => {
  const { backend, asked } = makePool();
  const resolved = await resolveCreateOptions(
    harden({ backend, preset, modelId: 'model-a', reasoningEffort: 'high' }),
    /** @type {any} */ ({ defaultPreset: preset }),
  );
  t.is(resolved.reasoningEffort, 'high');
  t.is(resolved.modelId, 'model-a');
  t.deepEqual(asked, [{ modelId: 'model-a', reasoningEffort: 'high' }]);
  await t.throwsAsync(
    () =>
      resolveCreateOptions(
        harden({
          backend,
          preset,
          modelId: 'model-a',
          reasoningEffort: 'ultra',
        }),
        /** @type {any} */ ({ defaultPreset: preset }),
      ),
    { message: m4Texts.unsupportedEffort },
  );
});

test('no effort given: the pool default is stored, or none', async t => {
  for (const [fallback, expected] of /** @type {const} */ ([
    ['medium', 'medium'],
    [undefined, undefined],
  ])) {
    const { backend } = makePool({ kind: 'claude-pool', fallback });
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveCreateOptions(
      harden({ backend, preset, modelId: 'model-a' }),
      /** @type {any} */ ({ defaultPreset: preset }),
    );
    t.is(resolved.reasoningEffort, expected);
    t.false(fallback === undefined && 'reasoningEffort' in resolved);
  }
});

test('a preset default in resolved wins over the option (M5 fills it before the resolvers)', async t => {
  const { backend, asked } = makePool();
  /** @type {Record<string, any>} */
  const resolved = {
    backend,
    backendKind: 'codex-pool',
    modelId: 'model-a',
    reasoningEffort: 'max',
  };
  await subscriptionEffort(
    harden({ reasoningEffort: 'low' }),
    resolved,
    /** @type {any} */ ({}),
  );
  t.is(resolved.reasoningEffort, 'max');
  t.deepEqual(asked, [{ modelId: 'model-a', reasoningEffort: 'max' }]);
});

test('an effort on an API or scripted backend is refused; none is fine', async t => {
  for (const kind of ['anthropic', 'openrouter', 'scripted']) {
    const backend = Far('Backend', {
      describe: () => harden({ kind, label: kind }),
      resolveModel: () => harden({ modelId: 'model-a' }),
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        resolveCreateOptions(
          harden({
            backend,
            preset,
            modelId: 'model-a',
            reasoningEffort: 'high',
          }),
          /** @type {any} */ ({ defaultPreset: preset }),
        ),
      { message: m4Texts.effortNotSupported },
      kind,
    );
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveCreateOptions(
      harden({ backend, preset, modelId: 'model-a' }),
      /** @type {any} */ ({ defaultPreset: preset }),
    );
    t.false('reasoningEffort' in resolved, kind);
  }
});

test('a malformed pool answer is refused', async t => {
  for (const answer of [
    { reasoningEffort: 'x'.repeat(33) },
    { reasoningEffort: 3 },
    { effort: 'high' },
    { reasoningEffort: 'high', extra: 1 },
  ]) {
    const backend = Far('Backend', { resolveEffort: () => harden(answer) });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        subscriptionEffort(
          harden({}),
          { backend, backendKind: 'claude-pool', modelId: 'm' },
          /** @type {any} */ ({}),
        ),
      { message: m4Texts.unsupportedEffort },
    );
  }
});

test('the model is still required on a pool that is not the default (M2 rule, before the effort)', async t => {
  const { backend, asked } = makePool();
  const other = Far('Backend', {});
  await t.throwsAsync(
    () =>
      resolveCreateOptions(
        harden({ backend, preset, reasoningEffort: 'high' }),
        /** @type {any} */ ({ defaultPreset: preset, defaultBackend: other }),
      ),
    { message: texts.modelRequired },
  );
  t.is(asked.length, 0);
});
