const r = {};
function t(k, f) { try { r[k] = f(); } catch (e) { r[k] = 'threw ' + e.name + ': ' + e.message; } }
t('protoNull', () => Object.getPrototypeOf(globalThis) === null);
t('inToString', () => 'toString' in globalThis);
t('typeofToString', () => typeof toString);
t('typeofValueOf', () => typeof valueOf);
t('globalToString', () => typeof globalThis.toString);
t('strTemplate', () => String(globalThis));
t('thisHasOwn', () => (function(){ return this; })().hasOwnProperty('Array'));
t('cmpProtoNull', () => typeof Compartment === 'function' ? Object.getPrototypeOf(new Compartment().globalThis) === null : 'none');
t('cmpTypeofToString', () => typeof Compartment === 'function' ? new Compartment().evaluate('typeof toString') : 'none');
t('cmpInToString', () => typeof Compartment === 'function' ? new Compartment().evaluate("'toString' in globalThis") : 'none');
// Proxy on Object.prototype is the HasBinding observable: does name resolution trap?
const proto = { __proto__: Object.prototype, injected: 42 };
t('setProto', () => Reflect.setPrototypeOf(globalThis, proto));
t('viaProperty', () => globalThis.injected);
t('typeofInjected', () => typeof injected);
t('readInjected', () => injected);
// Assignment to an inherited-only name: sloppy creates own property on global per spec
t('sloppyAssign', () => { (0, eval)('injected2 = 7'); return Object.prototype.hasOwnProperty.call(globalThis, 'injected2'); });
throw new Error(JSON.stringify(r));
