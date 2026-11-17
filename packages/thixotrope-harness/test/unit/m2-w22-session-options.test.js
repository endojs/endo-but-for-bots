// @ts-check
// M2 W2.2: the creation resolver for the model (guest/factory/
// session-options.js `catalogueModel`; designs/m2-interfaces.md 8.4; spec
// R4-21, R4-22, R4-33), with fake Backends whose resolveModel is the real
// adapter catalogue over a fixed observation. Acceptance 11's rule at the
// resolver: a session stores the model resolved at its creation, and a
// later change of the factory's default model changes only new creations.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import {
  optionResolvers,
  resolveCreateOptions,
} from '../../guest/factory/session-options.js';
/* eslint-enable import/no-relative-packages */
import { makeCatalog } from '../../resources/agent-host/impl/providers/catalog.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const CATALOG = harden({
  data: [
    {
      id: 'org/default',
      name: 'Default',
      context_length: 100_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
    },
    {
      id: 'org/other',
      name: 'Other',
      context_length: 32_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
    },
  ],
});

/** A fetch that answers the catalogue and counts its calls. */
const makeFetch = () => {
  let calls = 0;
  /** @type {typeof globalThis.fetch} */
  const fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(CATALOG), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls: () => calls };
};

/**
 * A Backend as the manager makes it, forwarding to the adapter catalogue.
 * @param {ReturnType<typeof makeCatalog>} catalog
 * @param {Record<string, any>} spec
 */
const makeBackend = (catalog, spec) => {
  /** @type {any[]} */
  const asked = [];
  const backend = Far('Backend', {
    describe: () =>
      harden({
        kind: spec.kind,
        label: spec.label,
        ...(spec.modelId === undefined ? {} : { modelId: spec.modelId }),
      }),
    /** @param {string} [modelId] */
    resolveModel: modelId => {
      asked.push(modelId);
      return catalog.resolveModel({
        backend,
        spec: harden(spec),
        readKey: async () => 'not a real key',
        ...(modelId === undefined ? {} : { modelId }),
      });
    },
  });
  return { backend, asked };
};

const preset = Far('Preset', {
  snapshot: () => harden({ label: 'chat-only' }),
});

test('the resolver is in the hook table after describeObjects', t => {
  t.true(optionResolvers.length >= 4);
});

test('an empty model on the default backend follows the factory model; pinned models are checked (R4-21)', async t => {
  const { fetch, calls } = makeFetch();
  const catalog = makeCatalog({ fetch });
  const main = makeBackend(catalog, {
    kind: 'openrouter',
    label: 'main',
    modelId: 'org/default',
    maxOutputTokens: 4096,
  });
  const second = makeBackend(catalog, {
    kind: 'openrouter',
    label: 'second',
    modelId: 'org/default',
  });
  const context = { defaultPreset: preset, defaultBackend: main.backend };

  // No backend, no model: the default backend and its own model.
  const plain = await resolveCreateOptions(harden({}), context);
  t.is(plain.backend, main.backend);
  t.is(plain.modelId, 'org/default');
  t.is(plain.contextLength, 100_000);
  t.is(plain.maxOutputTokens, 4096);
  t.deepEqual(main.asked, [undefined]);

  // The factory's configured model wins on the default backend.
  const configured = await resolveCreateOptions(harden({}), {
    ...context,
    defaultModelId: 'org/other',
  });
  t.is(configured.modelId, 'org/other');
  t.is(configured.contextLength, 32_000);

  // Another backend needs a model.
  await t.throwsAsync(
    () => resolveCreateOptions(harden({ backend: second.backend }), context),
    { message: texts.modelRequired },
  );
  t.deepEqual(second.asked, []);
  const pinned = await resolveCreateOptions(
    harden({ backend: second.backend, modelId: 'org/other' }),
    context,
  );
  t.is(pinned.modelId, 'org/other');
  t.is(pinned.maxOutputTokens, undefined);

  // Pinned models: prefix and catalogue membership.
  await t.throwsAsync(
    () =>
      resolveCreateOptions(
        harden({ backend: second.backend, modelId: 'other' }),
        context,
      ),
    { message: texts.openRouterModelPrefix },
  );
  await t.throwsAsync(
    () =>
      resolveCreateOptions(
        harden({ backend: second.backend, modelId: 'org/gone' }),
        context,
      ),
    { message: textOf.unknownProviderModel('org/gone') },
  );
  // One catalogue read per backend served all of it.
  t.is(calls(), 2);
});

test('R4-22: a resolved model is what the creation stores; a later default change does not reach it', async t => {
  const { fetch } = makeFetch();
  const catalog = makeCatalog({ fetch });
  const main = makeBackend(catalog, {
    kind: 'openrouter',
    label: 'main',
    modelId: 'org/default',
  });
  const settings = {
    defaultPreset: preset,
    defaultBackend: main.backend,
    defaultModelId: 'org/default',
  };
  const first = await resolveCreateOptions(harden({}), settings);
  // The operator changes the default model.
  settings.defaultModelId = 'org/other';
  const second = await resolveCreateOptions(harden({}), settings);
  t.is(first.modelId, 'org/default');
  t.is(first.contextLength, 100_000);
  t.is(second.modelId, 'org/other');
  t.is(second.contextLength, 32_000);
  t.true(Object.isFrozen(first));
});

test('without a factory default backend an empty model is the backend own; scripted keeps M1a', async t => {
  const { fetch } = makeFetch();
  const catalog = makeCatalog({ fetch });
  const api = makeBackend(catalog, {
    kind: 'openrouter',
    label: 'api',
    modelId: 'org/default',
  });
  const own = await resolveCreateOptions(harden({ backend: api.backend }), {
    defaultPreset: preset,
  });
  t.is(own.modelId, 'org/default');
  const scripted = makeBackend(catalog, {
    kind: 'scripted',
    label: 'scripted',
  });
  const m1a = await resolveCreateOptions(
    harden({ backend: scripted.backend }),
    { defaultPreset: preset, defaultBackend: api.backend },
  );
  t.is(m1a.modelId, 'scripted');
  t.deepEqual(scripted.asked, []);
  t.is(m1a.contextLength, undefined);
  // No backend and no default: M1a's refusal.
  await t.throwsAsync(
    () => resolveCreateOptions(harden({}), { defaultPreset: preset }),
    { message: texts.noBackend },
  );
  // An API backend without a configured model and no model given.
  const bare = makeBackend(catalog, { kind: 'openrouter', label: 'bare' });
  await t.throwsAsync(
    () =>
      resolveCreateOptions(harden({ backend: bare.backend }), {
        defaultPreset: preset,
        defaultBackend: bare.backend,
      }),
    { message: texts.modelRequired },
  );
});

test('a refusal from the manager (catalogue unavailable) fails the creation with its text', async t => {
  /** @type {typeof globalThis.fetch} */
  const fetch = async () => new Response('{}', { status: 503 });
  const catalog = makeCatalog({ fetch });
  const main = makeBackend(catalog, {
    kind: 'anthropic',
    label: 'claude-api',
    modelId: 'claude-sonnet-4-6',
  });
  await t.throwsAsync(
    () =>
      resolveCreateOptions(harden({}), {
        defaultPreset: preset,
        defaultBackend: main.backend,
      }),
    { message: texts.catalogUnavailable },
  );
});
