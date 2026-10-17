var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name; } }
// OrdinaryOwnPropertyKeys order
var s1 = Symbol('s1'), s2 = Symbol('s2');
t('order', function () {
  var o = {}; o.b = 1; o[s2] = 1; o['4294967295'] = 1; o[2] = 1; o['4294967294'] = 1; o.a = 1; o[0] = 1; o['-1'] = 1; o['01'] = 1; o[s1] = 1; o[1.5] = 1;
  return Reflect.ownKeys(o).map(String).join(',');
});
t('order_redefine', function () { var o = { a: 1, b: 2 }; delete o.a; o.a = 3; return Object.keys(o).join(','); });
t('order_accessor_index', function () {
  var o = {}; o[3] = 1; Object.defineProperty(o, '2', { get: function () { return 1; }, enumerable: true, configurable: true }); o[1] = 1;
  return Object.keys(o).join(',');
});
t('fn_order', function () { function f(a, b) {} f.z = 1; f[1] = 1; return Reflect.ownKeys(f).join(','); });
t('fn_order_redefined_name', function () { function f() {} delete f.name; f.name2 = 1; Object.defineProperty(f, 'name', { value: 'x', configurable: true }); return Reflect.ownKeys(f).join(','); });
t('class_order', function () { class C { static m() {} static [Symbol.iterator]() {} } return Reflect.ownKeys(C).map(String).join(','); });
// array length
t('arr_len_trunc_nonconfig', function () {
  var a = [0, 1, 2, 3, 4]; Object.defineProperty(a, 2, { value: 2, configurable: false });
  var r = Reflect.defineProperty(a, 'length', { value: 0 }); return r + ':' + a.length + ':' + JSON.stringify(a);
});
t('arr_len_trunc_nonconfig_strict_assign', function () {
  'use strict'; var a = [0, 1, 2, 3]; Object.defineProperty(a, 1, { value: 1, configurable: false });
  try { a.length = 0; return 'no throw ' + a.length; } catch (e) { return e.name + ':' + a.length; }
});
t('arr_len_nonwritable_push', function () {
  var a = [1, 2]; Object.defineProperty(a, 'length', { writable: false });
  try { a.push(3); return 'no throw'; } catch (e) { return e.name + ':' + a.length + ':' + a[2]; }
});
t('arr_len_define_writable_false_then_shrink', function () {
  var a = [0, 1, 2]; Object.defineProperty(a, 1, { configurable: false });
  var r = Reflect.defineProperty(a, 'length', { value: 0, writable: false });
  var d = Object.getOwnPropertyDescriptor(a, 'length'); return r + ':' + d.value + ':' + d.writable;
});
t('arr_len_valueOf_twice', function () { var n = 0; var a = []; Object.defineProperty(a, 'length', { value: { valueOf: function () { n++; return 2; } } }); return n + ':' + a.length; });
t('arr_len_fraction', function () { var a = []; try { a.length = 1.5; return 'nothrow'; } catch (e) { return e.name; } });
t('arr_index_4294967295', function () { var a = []; a[4294967295] = 1; return a.length + ':' + Object.keys(a).join(','); });
t('arr_index_4294967294', function () { var a = []; a[4294967294] = 1; return a.length; });
// string exotic
t('str_keys', function () { var s = new String('ab'); s[5] = 'x'; s.q = 1; s[2] = 'y'; return Reflect.ownKeys(s).join(','); });
t('str_define_idx', function () { var s = new String('ab'); return Reflect.defineProperty(s, '0', { value: 'a' }) + ':' + Reflect.defineProperty(s, '0', { value: 'b' }) + ':' + Reflect.defineProperty(s, '1', { value: 'b', writable: false, enumerable: true, configurable: false }); });
t('str_delete', function () { var s = new String('ab'); return delete s[0]; });
t('str_neg0', function () { var s = new String('ab'); return [s['-0'], '-0' in s, s['1.0'], s['01']].join(','); });
t('str_gopd_len', function () { var d = Object.getOwnPropertyDescriptor(new String('abc'), 'length'); return JSON.stringify(d); });
t('str_prim_in', function () { return Object.getOwnPropertyNames('ab').join(','); });
// typed array canonical numeric
t('ta_keys', function () {
  var ta = new Uint8Array(2);
  var out = [];
  ['-0', '1.5', '0x1', '01', 'Infinity', '-Infinity', 'NaN', '1e+21', '1e21', '2', '-1', '0'].forEach(function (k) {
    ta[k] = 7; out.push(k + '=' + ta[k] + '/' + (k in ta) + '/' + Object.prototype.hasOwnProperty.call(ta, k));
  });
  return out.join(' ');
});
t('ta_proto_shadow', function () { Object.prototype['-0'] = 'P'; Object.prototype['1.5'] = 'Q'; Object.prototype['5'] = 'R'; var ta = new Uint8Array(1); var r = [ta['-0'], ta['1.5'], ta[5]].join(','); delete Object.prototype['-0']; delete Object.prototype['1.5']; delete Object.prototype['5']; return r; });
t('ta_define', function () { var ta = new Uint8Array(2); return [Reflect.defineProperty(ta, '0', { value: 1 }), Reflect.defineProperty(ta, '0', { value: 1, configurable: false }), Reflect.defineProperty(ta, '0', { get: function () {} }), Reflect.defineProperty(ta, '5', { value: 1 }), Reflect.defineProperty(ta, '-0', { value: 1 }), Reflect.defineProperty(ta, '0', { value: 1, enumerable: false })].join(','); });
t('ta_gopd', function () { return JSON.stringify(Object.getOwnPropertyDescriptor(new Uint8Array([9]), '0')); });
t('ta_freeze', function () { try { Object.freeze(new Uint8Array(1)); return 'nothrow'; } catch (e) { return e.name; } });
t('ta_freeze_empty', function () { try { var x = Object.freeze(new Uint8Array(0)); return Object.isFrozen(x); } catch (e) { return e.name; } });
t('ta_set_receiver', function () { var ta = new Uint8Array(1); var o = Object.create(ta); o[0] = 5; o['-0'] = 6; return [ta[0], Object.keys(o).join('|'), o.hasOwnProperty('-0')].join(','); });
// arguments exotic
t('args_mapped', function () { function f(a) { arguments[0] = 2; var r1 = a; a = 3; var r2 = arguments[0]; delete arguments[0]; arguments[0] = 9; return [r1, r2, a].join(','); } return f(1); });
t('args_define_nonwritable', function () { function f(a) { Object.defineProperty(arguments, '0', { writable: false }); a = 5; var r = arguments[0]; return r; } return f(1); });
t('args_define_value_then_nw', function () { function f(a) { Object.defineProperty(arguments, '0', { value: 7, writable: false }); var r1 = a; a = 5; return r1 + ',' + arguments[0]; } return f(1); });
t('args_keys', function () { function f(a, b) { return Reflect.ownKeys(arguments).map(String).join(','); } return f(1, 2); });
t('args_len_delete', function () { function f(a) { delete arguments.length; return arguments.length + ':' + Object.keys(arguments).length; } return f(1, 2); });
t('args_strict_callee', function () { 'use strict'; function f() { try { return arguments.callee; } catch (e) { return e.name; } } return f(); });
// immutable prototype exotic
t('objproto_setproto', function () { try { Object.setPrototypeOf(Object.prototype, {}); return 'nothrow ' + (Object.getPrototypeOf(Object.prototype) === null); } catch (e) { return e.name; } });
t('objproto_setproto_same', function () { return Reflect.setPrototypeOf(Object.prototype, null); });
t('objproto___proto__', function () { try { Object.prototype.__proto__ = {}; return 'nothrow ' + (Object.getPrototypeOf(Object.prototype) === null); } catch (e) { return e.name; } });
throw new Error(JSON.stringify(R));
