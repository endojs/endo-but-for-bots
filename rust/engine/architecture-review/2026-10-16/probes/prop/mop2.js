var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name; } }
function P(target, h) { return new Proxy(target, h); }
// ownKeys invariants
t('ok_dup', function () { return Reflect.ownKeys(P({}, { ownKeys: function () { return ['a', 'a']; } })); });
t('ok_nonstring', function () { return Reflect.ownKeys(P({}, { ownKeys: function () { return [1]; } })); });
t('ok_missing_nonconfig', function () { var t0 = {}; Object.defineProperty(t0, 'x', { value: 1 }); return Reflect.ownKeys(P(t0, { ownKeys: function () { return []; } })); });
t('ok_nonext_extra', function () { var t0 = Object.preventExtensions({ a: 1 }); return Reflect.ownKeys(P(t0, { ownKeys: function () { return ['a', 'b']; } })); });
t('ok_nonext_missing', function () { var t0 = Object.preventExtensions({ a: 1 }); return Reflect.ownKeys(P(t0, { ownKeys: function () { return []; } })); });
t('ok_arraylike_getter', function () { var log = []; var arr = { get length() { log.push('len'); return 2; }, get 0() { log.push(0); return 'a'; }, get 1() { log.push(1); return 'b'; } }; var r = Reflect.ownKeys(P({}, { ownKeys: function () { return arr; } })); return r.join() + '|' + log.join(); });
t('ok_symbol_dup', function () { var s = Symbol(); return Reflect.ownKeys(P({}, { ownKeys: function () { return [s, s]; } })).length; });
t('keys_filters_via_gopd', function () { var log = []; var p = P({ a: 1, b: 2 }, { ownKeys: function () { return ['a', 'b', 'c']; }, getOwnPropertyDescriptor: function (t, k) { log.push(k); return k === 'c' ? undefined : Reflect.getOwnPropertyDescriptor(t, k); } }); return Object.keys(p).join() + '|' + log.join(); });
// getOwnPropertyDescriptor invariants
t('gopd_nonconfig_for_config', function () { return Object.getOwnPropertyDescriptor(P({ a: 1 }, { getOwnPropertyDescriptor: function () { return { value: 1, configurable: false }; } }), 'a'); });
t('gopd_nonconfig_nonwritable_for_writable', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1, writable: true, configurable: false }); return JSON.stringify(Object.getOwnPropertyDescriptor(P(t0, { getOwnPropertyDescriptor: function () { return { value: 1, writable: false, configurable: false }; } }), 'a')); });
t('gopd_undefined_for_nonconfig', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1 }); return Object.getOwnPropertyDescriptor(P(t0, { getOwnPropertyDescriptor: function () { return undefined; } }), 'a'); });
t('gopd_undefined_nonext', function () { var t0 = Object.preventExtensions({ a: 1 }); return Object.getOwnPropertyDescriptor(P(t0, { getOwnPropertyDescriptor: function () { return undefined; } }), 'a'); });
t('gopd_new_on_nonext', function () { var t0 = Object.preventExtensions({}); return Object.getOwnPropertyDescriptor(P(t0, { getOwnPropertyDescriptor: function () { return { value: 1, configurable: true }; } }), 'a'); });
t('gopd_returns_primitive', function () { return Object.getOwnPropertyDescriptor(P({}, { getOwnPropertyDescriptor: function () { return 1; } }), 'a'); });
t('gopd_incompatible', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1, writable: false, configurable: false }); return Object.getOwnPropertyDescriptor(P(t0, { getOwnPropertyDescriptor: function () { return { value: 2, writable: false, configurable: false }; } }), 'a'); });
t('gopd_complete', function () { return JSON.stringify(Object.getOwnPropertyDescriptor(P({ a: 1 }, { getOwnPropertyDescriptor: function () { return { value: 5, configurable: true }; } }), 'a')); });
// defineProperty invariants
t('dp_true_nonext_new', function () { return Reflect.defineProperty(P(Object.preventExtensions({}), { defineProperty: function () { return true; } }), 'a', { value: 1 }); });
t('dp_nonconfig_for_absent', function () { return Reflect.defineProperty(P({}, { defineProperty: function () { return true; } }), 'a', { value: 1, configurable: false }); });
t('dp_nonconfig_for_config', function () { return Reflect.defineProperty(P({ a: 1 }, { defineProperty: function () { return true; } }), 'a', { value: 1, configurable: false }); });
t('dp_nonconfig_nonwritable_for_writable', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1, writable: true, configurable: false }); return Reflect.defineProperty(P(t0, { defineProperty: function () { return true; } }), 'a', { value: 1, writable: false, configurable: false }); });
t('dp_false_strict', function () { 'use strict'; try { Object.defineProperty(P({}, { defineProperty: function () { return false; } }), 'a', { value: 1 }); return 'nothrow'; } catch (e) { return e.name; } });
t('dp_desc_normalized', function () { var seen; Reflect.defineProperty(P({}, { defineProperty: function (t, k, d) { seen = Object.keys(d).join(); return true; } }), 'a', { value: 1, foo: 2 }); return seen; });
// has / get / set / delete invariants
t('has_false_nonconfig', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1 }); return 'a' in P(t0, { has: function () { return false; } }); });
t('has_false_nonext', function () { return 'a' in P(Object.preventExtensions({ a: 1 }), { has: function () { return false; } }); });
t('get_mismatch', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1 }); return P(t0, { get: function () { return 2; } }).a; });
t('get_accessor_noget', function () { var t0 = {}; Object.defineProperty(t0, 'a', { set: function () {} }); return P(t0, { get: function () { return 2; } }).a; });
t('set_true_nonwritable', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1 }); return Reflect.set(P(t0, { set: function () { return true; } }), 'a', 2); });
t('set_true_nosetter', function () { var t0 = {}; Object.defineProperty(t0, 'a', { get: function () {} }); return Reflect.set(P(t0, { set: function () { return true; } }), 'a', 2); });
t('del_true_nonconfig', function () { var t0 = {}; Object.defineProperty(t0, 'a', { value: 1 }); return Reflect.deleteProperty(P(t0, { deleteProperty: function () { return true; } }), 'a'); });
t('del_true_nonext', function () { return Reflect.deleteProperty(P(Object.preventExtensions({ a: 1 }), { deleteProperty: function () { return true; } }), 'a'); });
// prototype / extensibility invariants
t('gpo_nonext_mismatch', function () { return Object.getPrototypeOf(P(Object.preventExtensions({}), { getPrototypeOf: function () { return Array.prototype; } })); });
t('gpo_primitive', function () { return Object.getPrototypeOf(P({}, { getPrototypeOf: function () { return 1; } })); });
t('spo_nonext_true', function () { return Reflect.setPrototypeOf(P(Object.preventExtensions({}), { setPrototypeOf: function () { return true; } }), Array.prototype); });
t('isext_mismatch', function () { return Object.isExtensible(P({}, { isExtensible: function () { return false; } })); });
t('pe_true_ext', function () { return Reflect.preventExtensions(P({}, { preventExtensions: function () { return true; } })); });
// revoked
t('revoked', function () { var r = Proxy.revocable({}, {}); r.revoke(); try { r.proxy.a; } catch (e) { return e.name + ':' + Array.isArray(Proxy.revocable([], {}).proxy); } });
t('revoked_isarray', function () { var r = Proxy.revocable([], {}); r.revoke(); try { return Array.isArray(r.proxy); } catch (e) { return e.name; } });
t('trap_not_callable', function () { return P({}, { get: 1 }).a; });
t('trap_null', function () { return P({ a: 1 }, { get: null }).a; });
t('apply_on_nonfn', function () { try { P({}, { apply: function () { return 1; } })(); } catch (e) { return e.name; } });
t('typeof_proxy_fn', function () { return typeof P(function () {}, {}) + typeof P({}, {}); });
// for-in through proxy
t('forin_proxy', function () { var log = []; var p = P({ a: 1, b: 2 }, { ownKeys: function (t) { log.push('ownKeys'); return Reflect.ownKeys(t); }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + k); return Reflect.getOwnPropertyDescriptor(t, k); }, getPrototypeOf: function (t) { log.push('gpo'); return null; } }); var ks = []; for (var k in p) ks.push(k); return ks.join() + '|' + log.join(); });
throw new Error(JSON.stringify(R));
