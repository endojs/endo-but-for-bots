var out = {};
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? (x.writable ? 'W' : 'w') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
function mk() { var a = [10, 20, 30]; Object.defineProperty(a, 1, {value: 20, writable: false, enumerable: false, configurable: false}); return a; }
var F = Object.freeze([10, 20, 30]);
var srcs = { frozen: function(){ return F; }, attributed: mk };
var ops = {
  slice: function(a){ return a.slice(); },
  spread: function(a){ return [...a]; },
  from: function(a){ return Array.from(a); },
  map: function(a){ return a.map(function(x){ return x; }); },
  concat: function(a){ return a.concat(); },
  concat2: function(a){ return [].concat(a); },
  filter: function(a){ return a.filter(function(){ return true; }); },
  assign: function(a){ return Object.assign([], a); },
  objspread: function(a){ return {...a}; },
  toSorted: function(a){ return a.toSorted(); },
  toReversed: function(a){ return a.toReversed(); },
  with_: function(a){ return a.with(2, 30); },
  toSpliced: function(a){ return a.toSpliced(0, 0); },
  push: function(a){ var m = []; m.push(a[0], a[1], a[2]); return m; },
  pushspread: function(a){ var m = []; m.push(...a); return m; },
  index_store: function(a){ var m = []; for (var i = 0; i < a.length; i++) m[i] = a[i]; return m; },
  obj_store: function(a){ var m = {}; for (var i = 0; i < a.length; i++) m[i] = a[i]; return m; },
  splice: function(a){ var m = [0, 0, 0]; m.splice.apply(m, [0, 3].concat(a)); return m; },
  splice_removed: function(a){ var m = a.slice(); return m.splice(0, 3); },
  fill_copyWithin: function(a){ var m = [0, 0, 0, 0, 0, 0]; for (var i = 0; i < 3; i++) m[i] = a[i]; m.copyWithin(3, 0, 3); return m.slice(3); },
  values_iter: function(a){ var m = []; for (var v of a) m.push(v); return m; },
  entries: function(a){ return Object.entries(a).map(function(e){ return e[1]; }); },
  values: function(a){ return Object.values(a); },
  reverse_copy: function(a){ var m = a.slice(); m.reverse(); return m; },
  flat: function(a){ return [a].flat(); },
  flatMap: function(a){ return a.flatMap(function(x){ return [x]; }); },
  sort_copy: function(a){ var m = a.slice(); m.sort(); return m; },
  args: function(a){ return (function(){ return Array.prototype.slice.call(arguments); }).apply(null, a); },
  args_obj: function(a){ return (function(){ return arguments; }).apply(null, a); },
  fromEntries: function(a){ return Object.fromEntries([[0, a[0]], [1, a[1]], [2, a[2]]]); },
  json: function(a){ return JSON.parse(JSON.stringify(a)); },
  groupBy: function(a){ return Object.groupBy(a, function(){ return 'g'; }).g; },
  destructure: function(a){ var [x, y, z] = a; return [x, y, z]; },
  destructure_rest: function(a){ var [...r] = a; return r; },
  fn_rest: function(a){ return (function(...r){ return r; }).apply(null, a); },
  shift: function(a){ var m = a.slice(); m.unshift(5); return m.slice(1); },
};
Object.keys(srcs).forEach(function(s){
  Object.keys(ops).forEach(function(o){
    t(s + ':' + o, function(){ var r = ops[o](srcs[s]()); return [d(r, 0), d(r, 1), d(r, 2)].join(','); });
  });
});
throw new Error(JSON.stringify(out));
