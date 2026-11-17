var out = {};
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (x.writable ? 'W' : 'w') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
var F = Object.freeze([1, 2]);
function rest(...r) { return r; }
function argsf() { return arguments; }
function sargsf() { 'use strict'; return arguments; }
t('apply_rest', function(){ return d(rest.apply(null, F), 0); });
t('reflect_apply_rest', function(){ return d(Reflect.apply(rest, null, F), 0); });
t('spread_call_rest', function(){ return d(rest(...F), 0); });
t('call_rest', function(){ return d(rest.call(null, F[0], F[1]), 0); });
t('apply_args', function(){ return d(argsf.apply(null, F), 0); });
t('apply_strict_args', function(){ return d(sargsf.apply(null, F), 0); });
t('construct_rest', function(){ function C(...r) { this.r = r; } return d(Reflect.construct(C, F).r, 0); });
t('new_spread_rest', function(){ function C(...r) { this.r = r; } return d(new C(...F).r, 0); });
t('bound_apply_rest', function(){ var b = rest.bind(null); return d(b.apply(null, F), 0); });
t('mutate_rest_strict', function(){ 'use strict'; var r = rest.apply(null, F); r[0] = 99; return r[0]; });
t('mutate_rest_sloppy', function(){ var r = rest.apply(null, F); r[0] = 99; return r[0]; });
t('push_after', function(){ var r = rest.apply(null, F); r.push(3); r.sort(function(a,b){ return b - a; }); return r.join(','); });
t('param_reassign', function(){ function p(a, b) { a = 7; return a + ',' + arguments[0]; } return p.apply(null, F); });
t('harden_like', function(){ var args = Object.freeze(['x']); function g(...xs) { xs[0] = 'y'; return xs[0]; } return g.apply(undefined, args); });
t('nonwritable_elem_apply', function(){ var a = [1, 2]; Object.defineProperty(a, 0, {writable: false}); var r = rest.apply(null, a); return d(r, 0) + ' ' + d(a, 0); });
t('promise_all_frozen', function(){ return 'skip'; });
throw new Error(JSON.stringify(out));
