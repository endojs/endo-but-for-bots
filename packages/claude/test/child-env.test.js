// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  buildChildEnv,
  assertChildEnvAllowed,
  ALLOWED_ENV_KEYS,
  FORBIDDEN_ENV_KEYS,
} from '../src/child-env.js';

test('buildChildEnv constructs from an allowlist, not the parent env', t => {
  const env = buildChildEnv({ pathValue: '/opt/shim/bin', sessionTag: 'tag-1' });
  t.deepEqual(Object.keys(env).sort(), [...ALLOWED_ENV_KEYS].sort());
  t.is(env.PATH, '/opt/shim/bin');
  t.is(env.ENDO_CLAUDE_SESSION_TAG, 'tag-1');
  t.is(Object.getPrototypeOf(env), null);
  t.true(Object.isFrozen(env));
});

test('assertChildEnvAllowed rejects a forbidden variable (pool bypass / off-target)', t => {
  for (const bad of FORBIDDEN_ENV_KEYS) {
    t.throws(() => assertChildEnvAllowed({ [bad]: 'x' }), undefined, bad);
  }
});

test('assertChildEnvAllowed rejects any non-allowlisted key', t => {
  t.throws(() => assertChildEnvAllowed({ SOMETHING_ELSE: 'x' }), {
    message: /non-allowlisted/,
  });
});

// --- property: the env allowlist, peer of the argv invariant -------------

test('property: no dangerous parent variable ever reaches the constructed child env', t => {
  // An arbitrary parent env seeded with the exact bypass/redirect variables the
  // design names, so the cases are generated, not hoped for.
  const seeded = fc.record({
    ANTHROPIC_API_KEY: fc.string(),
    ANTHROPIC_BASE_URL: fc.webUrl(),
    ENDO_SOCK: fc.string(),
    XDG_RUNTIME_DIR: fc.string(),
    HTTPS_PROXY: fc.webUrl(),
    EXTRA: fc.string(),
  });
  fc.assert(
    fc.property(
      seeded,
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      (_parent, pathValue, sessionTag) => {
        // buildChildEnv never reads the parent; the constructed env's keys are
        // always exactly the allowlist.
        const env = buildChildEnv({ pathValue, sessionTag });
        for (const key of Object.keys(env)) {
          t.true(ALLOWED_ENV_KEYS.includes(key));
          t.false(FORBIDDEN_ENV_KEYS.includes(key));
        }
        t.notThrows(() => assertChildEnvAllowed(env));
      },
    ),
    { numRuns: 200 },
  );
});
