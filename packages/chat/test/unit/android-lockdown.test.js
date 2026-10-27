// @ts-check
import test from 'ava';
import { spawnSync } from 'node:child_process';

test('Android legacy Web IDL constructors retain brands without breaking lockdown', t => {
  t.timeout(15_000);
  const setup = new URL('../../pre-lockdown.js', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { strict as assert } from 'node:assert';
    const originals = new Map();
    for (const name of ['TextEncoder', 'TextDecoder', 'URLSearchParams', 'URL']) {
      const Native = globalThis[name];
      // Simulate WebView's non-configurable legacy function properties.
      const Legacy = Function('Native', 'return function Legacy(...args) { return Reflect.construct(Native, args, new.target); }')(Native);
      for (const key of Reflect.ownKeys(Native)) {
        if (['arguments', 'caller', 'prototype', 'name', 'length'].includes(String(key))) continue;
        Object.defineProperty(Legacy, key, Object.getOwnPropertyDescriptor(Native, key));
      }
      Legacy.prototype = Native.prototype;
      Object.defineProperty(Native.prototype, 'constructor', { value: Legacy, configurable: true, writable: true });
      globalThis[name] = Legacy;
      originals.set(name, Legacy);
      assert.equal(Object.getOwnPropertyDescriptor(Legacy, 'arguments').configurable, false);
    }
    await import(${JSON.stringify(setup)});
    for (const [name, Legacy] of originals) {
      const Fixed = globalThis[name];
      assert.notEqual(Fixed, Legacy);
      assert.equal(Object.getOwnPropertyDescriptor(Fixed, 'arguments'), undefined);
      assert.equal(Fixed.prototype.constructor, Fixed);
    }
    await import('@endo/init');
    const encoder = new TextEncoder();
    assert.deepEqual([...encoder.encode('🌊')], [240, 159, 140, 138]);
    assert.equal(encoder.encoding, 'utf-8');
    assert.equal(new TextDecoder().decode(encoder.encode('hello')), 'hello');
    assert.throws(() => TextEncoder(), TypeError);
    assert.equal(new URLSearchParams('a=hello+world').get('a'), 'hello world');
    assert.equal(new URL('/a', 'https://endo.example').href, 'https://endo.example/a');
    assert.equal(URL.canParse('https://endo.example'), true);
    assert.equal(typeof URL.createObjectURL, 'function');
  `,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  t.is(result.status, 0, result.stderr);
});
