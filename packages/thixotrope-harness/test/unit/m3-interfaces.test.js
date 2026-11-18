// @ts-check
// The M3 interface contract (W3.0; designs/m3-interfaces.md 3, 14, 17;
// tested by W3.3): every M3 shape and method guard accepts a sample and
// refuses, at every place in the sample, an oversize string, an oversize
// array and an extra record key; `withGatewayAdmin` makes one interface
// named `AgentHostAdmin` whose methods are exactly M2's plus `gateway`
// (pinning `payload.methodGuards`, CC-072) and leaves `interfaces.js`
// untouched; `vocabularyShapes()` answers every shape and interface; the
// fixed texts are exact.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  interfaces,
  m2Interfaces,
  m2MethodNames,
} from '../../guest/lib/interfaces.js';
import {
  GATEWAY_KEY,
  m3AgentHostAdminMethodNames,
  m3Interfaces,
  m3Limits,
  m3MethodNames,
  m3Shapes,
  m3TextOf,
  m3Texts,
  vocabularyShapes,
  withGatewayAdmin,
} from '../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const HUGE_STRING = 'x'.repeat(2_097_153);
const HUGE_ARRAY = 20_001;

/** @param {string} label */
const far = label => Far(label, {});

const operator = far('Operator');
const secret = 'a'.repeat(64);

const config = {
  operator,
  port: 8930,
  publicOrigin: 'https://example.test',
  trustedProxies: ['127.0.0.1', '::1'],
  signInFailuresPerMinute: 20,
};
const status = {
  state: 'serving',
  port: 8930,
  origin: 'http://127.0.0.1:8930',
  connections: 2,
  since: 1_763_251_200_000,
  error: 'none',
};
const extra = { label: 'fixture', service: far('FixtureService') };
const powers = {
  operator,
  live: far('Live'),
  content: far('Content'),
  composer: far('Composer'),
  history: far('History'),
  extras: [extra],
};

/** One sample per M3 shape, with every optional field present. */
const shapeSamples = {
  GatewayState: 'serving',
  GatewayConfig: config,
  GatewaySpec: { sink: far('GatewaySink'), config },
  GatewayStatus: status,
  GatewayExtra: extra,
  GatewayPowers: powers,
};

/** Per interface, per method: sample arguments and a sample answer. */
const methodSamples = {
  GatewayAdmin: {
    serve: { args: [config], returns: status },
    status: { args: [], returns: status },
    rotateSignIn: { args: [], returns: undefined },
    stop: { args: [], returns: undefined },
  },
  GatewaySink: {
    attach: { args: [far('GatewayOps'), status], returns: 1 },
  },
  GatewayOps: {
    status: { args: [], returns: status },
    rotateSignIn: { args: [], returns: undefined },
  },
  GatewayBootstrap: {
    fetch: { args: [secret], returns: powers },
  },
};

// ---------------------------------------------------------------- variants

/**
 * Paths to every string, array and record in a sample (not into
 * remotables).
 * @param {unknown} value
 * @param {(string|number)[]} [at]
 * @returns {{ path: (string|number)[], kind: 'string' | 'array' | 'record' }[]}
 */
const pathsOf = (value, at = []) => {
  if (typeof value === 'string') return [{ path: at, kind: 'string' }];
  if (Array.isArray(value)) {
    return [
      { path: at, kind: 'array' },
      ...value.flatMap((item, i) => pathsOf(item, [...at, i])),
    ];
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return [
      { path: at, kind: 'record' },
      ...Object.entries(value).flatMap(([k, v]) => pathsOf(v, [...at, k])),
    ];
  }
  return [];
};

/**
 * @param {any} value
 * @param {(string|number)[]} path
 * @param {(node: any) => any} fn
 * @returns {any}
 */
const replaceAt = (value, path, fn) => {
  if (path.length === 0) return fn(value);
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      i === head ? replaceAt(item, rest, fn) : item,
    );
  }
  return { ...value, [head]: replaceAt(value[head], rest, fn) };
};

/** @type {Record<string, (node: any) => any>} */
const breakers = {
  string: () => HUGE_STRING,
  array: node => Array.from({ length: HUGE_ARRAY }, () => node[0] ?? 'x'),
  record: node => ({ ...node, zzUnexpectedKey: 1 }),
};

/** @param {unknown} sample */
const badVariants = sample =>
  pathsOf(sample).map(({ path, kind }) => ({
    label: `${kind} at ${path.join('.') || '(root)'}`,
    value: harden(replaceAt(sample, path, breakers[kind])),
  }));

/**
 * A stub exo whose methods answer the samples.
 * @param {keyof typeof methodSamples} name
 */
const stubExo = name => {
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  for (const [method, { returns }] of Object.entries(methodSamples[name])) {
    methods[method] = () => harden(returns);
  }
  return makeExo(name, /** @type {any} */ (m3Interfaces)[name], methods);
};

// ---------------------------------------------------------------- tests

test('the M3 tables: one sample per shape, method names in declaration order', t => {
  t.is(GATEWAY_KEY, 'gateway');
  t.deepEqual(Object.keys(m3Shapes).sort(), Object.keys(shapeSamples).sort());
  t.deepEqual(
    Object.keys(m3Interfaces).sort(),
    Object.keys(methodSamples).sort(),
  );
  for (const [name, names] of Object.entries(m3MethodNames)) {
    t.deepEqual(
      [...names],
      Object.keys(/** @type {any} */ (methodSamples)[name]),
      name,
    );
    const guard = /** @type {any} */ (m3Interfaces)[name];
    t.is(guard.payload.interfaceName, name);
    t.deepEqual(
      Object.keys(guard.payload.methodGuards).sort(),
      [...names].sort(),
    );
  }
});

test('every M3 shape matches its sample and refuses every oversize string, array and extra key', t => {
  let refused = 0;
  for (const [name, sample] of Object.entries(shapeSamples)) {
    const shape = /** @type {any} */ (m3Shapes)[name];
    t.true(matches(harden(sample), shape), name);
    for (const { label, value } of badVariants(harden(sample))) {
      t.false(matches(value, shape), `${name}: ${label}`);
      refused += 1;
    }
  }
  t.true(refused >= 22, `${refused} variants refused`);
});

test('M3 shapes: required fields, states and the stated bounds', t => {
  const { GatewayConfig, GatewayStatus, GatewayState, GatewayPowers } =
    m3Shapes;
  t.true(matches(harden({ operator, port: 0 }), GatewayConfig), 'port 0');
  t.false(matches(harden({ port: 1 }), GatewayConfig), 'operator required');
  t.false(matches(harden({ operator, port: 65_536 }), GatewayConfig));
  t.false(matches(harden({ operator, port: -1 }), GatewayConfig));
  t.false(matches(harden({ operator, port: '80' }), GatewayConfig));
  t.false(
    matches(
      harden({ operator, port: 1, signInFailuresPerMinute: 0 }),
      GatewayConfig,
    ),
  );
  t.true(
    matches(
      harden({
        operator,
        port: 1,
        trustedProxies: Array.from(
          { length: m3Limits.trustedProxies },
          () => '127.10.0.1',
        ),
        publicOrigin: 'h'.repeat(m3Limits.originUnits),
      }),
      GatewayConfig,
    ),
    'at the bounds',
  );
  t.false(
    matches(
      harden({
        operator,
        port: 1,
        trustedProxies: Array.from(
          { length: m3Limits.trustedProxies + 1 },
          () => '127.10.0.1',
        ),
      }),
      GatewayConfig,
    ),
  );
  t.false(
    matches(
      harden({
        operator,
        port: 1,
        publicOrigin: 'h'.repeat(m3Limits.originUnits + 1),
      }),
      GatewayConfig,
    ),
  );
  for (const state of ['starting', 'serving', 'failed', 'stopped']) {
    t.true(matches(state, GatewayState), state);
    t.true(matches(harden({ state }), GatewayStatus), `${state} alone`);
  }
  t.false(matches('listening', GatewayState));
  t.false(
    matches(
      harden({ state: 'failed', error: 'e'.repeat(limits.reasonUnits + 1) }),
      GatewayStatus,
    ),
  );
  t.false(
    matches(
      harden({
        ...powers,
        extras: Array.from({ length: m3Limits.extras + 1 }, () => extra),
      }),
      GatewayPowers,
    ),
  );
});

test('every M3 method accepts its sample through a stub exo', async t => {
  const calls = [];
  for (const name of /** @type {(keyof typeof methodSamples)[]} */ (
    Object.keys(methodSamples)
  )) {
    const exo = stubExo(name);
    for (const [method, { args }] of Object.entries(methodSamples[name])) {
      calls.push(
        t.notThrowsAsync(
          async () => exo[method](...harden(args)),
          `${name}.${method}`,
        ),
      );
    }
  }
  await Promise.all(calls);
});

test('every M3 method refuses an oversize string, an oversize array and an extra key in its arguments', async t => {
  const calls = [];
  for (const name of /** @type {(keyof typeof methodSamples)[]} */ (
    Object.keys(methodSamples)
  )) {
    const exo = stubExo(name);
    for (const [method, { args }] of Object.entries(methodSamples[name])) {
      const variants = badVariants(harden(args)).filter(
        ({ label }) => label !== 'array at (root)',
      );
      for (const { label, value } of variants) {
        calls.push(
          t.throwsAsync(
            async () => exo[method](...value),
            undefined,
            `${name}.${method}: ${label}`,
          ),
        );
      }
    }
  }
  await Promise.all(calls);
  t.true(calls.length >= 10, `${calls.length} variants refused`);
});

test('GatewayBootstrap.fetch admits 256 units and refuses 257 before any comparison', async t => {
  const exo = stubExo('GatewayBootstrap');
  await t.notThrowsAsync(async () =>
    exo.fetch('z'.repeat(m3Limits.signInUnits)),
  );
  await t.throwsAsync(async () =>
    exo.fetch('z'.repeat(m3Limits.signInUnits + 1)),
  );
  await t.throwsAsync(async () => exo.fetch(42));
});

test('return guards: a status out of shape never leaves the admin', async t => {
  const guard = /** @type {any} */ (m3Interfaces.GatewayAdmin);
  /** @type {any} */
  const exo = makeExo('GatewayAdmin', guard, {
    serve: () => harden({ state: 'serving', secret }),
    status: () => harden({ state: 'up' }),
    rotateSignIn: () => secret,
    stop: () => undefined,
  });
  await t.throwsAsync(async () => exo.serve(harden(config)));
  await t.throwsAsync(async () => exo.status());
  await t.throwsAsync(async () => exo.rotateSignIn(), undefined, 'no value');
});

test('withGatewayAdmin: one AgentHostAdmin interface with M2 methods then gateway', t => {
  const base = m2Interfaces.AgentHostAdmin;
  const guard = /** @type {any} */ (withGatewayAdmin(base));
  t.is(guard.payload.interfaceName, 'AgentHostAdmin');
  t.deepEqual(Object.keys(guard.payload.methodGuards), [
    ...m2MethodNames.AgentHostAdmin,
    ...m3AgentHostAdminMethodNames,
  ]);
  for (const name of m2MethodNames.AgentHostAdmin) {
    t.is(
      guard.payload.methodGuards[name],
      /** @type {any} */ (base).payload.methodGuards[name],
      `${name} keeps its M2 guard`,
    );
  }
  // interfaces.js is not edited: neither table gains `gateway`.
  t.false('gateway' in /** @type {any} */ (base).payload.methodGuards);
  t.false(m2MethodNames.AgentHostAdmin.includes('gateway'));
  t.false(
    'gateway' in
      /** @type {any} */ (interfaces.AgentHostAdmin).payload.methodGuards,
  );
  // An exo made with it answers gateway() with a remotable, and must
  // implement it.
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  for (const name of m2MethodNames.AgentHostAdmin)
    methods[name] = () => undefined;
  t.throws(() => makeExo('AgentHostAdmin', guard, methods), {
    message: /gateway/,
  });
  const admin = far('GatewayAdmin');
  const facet = makeExo('AgentHostAdmin', guard, {
    ...methods,
    gateway: () => admin,
  });
  t.is(facet.gateway(), admin);
  t.throws(() => /** @type {any} */ (facet).gateway('extra'));
  // Nesting (a later lane's extension of the same base) keeps both.
  const nested = /** @type {any} */ (withGatewayAdmin(guard));
  t.deepEqual(
    Object.keys(nested.payload.methodGuards),
    Object.keys(guard.payload.methodGuards),
  );
});

test('vocabularyShapes answers every M3 shape and interface', t => {
  const answered = vocabularyShapes();
  t.true(Object.isFrozen(answered));
  t.is(
    answered.length,
    Object.keys(m3Shapes).length + Object.keys(m3Interfaces).length,
  );
  for (const value of [
    ...Object.values(m3Shapes),
    ...Object.values(m3Interfaces),
  ]) {
    t.true(answered.includes(value));
  }
});

test('the fixed M3 texts', t => {
  t.deepEqual(
    { ...m3Texts },
    {
      gatewayNotServing: 'The gateway is not serving',
      gatewayNotAttached: 'The gateway is not attached to an agent host yet',
      signInRefused: 'Sign-in refused',
      signInCeiling: 'Too many failed sign-ins; try again in a minute',
    },
  );
  t.is(m3TextOf.rateLimited(1000), 'Rate limit exceeded, try in 1000ms');
  t.is(m3TextOf.rateLimited(999.2), 'Rate limit exceeded, try in 1000ms');
  t.is(
    m3TextOf.gatewayFailed('listen EADDRINUSE'),
    'The gateway could not serve: listen EADDRINUSE',
  );
});
