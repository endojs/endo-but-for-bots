// @ts-check
// Evaluates the REAL `src/shim.js` inside a `vm` realm and prints the
// descriptors it leaves on that realm's global, as JSON.
//
// Run by `shim-vm-realm.test.js` in a child process, because
// `vm.SourceTextModule` needs `--experimental-vm-modules` and one test should
// not put an experimental flag under every other test in the package. Not
// named `*.test.*`, so ava does not collect it.
//
// No bundler: `src/lib.js` has no imports, so the graph is two modules and
// `link` resolves the single specifier by hand.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const context = vm.createContext({});

const lib = new vm.SourceTextModule(read(process.env.IAB_LIB), {
  context,
  identifier: 'lib.js',
});
const shim = new vm.SourceTextModule(read(process.env.IAB_SHIM), {
  context,
  identifier: 'shim.js',
});

await shim.link(specifier => {
  if (specifier !== './lib.js') {
    throw Error(
      `the module graph grew an import this probe cannot link: ${specifier}`,
    );
  }
  return lib;
});
await shim.evaluate();

// The flavor list comes from the lib, so a flavor added or dropped upstream is
// covered without editing this probe.
// `namespace` is typed `Object` by `node:vm`, so the shape of a linked
// module's exports has to be asserted here.
const { concreteTypedArrayConstructors } =
  /** @type {{ concreteTypedArrayConstructors: Array<{ name: string }> }} */ (
    lib.namespace
  );
const names = [
  ...concreteTypedArrayConstructors.map(({ name }) => name),
  'DataView',
];
const vmGlobal = vm.runInContext('globalThis', context);
const descriptors = {};
for (const name of names) {
  const desc = Object.getOwnPropertyDescriptor(vmGlobal, name);
  descriptors[name] = desc && {
    writable: desc.writable,
    enumerable: desc.enumerable,
    configurable: desc.configurable,
    // Proves the shim actually REPLACED the constructor rather than leaving
    // the realm's own, whose descriptor already satisfies the three above.
    replaced:
      desc.value !==
      vm.runInContext(`globalThis.${name}`, vm.createContext({})),
  };
}
console.log(JSON.stringify(descriptors));
