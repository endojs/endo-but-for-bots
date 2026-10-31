var out = {};
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (x.writable ? 'W' : 'w') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
var F = Object.freeze([1, 2]);
t('reduce_seed_arguments', function(){ return F.reduce(function(){ return d(arguments, 0); }); });
t('reduce_seed_rest', function(){ return F.reduce(function(...r){ return d(r, 0); }); });
t('reduceRight_seed_rest', function(){ return F.reduceRight(function(...r){ return d(r, 0); }); });
t('reduce_seed_push', function(){ var o = []; F.reduce(function(a){ o.push(a); return a; }); return d(o, 0); });
t('sparse_frozen_apply', function(){ var a = [1,,3]; Object.freeze(a); function rest(...r){ return r; } return d(rest.apply(null, a), 0); });
t('push_apply_frozen_then_write', function(){ 'use strict'; var r = []; Array.prototype.push.apply(r, F); r[0] = 9; return r.join(','); });
t('concat_apply', function(){ var r = [].concat.apply([], F); return d(r, 0); });
t('unshift_apply', function(){ var r = [0]; r.unshift.apply(r, F); return d(r, 0); });
t('splice_apply', function(){ var r = [0]; r.splice.apply(r, [0, 0].concat(F)); return d(r, 0); });
throw new Error(JSON.stringify(out));
