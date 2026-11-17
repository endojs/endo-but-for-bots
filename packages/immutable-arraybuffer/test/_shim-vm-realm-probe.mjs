// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** @param {boolean} customize */
const checkInstallation = async customize => {
  const context = vm.createContext({});
  const vmGlobal = vm.runInContext('globalThis', context);
  const needsShim = !('sliceToImmutable' in vmGlobal.ArrayBuffer.prototype);

  if (customize) {
    // Cover customized globals alongside the untouched built-ins in the same VM.
    Object.defineProperty(context, 'Int8Array', {
      value: vmGlobal.Int8Array,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(context, 'DataView', {
      value: vmGlobal.DataView,
      writable: true,
      configurable: false,
    });
  }
  const before = Object.getOwnPropertyDescriptors(vmGlobal);

  const load = name => {
    const url = new URL(`../src/${name}.js`, import.meta.url);
    return new vm.SourceTextModule(readFileSync(url, 'utf8'), {
      context,
      identifier: url.href,
    });
  };
  const lib = load('lib');
  const shim = load('shim');
  await shim.link(specifier => {
    assert.equal(specifier, './lib.js');
    return lib;
  });
  await shim.evaluate();

  for (const name of [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'DataView',
  ]) {
    const after = Object.getOwnPropertyDescriptor(vmGlobal, name);
    assert.ok(after, name);
    const { value: original, ...originalFlags } = before[name];
    const { value: replacement, ...flags } = after;
    assert.deepEqual(flags, originalFlags, `${name} attributes`);
    assert.equal(replacement !== original, needsShim, `${name} replacement`);
  }
};

await checkInstallation(false);
await checkInstallation(true);
