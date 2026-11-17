var LOCKDOWN_FIRST = 1; lockdown();
var LOCK = typeof LOCKDOWN_FIRST !== 'undefined';
var out = {};
var H = typeof harden === 'function' ? harden : Object.freeze;
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (x.writable ? 'W' : 'w') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
// Verbatim TypeScript 6.0.2 ES5 emit for `target.push(...items)` and `fn(...args)`:
function collect(target, items) { "use strict"; target.push.apply(target, items); return target; }
function wrap(fn, args) { "use strict"; return fn.apply(void 0, args); }
t('ts_push_spread_desc', function(){ return d(collect([], H([1, 2])), 0); });
t('ts_push_spread_then_write', function(){ 'use strict'; var r = collect([], H([1, 2])); r[0] = 9; return r.join(','); });
t('ts_push_spread_then_clear', function(){ 'use strict'; var r = collect([], H([1, 2])); r.length = 0; return r.length; });
t('ts_push_spread_then_sort', function(){ var r = collect([3], H([1, 2])); r.sort(); return r.join(','); });
t('ts_push_spread_then_pop', function(){ 'use strict'; var r = collect([], H([1, 2])); r.pop(); return r.length; });
t('ts_fn_spread_rest_pop', function(){ return wrap(function(){ 'use strict'; var a = Array.prototype.slice.call(arguments); return a.length; }, H([1, 2, 3])); });
t('ts_fn_spread_restparam_pop', function(){ return wrap(function(...a){ var cb = a.pop(); return cb + '/' + a.length; }, H([1, 2, 3])); });
t('ts_fn_spread_args_shift', function(){ return wrap(function(){ var first = [].shift.call(arguments); return first + '/' + arguments.length; }, H([1, 2, 3])); });
// Boundary: which entry forms are affected
t('reflect_apply_push', function(){ var r = []; Reflect.apply(Array.prototype.push, r, H([1, 2])); return d(r, 0); });
t('apply_call_push', function(){ var r = []; Function.prototype.apply.call(Array.prototype.push, r, H([1, 2])); return d(r, 0); });
t('extracted_apply_push', function(){ var ap = Function.prototype.apply; var r = []; ap.call(r.push, r, H([1, 2])); return d(r, 0); });
t('dot_apply_push', function(){ var r = []; r.push.apply(r, H([1, 2])); return d(r, 0); });
t('dot_apply_nonfrozen', function(){ var r = []; r.push.apply(r, [1, 2]); return d(r, 0); });
t('math_max_apply_frozen', function(){ return Math.max.apply(null, H([1, 5, 2])); });
t('template_strings_apply', function(){ function tag(s){ return s; } var s = tag`a${1}b`; function rest(...r){ return r; } return d(rest.apply(null, s), 0); });
throw new Error(JSON.stringify(out));
