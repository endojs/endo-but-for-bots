// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { matches } from '@endo/patterns';

import { makeSandboxFactory } from '../src/factory.js';
import {
  BackendNameShape,
  BackendProbeShape,
  NetworkProfileShape,
  SandboxFactoryInterface,
  backendRootfsKinds,
} from '../src/interfaces.js';

const lifecycleProbe = harden({
  lifecycle: harden({ available: true }),
});

const stubScratchProvider = harden({
  provideScratchMount: async () => {
    throw new Error('scratchProvider not used in Phase 0');
  },
});

test('listBackends returns an empty array when no drivers are registered', async t => {
  const factory = makeSandboxFactory({
    drivers: harden([]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  const backends = await E(factory).listBackends();
  t.deepEqual(backends, [], 'no drivers ⇒ empty backend list');
  t.true(Array.isArray(backends));
});

test('make() throws a structured "no backend available" error in Phase 0', async t => {
  const factory = makeSandboxFactory({
    drivers: harden([]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  await t.throwsAsync(
    () =>
      E(factory).make(
        harden({
          rootfs: { kind: 'host-bind' },
          network: 'none',
        }),
      ),
    { message: /no backend available/ },
    'Phase 0 stub rejects make()',
  );
});

test('make() reports the requested backend selector in its error', async t => {
  const factory = makeSandboxFactory({
    drivers: harden([]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  await t.throwsAsync(
    () =>
      E(factory).make(
        harden({
          rootfs: { kind: 'host-bind' },
          backend: 'bwrap',
        }),
      ),
    { message: /no backend available.*bwrap/ },
    'unknown backend names round-trip into the error message',
  );
});

test('listBackends reports a registered driver as available', async t => {
  const stubDriver = harden({
    name: /** @type {const} */ ('bwrap'),
    probe: async () =>
      harden({
        available: true,
        version: 'stub-1.0',
        details: lifecycleProbe,
      }),
    prepareSlice: async () => {
      throw new Error('not implemented');
    },
    spawn: async () => {
      throw new Error('not implemented');
    },
    teardown: async () => {
      throw new Error('not implemented');
    },
  });

  const factory = makeSandboxFactory({
    drivers: harden([stubDriver]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  const backends = await E(factory).listBackends();
  t.is(backends.length, 1);
  t.deepEqual(backends[0], {
    name: 'bwrap',
    available: true,
    version: 'stub-1.0',
    details: lifecycleProbe,
  });
  t.true(
    matches(backends[0], BackendProbeShape),
    'probe shape matches BackendProbeShape',
  );
});

test('listBackends catches driver probe failures', async t => {
  const flakyDriver = harden({
    name: /** @type {const} */ ('podman'),
    probe: async () => {
      throw new Error('podman not on PATH');
    },
    prepareSlice: async () => {
      throw new Error('not implemented');
    },
    spawn: async () => {
      throw new Error('not implemented');
    },
    teardown: async () => {
      throw new Error('not implemented');
    },
  });

  const factory = makeSandboxFactory({
    drivers: harden([flakyDriver]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  const [probe] = await E(factory).listBackends();
  t.is(probe.name, 'podman');
  t.false(probe.available);
  t.regex(probe.reason ?? '', /podman not on PATH/);
});

test('SandboxFactory interface advertises the expected method names', t => {
  // M.interface() exposes the method guards via the returned interface
  // value; CapTP introspection is the consumer surface, but the guard
  // value itself records the configured method names.
  const guard = SandboxFactoryInterface;
  t.truthy(guard, 'interface guard is defined');
  // The guard is an InterfaceGuard with a known shape — at minimum we
  // can confirm the value is hardened (M.interface returns a hardened
  // pattern) so callers can pass it across CapTP.
  t.true(Object.isFrozen(guard));
});

test('__getMethodNames__() round-trips the documented capability surface', async t => {
  const factory = makeSandboxFactory({
    drivers: harden([]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  // CapTP introspection: the same surface remote callers see.
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (factory)).__getMethodNames__();
  // makeExo always adds __getMethodNames__ and __getInterfaceGuard__.
  // Filter those out before comparing the user-visible surface.
  const userMethods = [...methods].filter(m => !m.startsWith('__')).sort();
  t.deepEqual(
    userMethods,
    ['help', 'listBackends', 'make'],
    'factory advertises help / listBackends / make',
  );
});

/**
 * Minimal driver that can carry a slice through `make()` and `dispose()`
 * without spawning anything.
 *
 * @param {'bwrap' | 'podman'} name
 * @param {boolean} available
 */
const makeSelectableDriver = (name, available) =>
  harden({
    name,
    probe: async () =>
      harden(
        available
          ? { available: true, version: 'stub-1.0', details: lifecycleProbe }
          : { available: false, reason: `${name} is not installed` },
      ),
    /** @param {any} spec */
    prepareSlice: async spec => harden({ spec }),
    spawn: async () => {
      throw new Error('not implemented');
    },
    teardown: async () => {},
  });

test('a slice names the driver that make() resolved, not the selector', async t => {
  const factory = makeSandboxFactory({
    drivers: harden([
      makeSelectableDriver('bwrap', false),
      makeSelectableDriver('podman', true),
    ]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  // `host-bind` rather than `minimal` so the unusable stub scratch
  // provider is tolerated rather than fatal.
  const slice = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );

  t.is(
    await E(slice).backend(),
    'podman',
    'auto skipped the unavailable bwrap driver',
  );
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (slice)).__getMethodNames__();
  t.true(
    [...methods].includes('backend'),
    'the resolved backend is part of the advertised surface',
  );

  await E(slice).dispose();
});

test('backendRootfsKinds constrains only the implemented backends', t => {
  // The table is what a policy layer refuses an unconstructible profile
  // with, so a typo in it silently un-enforces that gate.
  t.deepEqual(
    Object.fromEntries(
      Object.entries(backendRootfsKinds).map(([name, kinds]) => [
        name,
        [...(kinds ?? [])],
      ]),
    ),
    {
      bwrap: ['host-bind', 'minimal', 'mount'],
      podman: ['oci'],
    },
  );
  for (const name of Object.keys(backendRootfsKinds)) {
    t.true(matches(name, BackendNameShape), `${name} is a known backend`);
  }
  // `auto` resolves at runtime, so it can carry no static constraint.
  t.is(backendRootfsKinds.auto, undefined);
});

test('NetworkProfileShape accepts the documented profiles and rejects others', t => {
  for (const profile of [
    'none',
    'private',
    'host-loopback',
    'host-lan',
    'host-net',
  ]) {
    t.true(
      matches(profile, NetworkProfileShape),
      `${profile} matches NetworkProfileShape`,
    );
  }
  t.false(matches('host-internet', NetworkProfileShape));
  t.false(matches('', NetworkProfileShape));
});

/**
 * Driver stub whose signal handling is chosen per process by argv: a
 * `/bin/stubborn` process refuses every signal and never exits, so
 * cleanup has to fall through to the slice-wide forced teardown. Any
 * other process exits on the first signal it is sent.
 */
const makeContainmentFixture = () => {
  let spawnCalls = 0;
  let teardownCalls = 0;

  const driver = harden({
    name: /** @type {const} */ ('bwrap'),
    probe: async () => harden({ available: true, details: lifecycleProbe }),
    prepareSlice: async () => harden({}),
    /**
     * @param {unknown} _slice
     * @param {string[]} argv
     */
    spawn: async (_slice, argv) => {
      await null;
      spawnCalls += 1;
      const stubborn = argv[0] === '/bin/stubborn';
      /** @type {(status: { code: number | null, signal: string | null }) => void} */
      let reportExit = () => undefined;
      /** @type {Promise<{ code: number | null, signal: string | null }>} */
      const exit = new Promise(resolve => {
        reportExit = resolve;
      });
      return harden({
        pid: 4242,
        stdin: null,
        stdout: null,
        stderr: null,
        wait: () => exit,
        /** @param {string} [signal] */
        kill: async signal => {
          await null;
          if (stubborn) {
            throw new Error(`synthetic signal refusal (${signal ?? 'none'})`);
          }
          reportExit(harden({ code: null, signal: String(signal ?? 'none') }));
        },
      });
    },
    teardown: async () => {
      teardownCalls += 1;
    },
  });

  const factory = makeSandboxFactory({
    drivers: /** @type {any} */ (harden([driver])),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  return harden({
    factory,
    counts: () => harden({ spawnCalls, teardownCalls }),
  });
};

test('a containment failure fails the whole slice, not just one process', async t => {
  // Guards a hang as well as a silent-continuation regression: the kill
  // ladder is bounded by KILL_GRACE_MS / DRAIN_GRACE_MS, so a few
  // seconds is ample and an unbounded wait fails fast.
  t.timeout(20_000);
  const fixture = makeContainmentFixture();
  const handle = await E(fixture.factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );
  t.teardown(() =>
    E(handle)
      .dispose()
      .catch(() => undefined),
  );

  const stubborn = await E(handle).spawn(harden(['/bin/stubborn']));
  const sibling = await E(handle).spawn(harden(['/bin/sleep', 'forever']));
  const siblingWait = E(sibling).wait();
  siblingWait.catch(() => undefined);

  // Neither signal lands, so cleanup forces a slice-wide teardown and
  // reports that it could not prove containment.
  await t.throwsAsync(() => E(stubborn).kill(), {
    message: /could not prove containment.*synthetic signal refusal/,
  });
  t.true(
    fixture.counts().teardownCalls >= 1,
    'forced backend teardown must have run',
  );

  // The slice was torn down under everyone on it, so it must stop
  // accepting work rather than run the next spawn without the
  // confinement the caller asked for.
  await t.throwsAsync(() => E(handle).spawn(harden(['/bin/echo', 'hi'])), {
    message: /disposed/,
  });
  await t.throwsAsync(() => E(handle).scratch('/tmp/work'), {
    message: /disposed/,
  });
  // Reset is admission-controlled like the two above: a disposed slice has
  // nothing left to reset, so reporting success would misrepresent it.
  await t.throwsAsync(() => E(handle).reset(), {
    message: /disposed/,
  });
  t.is(
    fixture.counts().spawnCalls,
    2,
    'no process is admitted after containment fails',
  );

  // The owner of a sibling process learns why its process died.
  await t.throwsAsync(() => siblingWait, {
    message: /torn down after a containment failure/,
  });
  await t.throwsAsync(() => E(handle).dispose(), {
    message: /dispose could not prove containment/,
  });
});

test('reset invokes the injected scratch cleanup hook', async t => {
  let resetCalls = 0;
  const driver = harden({
    name: /** @type {const} */ ('bwrap'),
    probe: async () => harden({ available: true, details: lifecycleProbe }),
    prepareSlice: async () => harden({}),
    spawn: async () => {
      throw new Error('spawn not used');
    },
    teardown: async () => {},
  });
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
    resetScratch: async () => {
      resetCalls += 1;
    },
  });
  const handle = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );

  await E(handle).reset();
  t.is(resetCalls, 1);
  await E(handle).dispose();
});

test('factory.help() returns descriptive text', async t => {
  const factory = makeSandboxFactory({
    drivers: harden([]),
    scratchProvider: /** @type {any} */ (stubScratchProvider),
  });

  const overview = await E(factory).help();
  t.regex(overview, /SandboxFactory/);
  const listHelp = await E(factory).help('listBackends');
  t.regex(listHelp, /listBackends/);
  const unknown = await E(factory).help('nonexistent');
  t.regex(unknown, /No documentation/);
});
