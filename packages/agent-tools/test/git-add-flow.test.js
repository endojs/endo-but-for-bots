// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { E, Far } from '@endo/far';

import { makeGitTool } from '../src/git-tool.js';
import { prepareGuestPowers, bindCap } from './helpers/daemon-petstore.js';

/** @import { ERef } from '@endo/far' */
/** @import { GitToolCapability, ToolRecord } from '../src/types.js' */

/**
 * Proof that `makeGitTool` wires the capref[] methods (`add`/`restore`) through
 * the guest petstore: an LLM passes an array of **petname strings**, and the
 * invoke boundary resolves them to live caps via `E(powers).lookup` before
 * dispatching to the `Git` capability. The petnames are bound in a REAL
 * daemon-backed guest petstore (the same `prepareGuestPowers` / `bindCap`
 * harness the divergence round-trips use), never a hand-rolled `Map`, so this
 * exercises the live resolution path. A stub `Git` records the exact arguments
 * it receives, so the test asserts the live caps — not the petname strings —
 * reach the capability, with identity preserved.
 *
 * (The end-to-end staging against a real native-git-backed `Git` — `status`
 * returns an entry, that entry is staged through `add` — is exercised where the
 * real-git harness lives; here the concern is the petname → live-cap resolution
 * at the tool boundary, proven against a real petstore.)
 *
 * These fork a full daemon per test and share filesystem state, so they are
 * `test.serial` with the helper's `t.teardown`.
 */

/**
 * A stub Git that records each call's `[name, ...args]`. `add`/`restore` return
 * undefined (matching the interface).
 *
 * @param {unknown[][]} calls
 */
const makeStubGit = calls => {
  const record =
    name =>
    (...a) => {
      calls.push([name, ...a]);
      return undefined;
    };
  // The tests exercise only `add`/`restore`, so the stub records just those two;
  // cast through `unknown` to the dispatch shape `makeGitTool` reaches by `E`.
  return /** @type {ERef<GitToolCapability>} */ (
    /** @type {unknown} */ (
      Far('StubGit', {
        add: record('add'),
        restore: record('restore'),
      })
    )
  );
};

/**
 * @param {ToolRecord[]} tools
 */
const byNameOf = tools => name => {
  const found = tools.find(tool => tool.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

test('the slice includes add/restore (capref[] over the guest petstore)', t => {
  const names = new Set(
    makeGitTool(
      // This test only inspects the built slice; it never invokes the cap.
      /** @type {ERef<GitToolCapability>} */ (
        /** @type {unknown} */ (Far('InertGit', {}))
      ),
    ).map(tool => tool.name),
  );
  t.true(names.has('add'));
  t.true(names.has('restore'));
});

test.serial(
  'add resolves a petname array to live caps before dispatching',
  async t => {
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    const calls = [];
    const byName = byNameOf(makeGitTool(makeStubGit(calls), powers));

    // Two entry caps the host bound under petnames the agent would have learned
    // from a prior `status` call.
    const entryA = await bindCap(t, powers, 'entryA');
    const entryB = await bindCap(t, powers, 'entryB');

    await byName('add').invoke({ arg0: ['entryA', 'entryB'] });

    // The capability saw the LIVE caps, not the petname strings.
    t.is(calls.length, 1);
    const [name, arg0] = calls[0];
    t.is(name, 'add');
    const resolved = /** @type {unknown[]} */ (arg0);
    t.is(resolved.length, 2);
    // Identity preserved: each resolved cap answers an eventual-send the way the
    // bound cap does (proving it is the live cap, not the petname string).
    t.is(await E(/** @type {any} */ (resolved[0])).incr(), 1);
    t.is(await E(entryA).incr(), 2);
    t.is(await E(/** @type {any} */ (resolved[1])).incr(), 1);
    t.is(await E(entryB).incr(), 2);
  },
);

test.serial(
  'restore resolves its petname array and passes the trailing options through',
  async t => {
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    const calls = [];
    const byName = byNameOf(makeGitTool(makeStubGit(calls), powers));

    const entry = await bindCap(t, powers, 'entry');
    const options = harden({ staged: true });

    await byName('restore').invoke({ arg0: ['entry'], arg1: options });

    t.is(calls.length, 1);
    const [name, arg0, arg1] = calls[0];
    t.is(name, 'restore');
    // arg0 resolved to the live cap; arg1 (a plain value) passed through.
    const resolved = /** @type {unknown[]} */ (arg0);
    t.is(await E(/** @type {any} */ (resolved[0])).incr(), 1);
    t.is(await E(entry).incr(), 2);
    t.is(arg1, options);
  },
);

test.serial(
  'add rejects an unbound/forged petname before touching the capability',
  async t => {
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    const calls = [];
    const byName = byNameOf(makeGitTool(makeStubGit(calls), powers));

    // `neverBound` was never bound in the guest petstore: `lookup` throws, so
    // the call fails closed before the stub Git is ever reached.
    await t.throwsAsync(() => byName('add').invoke({ arg0: ['neverBound'] }), {
      message: /[Uu]nknown pet name/,
    });
    t.is(calls.length, 0);
  },
);

test.serial('add requires powers when invoked', async t => {
  // Built without `powers`: building is fine, but invoking a capref method
  // surfaces a clear error rather than dereferencing undefined.
  const byName = byNameOf(makeGitTool(makeStubGit([])));
  await null;
  await t.throwsAsync(() => byName('add').invoke({ arg0: ['anything'] }), {
    message: /no powers were provided/,
  });
});
