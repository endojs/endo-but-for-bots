var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name; } }
function D(o, k) { var d = Object.getOwnPropertyDescriptor(o, k); if (!d) return 'undef'; var r = {}; for (var x in d) r[x] = typeof d[x] === 'function' ? 'fn' : (d[x] === undefined ? 'U' : d[x]); return JSON.stringify(r); }
// Proxy gOPD trap: IsExtensible(target) must precede ToPropertyDescriptor(trapResult)
t('gopd_trap_order', function () {
  var log = [];
  var target = new Proxy({ a: 1 }, { isExtensible: function (t) { log.push('isExtensible'); return Reflect.isExtensible(t); } });
  var p = new Proxy(target, { getOwnPropertyDescriptor: function (t, k) {
    return { get enumerable() { log.push('get enumerable'); return true; }, get configurable() { log.push('get configurable'); return true; }, get value() { log.push('get value'); return 1; }, get writable() { log.push('get writable'); return true; } };
  } });
  Object.getOwnPropertyDescriptor(p, 'a');
  return log.join(',');
});
// deleteProperty trap true for a configurable prop of a non-extensible target
t('delete_trap_nonext', function () { var tg = Object.preventExtensions({ a: 1 }); var p = new Proxy(tg, { deleteProperty: function () { return true; } }); try { delete p.a; return 'nothrow'; } catch (e) { return e.name; } });
// getPrototypeOf trap invariant on non-extensible target
t('gpo_trap_nonext', function () { var tg = Object.preventExtensions({}); var p = new Proxy(tg, { getPrototypeOf: function () { return Array.prototype; } }); try { Object.getPrototypeOf(p); return 'nothrow'; } catch (e) { return e.name; } });
t('ownkeys_extra_nonext', function () { var tg = Object.preventExtensions({ a: 1 }); var p = new Proxy(tg, { ownKeys: function () { return ['a', 'b']; } }); try { Object.keys(p); return 'nothrow'; } catch (e) { return e.name; } });
t('ownkeys_nonstring', function () { var p = new Proxy({}, { ownKeys: function () { return [1]; } }); try { Reflect.ownKeys(p); return 'nothrow'; } catch (e) { return e.name; } });
t('ownkeys_order_passthrough', function () { var p = new Proxy({}, { ownKeys: function () { return ['b', '1', 'a', '0']; } }); return Reflect.ownKeys(p).join(','); });
t('defineProperty_trap_desc', function () { var seen; var p = new Proxy({}, { defineProperty: function (t, k, d) { seen = Object.keys(d).join('+'); return Reflect.defineProperty(t, k, d); } }); Object.defineProperty(p, 'x', { value: 1 }); var s1 = seen; p.y = 2; return s1 + '|' + seen; });
t('set_trap_receiver_create', function () { var t0 = {}; var p = new Proxy(t0, {}); var child = Object.create(p); child.z = 1; return Object.prototype.hasOwnProperty.call(child, 'z') + ':' + Object.prototype.hasOwnProperty.call(t0, 'z'); });
t('has_trap_with', function () { var log = []; var p = new Proxy({ x: 1 }, { has: function (t, k) { log.push(String(k)); return k in t; } }); with (p) { x; } return log.join(','); });
t('revoked_typeof', function () { var r = Proxy.revocable(function () {}, {}); r.revoke(); return typeof r.proxy; });
t('revoked_call', function () { var r = Proxy.revocable(function () {}, {}); r.revoke(); try { r.proxy(); return 'nothrow'; } catch (e) { return e.name; } });
t('proxy_isArray_revoked', function () { var r = Proxy.revocable([], {}); r.revoke(); try { Array.isArray(r.proxy); return 'nothrow'; } catch (e) { return e.name; } });
t('proxy_isArray', function () { return Array.isArray(new Proxy([], {})) + ':' + Array.isArray(new Proxy(new Proxy([], {}), {})); });
// Array exotic
t('arr_len_shrink_nonconfig', function () { var a = [0, 1, 2, 3]; Object.defineProperty(a, 1, { value: 1, configurable: false }); a.length = 0; return a.length + ':' + JSON.stringify(a); });
t('arr_len_shrink_nonconfig_strict', function () { 'use strict'; var a = [0, 1, 2, 3]; Object.defineProperty(a, 1, { value: 1, configurable: false }); try { a.length = 0; return 'nothrow'; } catch (e) { return e.name + ':' + a.length; } });
t('arr_len_define_nonwritable_partial', function () { var a = [0, 1, 2, 3]; Object.defineProperty(a, 1, { value: 1, configurable: false }); var r = Reflect.defineProperty(a, 'length', { value: 0, writable: false }); return r + ':' + a.length + ':' + D(a, 'length'); });
t('arr_len_rangeerror', function () { try { Object.defineProperty([], 'length', { value: -1 }); return 'nothrow'; } catch (e) { return e.name; } });
t('arr_len_valueof_twice', function () { var n = 0; var a = []; Object.defineProperty(a, 'length', { value: { valueOf: function () { n++; return 2; } } }); return n + ':' + a.length; });
t('arr_idx_max', function () { var a = []; a[4294967294] = 1; a[4294967295] = 2; return a.length + ':' + Object.keys(a).join(','); });
t('arr_nonwritable_len_push', function () { var a = [1]; Object.defineProperty(a, 'length', { writable: false }); try { a.push(2); return 'nothrow'; } catch (e) { return e.name + ':' + a.length + ':' + a[1]; } });
t('arr_nonwritable_len_idx', function () { var a = [1]; Object.defineProperty(a, 'length', { writable: false }); a[5] = 1; return a.length + ':' + (5 in a); });
t('arr_define_idx_beyond_nonwritable', function () { var a = [1]; Object.defineProperty(a, 'length', { writable: false }); return Reflect.defineProperty(a, '3', { value: 1 }) + ':' + Reflect.defineProperty(a, '0', { value: 9 }); });
t('arr_accessor_idx', function () { var a = [1, 2, 3]; Object.defineProperty(a, 1, { get: function () { return 'g'; }, configurable: true, enumerable: true }); return a.join() + ':' + a.length + ':' + Object.keys(a).join(); });
t('arr_holes_inherit', function () { Array.prototype[1] = 'P'; var a = [0, , 2]; var r = a[1] + ':' + a.indexOf('P') + ':' + a.hasOwnProperty(1); delete Array.prototype[1]; return r; });
// String exotic
t('str_wrapper_keys', function () { var s = new String('ab'); s.x = 1; s[5] = 1; return Reflect.ownKeys(s).join(','); });
t('str_wrapper_define_same', function () { var s = new String('ab'); return Reflect.defineProperty(s, '0', { value: 'a' }) + ':' + Reflect.defineProperty(s, '0', { value: 'z' }) + ':' + Reflect.defineProperty(s, 'length', { value: 2 }); });
t('str_neg_zero', function () { var s = new String('ab'); return String(s['-0']) + ':' + ('-0' in s) + ':' + String('ab'['-0']); });
t('str_delete_idx', function () { 'use strict'; var s = new String('ab'); try { delete s[0]; return 'nothrow'; } catch (e) { return e.name; } });
t('str_prim_set_strict', function () { 'use strict'; try { 'ab'[0] = 'z'; return 'nothrow'; } catch (e) { return e.name; } });
t('str_prim_set_oob_strict', function () { 'use strict'; try { 'ab'[5] = 'z'; return 'nothrow'; } catch (e) { return e.name; } });
// TypedArray
t('ta_canonical', function () { var ta = new Uint8Array(2); Object.prototype['-0'] = 'P'; Object.prototype['1.5'] = 'P'; var r = [ta['-0'], ta['1.5'], '-0' in ta, '1.5' in ta, ta['Infinity'], ta['NaN'], ta['0.0'], '0.0' in ta].map(String).join(','); delete Object.prototype['-0']; delete Object.prototype['1.5']; return r; });
t('ta_set_noncanonical', function () { var ta = new Uint8Array(2); ta['-0'] = 1; ta['1.5'] = 1; ta['0.0'] = 7; ta['1e2'] = 8; return Object.keys(ta).join(',') + ':' + ta['0.0'] + ':' + ta['1e2']; });
t('ta_gopd', function () { var ta = new Uint8Array([5]); return D(ta, '0') + ':' + D(ta, '1') + ':' + D(ta, '-0'); });
t('ta_define', function () { var ta = new Uint8Array(2); return [Reflect.defineProperty(ta, '0', { value: 1, configurable: false }), Reflect.defineProperty(ta, '0', { value: 2, enumerable: false }), Reflect.defineProperty(ta, '0', { value: 3, writable: false }), Reflect.defineProperty(ta, '0', { get: function () {} }), Reflect.defineProperty(ta, '0', { value: 4 }), Reflect.defineProperty(ta, '5', { value: 4 }), Reflect.defineProperty(ta, '-0', { value: 4 }), ta[0]].join(); });
t('ta_child_set_oob', function () { var ta = new Uint8Array(2); var c = Object.create(ta); c[5] = 1; c[0] = 9; return Object.prototype.hasOwnProperty.call(c, 5) + ':' + Object.prototype.hasOwnProperty.call(c, 0) + ':' + ta[0]; });
t('ta_delete', function () { var ta = new Uint8Array(2); return [delete ta[0], delete ta[5], delete ta['-0']].join(); });
t('ta_detached_keys', function () { try { var b = new ArrayBuffer(4); var ta = new Uint8Array(b); b.transfer(); return Reflect.ownKeys(ta).length + ':' + String(ta[0]) + ':' + (0 in ta); } catch (e) { return 'throws ' + e.name; } });
// arguments exotic
t('args_mapped', function () { function f(a) { arguments[0] = 2; var r1 = a; a = 3; var r2 = arguments[0]; return r1 + ',' + r2; } return f(1); });
t('args_delete_unmaps', function () { function f(a) { delete arguments[0]; arguments[0] = 9; return a + ',' + arguments[0]; } return f(1); });
t('args_define_value', function () { function f(a) { Object.defineProperty(arguments, '0', { value: 5 }); return a; } return f(1); });
t('args_define_nonwritable', function () { function f(a) { Object.defineProperty(arguments, '0', { writable: false }); a = 9; return arguments[0] + ',' + a + ',' + D(arguments, '0'); } return f(1); });
t('args_define_accessor_unmaps', function () { function f(a) { Object.defineProperty(arguments, '0', { get: function () { return 'g'; } }); a = 9; return arguments[0]; } return f(1); });
t('args_strict', function () { 'use strict'; function f(a) { arguments[0] = 2; return a; } return f(1); });
t('args_keys', function () { function f(a, b) { arguments.x = 1; return Reflect.ownKeys(arguments).map(String).join(); } return f(1, 2); });
t('args_callee_strict', function () { 'use strict'; function f() { return D(arguments, 'callee'); } return f(); });
// ordinary define edge cases
t('vapd_nonconfig_enum_change', function () { var o = {}; Object.defineProperty(o, 'x', { value: 1 }); return Reflect.defineProperty(o, 'x', { enumerable: true }) + ':' + Reflect.defineProperty(o, 'x', { enumerable: false }); });
t('vapd_nonconfig_accessor_same_fn', function () { var g = function () {}; var o = {}; Object.defineProperty(o, 'x', { get: g }); return Reflect.defineProperty(o, 'x', { get: g }) + ':' + Reflect.defineProperty(o, 'x', { get: function () {} }) + ':' + Reflect.defineProperty(o, 'x', { set: undefined }); });
t('vapd_nan_minus_zero', function () { var o = {}; Object.defineProperty(o, 'x', { value: NaN }); Object.defineProperty(o, 'y', { value: -0 }); return Reflect.defineProperty(o, 'x', { value: NaN }) + ':' + Reflect.defineProperty(o, 'y', { value: 0 }) + ':' + Reflect.defineProperty(o, 'y', { value: -0 }); });
t('vapd_data_to_accessor_keeps_enum', function () { var o = { x: 1 }; Object.defineProperty(o, 'x', { get: function () { return 2; } }); return D(o, 'x'); });
t('vapd_accessor_to_data_defaults', function () { var o = {}; Object.defineProperty(o, 'x', { get: function () {}, configurable: true }); Object.defineProperty(o, 'x', { value: 1 }); return D(o, 'x'); });
t('vapd_generic_on_accessor', function () { var o = {}; Object.defineProperty(o, 'x', { get: function () {}, set: function () {}, configurable: true }); Object.defineProperty(o, 'x', { enumerable: true }); return D(o, 'x'); });
t('vapd_set_only_keeps_get', function () { var o = {}; Object.defineProperty(o, 'x', { get: function () { return 1; }, configurable: true }); Object.defineProperty(o, 'x', { set: function () {} }); return o.x + D(o, 'x'); });
// integrity
t('freeze_idx_store', function () { var o = { 0: 1, a: 2 }; Object.freeze(o); 'use strict'; o[0] = 9; return o[0] + ':' + Object.isFrozen(o) + ':' + D(o, '0'); });
t('seal_then_assign', function () { var o = { 0: 1, a: 2 }; Object.seal(o); o[0] = 5; o.a = 6; return o[0] + ':' + o.a + ':' + (delete o[0]) + ':' + Object.isSealed(o) + ':' + Object.isFrozen(o); });
t('pe_then_add_idx', function () { var o = Object.preventExtensions({}); o[0] = 1; o.a = 1; return JSON.stringify(o) + ':' + Reflect.defineProperty(o, '1', { value: 1 }); });
t('isfrozen_fn', function () { var f = function () {}; Object.freeze(f); return Object.isFrozen(f) + D(f, 'prototype') + D(f, 'name'); });
t('freeze_proxy_order', function () { var log = []; var p = new Proxy({ a: 1 }, { preventExtensions: function (t) { log.push('pe'); return Reflect.preventExtensions(t); }, ownKeys: function (t) { log.push('ownKeys'); return Reflect.ownKeys(t); }, defineProperty: function (t, k, d) { log.push('dp:' + k + ':' + Object.keys(d).join('+')); return Reflect.defineProperty(t, k, d); }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + k); return Reflect.getOwnPropertyDescriptor(t, k); } }); Object.freeze(p); return log.join(','); });
t('isfrozen_proxy_order', function () { var log = []; var p = new Proxy(Object.freeze({ a: 1, b: 2 }), { isExtensible: function (t) { log.push('ie'); return Reflect.isExtensible(t); }, ownKeys: function (t) { log.push('ownKeys'); return Reflect.ownKeys(t); }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + k); return Reflect.getOwnPropertyDescriptor(t, k); } }); Object.isFrozen(p); return log.join(','); });
// own keys order
t('order_mixed', function () { var o = {}; o.b = 1; o[2] = 1; o.a = 1; o[1] = 1; Object.defineProperty(o, '0', { get: function () {}, enumerable: true, configurable: true }); o[Symbol.iterator] = 1; o['-1'] = 1; return Reflect.ownKeys(o).map(String).join(','); });
t('order_delete_readd_idx', function () { var o = { 1: 1, 0: 0, a: 1 }; delete o[0]; o[0] = 0; return Object.keys(o).join(','); });
t('json_parse_keys_order', function () { return Object.keys(JSON.parse('{"b":1,"2":1,"a":1,"1":1}')).join(','); });
t('assign_order', function () { var log = []; var src = new Proxy({ b: 1, 1: 1, a: 1 }, { get: function (t, k) { log.push(String(k)); return t[k]; } }); Object.assign({}, src); return log.join(','); });
t('forin_shadow', function () { var p = { a: 1, b: 2 }; var o = Object.create(p); Object.defineProperty(o, 'a', { value: 1, enumerable: false }); var r = []; for (var k in o) r.push(k); return r.join(','); });
t('forin_delete_during', function () { var o = { a: 1, b: 2, c: 3 }; var r = []; for (var k in o) { r.push(k); delete o.b; } return r.join(','); });
throw new Error(JSON.stringify(R));
