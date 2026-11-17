var out = {};
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (x.writable ? 'W' : 'w') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
var F = Object.freeze([1, 2]);
function rest(...r) { return r; }
function argsf() { return arguments; }
// Is the flag merely on the rest/arguments item, or does it ride on the parameter local too?
t('param_assign_strict', function(){ function g(a){ 'use strict'; a = 5; return a; } return g.apply(null, F); });
t('param_assign_sloppy', function(){ function g(a){ a = 5; return a; } return g.apply(null, F); });
t('param_closure_assign', function(){ function g(a){ 'use strict'; var h = function(){ a = 6; return a; }; return h(); } return g.apply(null, F); });
t('param_to_obj', function(){ function g(a){ var o = {}; o.p = a; return d(o, 'p'); } return g.apply(null, F); });
t('param_to_array_lit', function(){ function g(a){ var arr = [a]; return d(arr, 0); } return g.apply(null, F); });
t('param_push', function(){ function g(a){ var arr = []; arr.push(a); return d(arr, 0); } return g.apply(null, F); });
t('param_index_set', function(){ function g(a){ var arr = []; arr[0] = a; return d(arr, 0); } return g.apply(null, F); });
t('arguments_slice', function(){ var a = argsf.apply(null, F); return d(Array.prototype.slice.call(a), 0); });
t('rest_spread_again', function(){ var r = rest.apply(null, F); return d(rest.apply(null, r), 0); });
t('rest_delete', function(){ 'use strict'; var r = rest.apply(null, F); delete r[0]; return r.length + ':' + (0 in r); });
t('rest_reverse', function(){ var r = rest.apply(null, F); r.reverse(); return r.join(','); });
t('rest_isFrozen', function(){ var r = rest.apply(null, F); return Object.isFrozen(r) + ' ' + Object.isSealed(r); });
t('args_isFrozen', function(){ var r = argsf.apply(null, F); return Object.isFrozen(r); });
t('sealed_source', function(){ var S = Object.seal([1,2]); var r = rest.apply(null, S); return d(r, 0); });
t('nonenum_source', function(){ var a = [1,2]; Object.defineProperty(a, 1, {enumerable:false}); var r = rest.apply(null, a); return d(r, 1) + ' ' + Object.keys(r).join(','); });
t('reflect_apply_args', function(){ return d(Reflect.apply(argsf, null, F), 0); });
t('call_apply', function(){ return d(Function.prototype.call.apply(rest, [null, 1]), 0); });
t('apply_apply', function(){ return d(Function.prototype.apply.apply(rest, [null, F]), 0); });
t('native_apply', function(){ var r = Math.max.apply(null, F); return r; });
t('array_of_apply', function(){ var r = Array.of.apply(Array, F); return d(r, 0); });
t('push_apply', function(){ var r = []; Array.prototype.push.apply(r, F); return d(r, 0); });
t('construct_via_apply_super', function(){ class A { constructor(...x){ this.x = x; } } class B extends A { constructor(){ super(...arguments); } } var b = (function(){ return Reflect.construct(B, F); })(); return d(b.x, 0); });
t('derived_default_ctor', function(){ class A { constructor(...x){ this.x = x; } } class B extends A {} function mk(){ return new B(...arguments); } return d(mk.apply(null, F).x, 0); });
throw new Error(JSON.stringify(out));
