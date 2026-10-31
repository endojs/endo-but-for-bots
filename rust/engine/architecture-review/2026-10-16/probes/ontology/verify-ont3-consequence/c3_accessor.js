var out = {};
function d(o, k) { var x = Object.getOwnPropertyDescriptor(o, k); return x ? ('value' in x ? (x.writable ? 'W' : 'w') : 'A') + (x.enumerable ? 'E' : 'e') + (x.configurable ? 'C' : 'c') : 'none'; }
function t(name, f){ try { out[name] = String(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
function rest(...r) { return r; }
t('accessor_elem_apply', function(){ var a = [1, 2]; Object.defineProperty(a, 0, { get: function(){ return 7; }, configurable: false }); var r = rest.apply(null, a); return r[0] + ' ' + d(r, 0); });
t('frozen_obj_values_apply', function(){ var a = Object.freeze([{x:1}, 'y']); var r = rest.apply(null, a); return d(r, 1); });
t('second_gen', function(){ var r = rest.apply(null, Object.freeze([1])); var r2 = []; r2.push.apply(r2, r); return d(r2, 0); });
throw new Error(JSON.stringify(out));
