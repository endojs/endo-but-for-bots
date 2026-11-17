var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name + ':' + e.message; } }
function D(o, k) { var d = Object.getOwnPropertyDescriptor(o, k); if (!d) return 'undef'; var r = {}; for (var x in d) r[x] = typeof d[x] === 'function' ? 'fn' : (d[x] === undefined ? 'U' : d[x]); return JSON.stringify(r); }
function run(prefix, mint) {
  t(prefix + 'accessor_cycle', function () { var o = {}; o[7] = 'v'; if (mint) Reflect.set({}, 7, 0); Object.defineProperty(o, '7', { get: function () { return 'g'; }, configurable: true, enumerable: true }); var a = o[7]; Object.defineProperty(o, 7, { value: 'd' }); var b = o[7] + D(o, 7); var c = delete o[7]; o[7] = 'n'; return [a, b, c, o[7], Object.keys(o).join()].join('|'); });
  t(prefix + 'nonwritable_strict', function () { 'use strict'; var o = {}; Object.defineProperty(o, '8', { value: 1, writable: false, configurable: true }); if (mint) Reflect.set({}, 8, 0); try { o[8] = 2; return 'nothrow' + o[8]; } catch (e) { return e.name + o[8]; } });
  t(prefix + 'proto_index', function () { var p = { 9: 'P' }; var o = Object.create(p); if (mint) Reflect.set({}, 9, 0); var r = [o[9], 9 in o, o.hasOwnProperty(9)]; o[9] = 'O'; r.push(o[9], p[9], o.hasOwnProperty(9)); return r.join(); });
  t(prefix + 'proto_nonwritable', function () { var p = {}; Object.defineProperty(p, '10', { value: 'P', writable: false }); var o = Object.create(p); if (mint) Reflect.set({}, 10, 0); o[10] = 'O'; return o[10] + ':' + o.hasOwnProperty(10); });
  t(prefix + 'proto_setter', function () { var log = []; var p = {}; Object.defineProperty(p, '11', { set: function (v) { log.push(v); } }); var o = Object.create(p); if (mint) Reflect.set({}, 11, 0); o[11] = 'x'; return log.join() + ':' + o.hasOwnProperty(11); });
  t(prefix + 'freeze_mixed', function () { var o = { 12: 1 }; Object.defineProperty(o, '13', { get: function () { return 1; }, configurable: true, enumerable: true }); if (mint) { Reflect.set({}, 12, 0); Reflect.set({}, 13, 0); } Object.freeze(o); return Object.isFrozen(o) + D(o, 12) + D(o, 13) + Object.keys(o).join(); });
  t(prefix + 'proxy_target_idx', function () { var tg = { 14: 'T' }; var p = new Proxy(tg, { get: function (t, k, r) { return Reflect.get(t, k, r) + '!'; } }); if (mint) Reflect.set({}, 14, 0); return p[14] + ':' + (14 in p) + ':' + D(p, '14'); });
  t(prefix + 'delete_nonconfig', function () { 'use strict'; var o = {}; Object.defineProperty(o, 15, { value: 1 }); if (mint) Reflect.set({}, 15, 0); try { delete o[15]; return 'nothrow'; } catch (e) { return e.name; } });
  t(prefix + 'fn_index', function () { var f = function () {}; f[16] = 1; if (mint) Reflect.set({}, 16, 0); return Reflect.ownKeys(f).join() + ':' + f[16] + ':' + Object.isFrozen(Object.freeze(f)) + D(f, 16); });
  t(prefix + 'map_index_expando', function () { var m = new Map(); m[17] = 1; if (mint) Reflect.set({}, 17, 0); return Object.keys(m).join() + ':' + m[17]; });
  t(prefix + 'error_index', function () { var e = new Error('x'); e[18] = 1; if (mint) Reflect.set({}, 18, 0); return Object.keys(e).join() + ':' + e[18] + ':' + JSON.stringify(e); });
  t(prefix + 'super_index', function () { var p = { 19: 'P' }; var o = { __proto__: p, m() { return super[19]; } }; if (mint) Reflect.set({}, 19, 0); return o.m(); });
  t(prefix + 'with_index', function () { var o = { 20: 1 }; if (mint) Reflect.set({}, 20, 0); with (o) { return typeof o[20]; } });
}
run('a_', false);
run('b_', true);
throw new Error(JSON.stringify(R));
