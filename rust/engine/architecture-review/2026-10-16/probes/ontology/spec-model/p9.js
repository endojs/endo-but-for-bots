// The global object is an ordinary extensible object; HasBinding/GetBindingValue/SetMutableBinding of the
// Global Environment Record's [[ObjectRecord]] go through HasProperty/Get/Set on it (ECMA-262 9.1.1.2).
const r = {};
function t(name, f) { try { r[name] = f(); } catch (e) { r[name] = 'threw ' + e.name + ': ' + e.message; } }
const proto = { injected: 42 };
Object.setPrototypeOf(proto, Object.getPrototypeOf(globalThis));
t('setProto', () => Reflect.setPrototypeOf(globalThis, proto));
t('viaProperty', () => globalThis.injected);
t('viaIdentifier', () => typeof injected);
t('readIdentifier', () => injected);
t('strictAssign', () => { 'use strict'; injected = 7; return [globalThis.injected, proto.injected, Object.hasOwn(globalThis, 'injected')]; });
throw new Error(JSON.stringify(r));
