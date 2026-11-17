// Global Object Environment Record: HasBinding(N) is HasProperty(globalObject, N) (ECMA-262 9.1.1.2.1),
// GetBindingValue is Get(globalObject, N). Compare name resolution with the object model.
const r = {};
function t(name, f) { try { r[name] = f(); } catch (e) { r[name] = 'threw ' + e.name + ': ' + e.message; } }
t('protoIsNull', () => Object.getPrototypeOf(globalThis) === null);
t('inGlobal', () => 'toString' in globalThis);
t('reflectHas', () => Reflect.has(globalThis, 'valueOf'));
t('typeofToString', () => typeof toString);
t('toStringIsObjectProto', () => toString === Object.prototype.toString);
t('callHasOwn', () => hasOwnProperty('Array'));
t('withGlobal', () => { let x; with (globalThis) { x = typeof valueOf; } return x; });
t('getViaGlobal', () => typeof globalThis.toString);
throw new Error(JSON.stringify(r));
