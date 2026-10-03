import '../index.js';
import test from 'ava';

lockdown();

test('no SturdyRef appears when the shim did not run', t => {
  t.false(Object.hasOwn(globalThis, 'SturdyRef'));
  const c = new Compartment();
  t.false(Object.hasOwn(c.globalThis, 'SturdyRef'));
  t.is(c.evaluate('typeof SturdyRef'), 'undefined');
});
