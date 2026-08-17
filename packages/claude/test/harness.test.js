// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { make } from '../src/harness.js';
import { assertConfinedArgv } from '../src/argv.js';
import { ALLOWED_ENV_KEYS } from '../src/child-env.js';
import { ok } from '../src/results.js';

const HEX64 = 'a'.repeat(64);
const PINNED = '2.1.232';

/**
 * Build a fully-injected harness with observable seams.
 *
 * @param {object} [overrides]
 */
const makeHarness = (overrides = {}) => {
  const observed = {
    launched: /** @type {any} */ (null),
    cleaned: 0,
    released: 0,
    catalog: overrides.catalog ?? [{ name: 'writeText' }, { name: 'list' }],
  };

  const broker = {
    async toolsList() {
      return observed.catalog;
    },
    async transport() {
      return /** @type {import('../src/mcp-config.js').McpTransport} */ ({
        kind: 'stdio',
        command: '/opt/endo-claude-shim',
      });
    },
  };

  const pool = overrides.pool ?? {
    async acquire(sessionTag) {
      return harden({
        type: 'acquired',
        subscriptionId: 'sub-0',
        issued: { async materialise() {
          return 'key';
        } },
        async release() {
          observed.released += 1;
        },
      });
    },
  };

  let tagSeq = 0;
  const options = {
    pinnedModels: ['claude-opus-4-8', 'claude-sonnet-4-5'],
    getClaudeVersion: overrides.getClaudeVersion ?? (async () => PINNED),
    mintSessionTag: () => `tag-${(tagSeq += 1)}`,
    async prepareSpawnFiles({ sessionTag }) {
      return {
        mcpConfigPath: `/run/spawn/${sessionTag}/mcp.json`,
        settingsPath: `/run/spawn/${sessionTag}/settings.json`,
        apiKeyHelperCommand: '/run/spawn/helper',
        pathValue: '/opt/shim/bin',
        async cleanup() {
          observed.cleaned += 1;
        },
      };
    },
    launch:
      overrides.launch ??
      (async spec => {
        observed.launched = spec;
        return ok('hello from claude', { model: spec.argv[spec.argv.indexOf('--model') + 1] });
      }),
    limits: { wallClockMs: 1000, outputByteCap: 1024, maxTurns: 8 },
  };

  const provider = make({ connectBroker: async () => broker, pool }, undefined, options);
  return { provider, observed };
};

test('happy path: infer builds a confined argv, an allowlisted env, prompt on stdin', async t => {
  const { provider, observed } = makeHarness();
  const infer = await provider.makeGuestInference(HEX64);
  const result = await infer.infer('think about X', { model: 'claude-opus-4-8' });

  t.is(result.type, 'ok');
  if (result.type !== 'ok') return;
  t.is(result.text, 'hello from claude');

  // The argv that reached the spawner is confined.
  t.notThrows(() => assertConfinedArgv(observed.launched.argv));
  t.true(observed.launched.argv.includes('--allowedTools'));
  // deriveAllowList emits names sorted for determinism.
  t.is(
    observed.launched.argv[observed.launched.argv.indexOf('--allowedTools') + 1],
    'mcp__endo__list,mcp__endo__writeText',
  );
  t.is(observed.launched.argv[observed.launched.argv.indexOf('--model') + 1], 'claude-opus-4-8');

  // The env carries only allowlisted keys.
  for (const key of Object.keys(observed.launched.env)) {
    t.true(ALLOWED_ENV_KEYS.includes(key), key);
  }

  // The prompt is delivered to launch as stdin content, never as argv.
  t.is(observed.launched.prompt, 'think about X');
  t.false(observed.launched.argv.includes('think about X'));

  // Pool released and files cleaned exactly once.
  t.is(observed.released, 1);
  t.is(observed.cleaned, 1);
});

test('infer defaults the model to the first pinned model', async t => {
  const { provider, observed } = makeHarness();
  const infer = await provider.makeGuestInference(HEX64);
  await infer.infer('hi');
  t.is(observed.launched.argv[observed.launched.argv.indexOf('--model') + 1], 'claude-opus-4-8');
});

test('a model outside the pinned set fails closed (throws, no spawn)', async t => {
  const { provider, observed } = makeHarness();
  const infer = await provider.makeGuestInference(HEX64);
  await t.throwsAsync(() => infer.infer('hi', { model: 'gpt-4' }), {
    message: /not in the pinned model set/,
  });
  t.is(observed.launched, null);
});

test('pool exhaustion returns a tagged record and never launches', async t => {
  const { provider, observed } = makeHarness({
    pool: { async acquire() {
      return harden({ type: 'pool-exhausted', retryAfterMs: 250 });
    } },
  });
  const infer = await provider.makeGuestInference(HEX64);
  const r = await infer.infer('hi');
  t.deepEqual({ ...r }, { type: 'pool-exhausted', retryAfterMs: 250 });
  t.is(observed.launched, null);
});

test('a cancel already fired before spawn settles to cancelled/before-spawn and releases', async t => {
  const { provider, observed } = makeHarness();
  const infer = await provider.makeGuestInference(HEX64);
  const r = await infer.infer('hi', { cancelled: Promise.resolve() });
  t.deepEqual({ ...r }, { type: 'cancelled', at: 'before-spawn' });
  t.is(observed.launched, null);
  t.is(observed.released, 1); // slot freed even though nothing spawned
});

test('a version mismatch fails closed (throws) but still releases the slot', async t => {
  const { provider, observed } = makeHarness({
    getClaudeVersion: async () => '2.1.999',
  });
  const infer = await provider.makeGuestInference(HEX64);
  await t.throwsAsync(() => infer.infer('hi'), { message: /!= pinned/ });
  t.is(observed.launched, null);
  t.is(observed.released, 1);
});

test('an empty post-prune catalog is a grant-time hard error (throws)', async t => {
  const { provider } = makeHarness({ catalog: [{ name: 'evaluate' }, { name: '__proto__' }] });
  await t.throwsAsync(() => provider.makeGuestInference(HEX64), {
    message: /empty post-prune tool catalog/,
  });
});

test('an invalid formula id throws at grant time', async t => {
  const { provider } = makeHarness();
  await t.throwsAsync(() => provider.makeGuestInference('not-hex'), {
    message: /64 lowercase hex/,
  });
});

test('the per-guest infer exo carries no designator (closes over one facet)', async t => {
  const { provider } = makeHarness();
  const infer = await provider.makeGuestInference(HEX64);
  // The infer method takes only (prompt, opts) — a formula id is not an argument.
  t.is(typeof infer.infer, 'function');
  t.is(infer.infer.length <= 2, true);
});
