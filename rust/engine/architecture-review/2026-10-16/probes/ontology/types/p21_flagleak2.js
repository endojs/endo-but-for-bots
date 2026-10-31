var out = {};
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (x.writable ? 'W' : 'w') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
var F = Object.freeze([5]);
var FE = Object.freeze([Object.freeze(['k', 1])]);
t('reduce_seed_literal', function(){ var v = F.reduce(function(a, b){ return a + b; }); var o = [v]; return d(o, 0); });
t('reduce_seed_push', function(){ var v = F.reduce(function(a, b){ return a + b; }); var o = []; o.push(v); return d(o, 0); });
t('reduce_seed_index', function(){ var v = F.reduce(function(a, b){ return a + b; }); var o = []; o[0] = v; return d(o, 0); });
t('reduce_seed_obj', function(){ var v = F.reduce(function(a, b){ return a + b; }); var o = {x: v}; return d(o, 'x'); });
t('reduce_seed_apply', function(){ var v = F.reduce(function(a, b){ return a + b; }); return d((function(...r){ return r; })(v), 0); });
t('reduceRight_seed', function(){ var v = F.reduceRight(function(a, b){ return a + b; }); var o = [v]; return d(o, 0); });
t('map_from_frozen_entries_get', function(){ var m = new Map(FE); var v = m.get('k'); var o = [v]; o.push(v); return d(o, 0) + d(o, 1); });
t('map_from_frozen_entries_iter', function(){ var m = new Map(FE); var o = [...m.values()]; var p = Array.from(m.keys()); return d(o, 0) + d(p, 0); });
t('map_from_frozen_entries_entries', function(){ var m = new Map(FE); var e = [...m][0]; return d(e, 0) + d(e, 1); });
t('set_from_frozen', function(){ var s = new Set(F); var o = [...s]; return d(o, 0); });
t('set_from_frozen_foreach', function(){ var s = new Set(F); var o = []; s.forEach(function(v){ o.push(v); }); return d(o, 0); });
t('map_groupBy', function(){ var m = new Map(FE); var r = []; m.forEach(function(v, k){ r.push(v, k); }); return d(r, 0) + d(r, 1); });
t('apply_then_store', function(){ var got; (function(a){ got = [a]; }).apply(null, F); return d(got, 0); });
t('apply_then_obj', function(){ var got; (function(a){ got = {a: a}; }).apply(null, F); return d(got, 'a'); });
t('apply_arguments_spread', function(){ var got; (function(){ got = [...arguments]; }).apply(null, F); return d(got, 0); });
t('apply_arguments_slice', function(){ var got; (function(){ got = Array.prototype.slice.call(arguments); }).apply(null, F); return d(got, 0); });
t('bound_args_frozen', function(){ function g(...r){ return r; } var b = g.bind(null, ...F); return d(b(), 0); });
t('promise_all_frozen', function(){ return 'skip'; });
throw new Error(JSON.stringify(out));
