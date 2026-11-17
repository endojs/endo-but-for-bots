var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name; } }
function D(o, k) { var d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? 'undef' : JSON.stringify(d, function (k, v) { return typeof v === 'function' ? 'fn' : (v === undefined ? 'U' : v); }); }
// ValidateAndApplyPropertyDescriptor
var g = function () {}, s = function () {};
t('v_same_accessor_nonconfig', function () { var o = {}; Object.defineProperty(o, 'a', { get: g, set: s }); return [Reflect.defineProperty(o, 'a', { get: g }), Reflect.defineProperty(o, 'a', { get: function () {} }), Reflect.defineProperty(o, 'a', { set: undefined }), Reflect.defineProperty(o, 'a', { enumerable: true }), Reflect.defineProperty(o, 'a', { value: 1 })].join(); });
t('v_nonconfig_writable', function () { var o = {}; Object.defineProperty(o, 'a', { value: 1, writable: true }); return [Reflect.defineProperty(o, 'a', { value: 2 }), Reflect.defineProperty(o, 'a', { writable: false }), Reflect.defineProperty(o, 'a', { writable: true }), Reflect.defineProperty(o, 'a', { value: 2 }), D(o, 'a')].join(); });
t('v_zero', function () { var o = {}; Object.defineProperty(o, 'a', { value: 0 }); return [Reflect.defineProperty(o, 'a', { value: -0 }), Reflect.defineProperty(o, 'a', { value: 0 })].join(); });
t('v_nan', function () { var o = {}; Object.defineProperty(o, 'a', { value: NaN }); return Reflect.defineProperty(o, 'a', { value: 0 / 0 }); });
t('v_generic_preserves', function () { var o = {}; Object.defineProperty(o, 'a', { get: g, configurable: true }); Object.defineProperty(o, 'a', { enumerable: true }); return D(o, 'a'); });
t('v_config_data_to_accessor', function () { var o = { a: 1 }; Object.defineProperty(o, 'a', { get: g }); return D(o, 'a'); });
t('v_config_accessor_to_data', function () { var o = {}; Object.defineProperty(o, 'a', { get: g, enumerable: true, configurable: true }); Object.defineProperty(o, 'a', { value: 3 }); return D(o, 'a'); });
t('v_empty_desc_new', function () { var o = {}; Object.defineProperty(o, 'a', {}); return D(o, 'a'); });
t('v_getter_undefined_explicit', function () { var o = {}; Object.defineProperty(o, 'a', { get: undefined, configurable: false }); return [D(o, 'a'), Reflect.defineProperty(o, 'a', { get: undefined }), Reflect.defineProperty(o, 'a', { set: undefined })].join(); });
t('v_desc_get_and_value', function () { try { Object.defineProperty({}, 'a', { get: g, value: 1 }); return 'nothrow'; } catch (e) { return e.name; } });
t('v_desc_getter_noncallable', function () { try { Object.defineProperty({}, 'a', { get: 1 }); return 'nothrow'; } catch (e) { return e.name; } });
t('v_desc_inherited_fields', function () { var proto = { enumerable: true, value: 5 }; var o = {}; Object.defineProperty(o, 'a', Object.create(proto)); return D(o, 'a'); });
t('v_desc_order', function () { var log = []; var d = new Proxy({}, { has: function (t, k) { log.push('has:' + k); return k === 'value'; }, get: function (t, k) { log.push('get:' + k); return 1; } }); Object.defineProperty({}, 'a', d); return log.join(); });
// freeze / seal / preventExtensions
t('freeze_accessor', function () { var o = {}; Object.defineProperty(o, 'a', { get: g, set: s, configurable: true }); Object.freeze(o); return D(o, 'a') + Object.isFrozen(o); });
t('freeze_array_push', function () { var a = Object.freeze([1]); try { a.push(2); return 'nothrow'; } catch (e) { return e.name + a.length; } });
t('freeze_array_idx_assign_strict', function () { 'use strict'; var a = Object.freeze([1]); try { a[0] = 2; return 'nothrow'; } catch (e) { return e.name + a[0]; } });
t('seal_arr_length', function () { var a = Object.seal([1, 2, 3]); a.length = 1; return a.length + ':' + Object.isSealed(a) + ':' + Object.isFrozen(a); });
t('freeze_fn', function () { function f() {} Object.freeze(f); return [D(f, 'length'), D(f, 'name'), D(f, 'prototype'), Object.isFrozen(f)].join('|'); });
t('freeze_str_wrapper', function () { var s = Object.freeze(new String('ab')); return Object.isFrozen(s) + ':' + D(s, '0'); });
t('isfrozen_empty_nonext', function () { return [Object.isFrozen(Object.preventExtensions({})), Object.isFrozen(Object.preventExtensions([])), Object.isSealed(Object.preventExtensions(function () {}))].join(); });
t('isfrozen_args', function () { var a = (function () { return arguments; })(1); Object.freeze(a); return Object.isFrozen(a) + D(a, '0') + D(a, 'length'); });
t('freeze_ta_nonempty', function () { try { Object.freeze(new Uint8Array(2)); return 'nothrow'; } catch (e) { return e.name; } });
t('seal_ta', function () { var ta = Object.seal(new Uint8Array(2)); ta[0] = 5; return Object.isSealed(ta) + ':' + ta[0] + ':' + Object.isFrozen(ta); });
t('pe_ta_resizable', function () { var rab = new ArrayBuffer(4, { maxByteLength: 8 }); var ta = new Uint8Array(rab); try { Object.preventExtensions(ta); return 'nothrow'; } catch (e) { return e.name; } });
t('harden', function () { return typeof harden; });
t('lockdown', function () { return typeof lockdown; });
// delete semantics
t('delete_nonconfig_strict', function () { 'use strict'; try { delete Object.prototype; } catch (e) { return e.name; } return 'nothrow'; });
t('delete_arr_length', function () { return delete [].length; });
t('delete_fn_length_then_keys', function () { function f(a) {} delete f.length; return Reflect.ownKeys(f).join() + ':' + f.length; });
t('delete_fn_prototype', function () { function f() {} return delete f.prototype; });
t('delete_class_prototype', function () { class C {} return delete C.prototype; });
// global object
t('global_nonconfig_var', function () { return D(globalThis, 'R'); });
t('global_keys_order', function () { globalThis.zz1 = 1; globalThis[7] = 1; var k = Object.keys(globalThis); return k.indexOf('7') < k.indexOf('zz1'); });
// __proto__ / setPrototypeOf cycles
t('cycle', function () { var a = {}, b = Object.create(a); try { Object.setPrototypeOf(a, b); return 'nothrow'; } catch (e) { return e.name; } });
t('cycle_through_proxy', function () { var a = {}; var p = new Proxy(Object.create(a), {}); return Reflect.setPrototypeOf(a, p); });
t('proto_literal', function () { var o = { __proto__: Array.prototype }; return Array.isArray(o) + ':' + (o instanceof Array) + ':' + Object.prototype.hasOwnProperty.call(o, '__proto__'); });
t('proto_computed_literal', function () { var o = { ['__proto__']: 1 }; return Object.prototype.hasOwnProperty.call(o, '__proto__'); });
throw new Error(JSON.stringify(R));
