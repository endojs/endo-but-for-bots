// @ts-nocheck
// Does `shim.js` ITSELF leave the globals configurable in a realm whose global
// is not an ordinary object?
//
// `shim-global-descriptors.test.js` pins `installEmulatedGlobalConstructors`,
// which is not the same question: a change that inlined the install back into
// `shim.js` with a partial descriptor -- the configuration that shipped the
// bug -- passes that file and the rest of the suite. This one evaluates the
// real `shim.js` against a `vm` global, so it fails.
//
// No bundler is involved, and none is needed: `src/lib.js` has no imports, so
// the graph is two modules and `vm.SourceTextModule` links them directly.
// `--experimental-vm-modules` is spawned in a child rather than added to this
// package's ava `nodeArguments`, so one test does not put an experimental flag
// under every other test in the package.
import test from 'ava';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('shim.js leaves a vm realm able to lockdown()', t => {
  // A partial descriptor does not merely produce bad descriptors: the install
  // that follows it can throw on the globals it just sealed. Report the
  // child's own stderr rather than an opaque `execFileSync` failure, so the
  // reason is in the test output.
  const run = () =>
    execFileSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        fileURLToPath(new URL('./_shim-vm-realm-probe.mjs', import.meta.url)),
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          IAB_LIB: fileURLToPath(new URL('../src/lib.js', import.meta.url)),
          IAB_SHIM: fileURLToPath(new URL('../src/shim.js', import.meta.url)),
        },
      },
    );
  let out;
  try {
    out = run();
  } catch (error) {
    t.fail(
      `evaluating src/shim.js in a vm realm failed:\n${
        /** @type {any} */ (error).stderr || /** @type {any} */ (error).message
      }`,
    );
    return;
  }
  const descriptors = JSON.parse(out);
  const names = Object.keys(descriptors);

  // A dropped flavor would otherwise pass vacuously.
  t.is(
    names.length,
    12,
    'expected every flavor in concreteTypedArrayConstructors plus DataView; ' +
      'if the upstream list changed, update this count deliberately',
  );

  for (const name of names) {
    const desc = descriptors[name];
    t.truthy(desc, `${name} should be an own property of the vm global`);
    // `configurable` is the one SES needs: `lockdown()` repairs the global
    // object by redefining the intrinsics it permits, and cannot redefine a
    // non-configurable one.
    t.true(desc.configurable, `${name} must stay configurable for lockdown()`);
    t.true(desc.writable, `${name} must stay writable`);
    t.false(desc.enumerable, `${name} must not be enumerable`);
    // Without this the three above would also hold of the realm's OWN
    // constructors, so a missing install would pass.
    t.true(desc.replaced, `${name} should be the emulated constructor`);
  }
});
