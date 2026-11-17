// node --expose-gc node_units.js : heapUsed bytes per unit (compare with IronHorse per_unit probes)
function m(name, n, make) {
  gc(); const keep = []; gc(); const b = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) keep.push(make(i));
  gc(); const a = process.memoryUsage().heapUsed;
  console.log(name, ((a - b) / n).toFixed(1), 'B/unit (incl. ~8B array slot)', keep.length);
}
m('empty_object', 100000, () => ({}));
m('object_4props', 100000, (i) => ({a: i, b: i, c: i, d: i}));
m('short_string', 100000, (i) => 's' + i);
m('closure', 100000, (i) => () => i);
m('pending_promise', 100000, () => new Promise(() => {}));
m('bound_fn', 100000, () => (function f() {}).bind(null));
m('class_2_private', 100000, () => new (class { #a = 1; #b = 2; })());
const C = class { #a = 1; #b = 2; };
m('class_2_private_shared', 100000, () => new C());
m('error', 20000, () => new Error('x'));
m('regexp', 100000, () => /ab+c/g);
{ gc(); const b = process.memoryUsage().heapUsed; const mp = new Map(); for (let i = 0; i < 100000; i++) mp.set(i, i); gc(); console.log('map_int_entry', ((process.memoryUsage().heapUsed - b) / 100000).toFixed(1), mp.size); }
{ gc(); const b = process.memoryUsage().heapUsed; const a = []; for (let i = 0; i < 1000000; i++) a.push(i & 1023); gc(); console.log('array_small_int_item', ((process.memoryUsage().heapUsed - b) / 1000000).toFixed(1), a.length); }
