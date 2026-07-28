// @ts-nocheck -- this fixture intentionally violates several typing
// invariants to probe the runtime's handling of namespace mutation.
/* eslint-disable no-import-assign -- the point of this fixture is to verify
   that mutating the namespace object is rejected, both via direct assignment
   and via Reflect.set. */
import * as foo from './a.cjs';

const result = {
  before: foo.x,
  isFrozen: Object.isFrozen(foo),
  isExtensible: Object.isExtensible(foo),
  descriptor: Object.getOwnPropertyDescriptor(foo, 'x'),
};

try {
  foo.x = 'bar';
  result.assignThrew = false;
  result.afterAssign = foo.x;
} catch (e) {
  result.assignThrew = true;
  result.assignErrorName = e.name;
}

result.reflectSetReturn = Reflect.set(foo, 'x', 'bar');
result.afterReflectSet = foo.x;

export { result };
