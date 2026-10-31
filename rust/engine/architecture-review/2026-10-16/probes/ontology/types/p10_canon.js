var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('ta_big', function(){ var a = new Int8Array(2); a[4294967296] = 1; a[4294967295] = 1; a[4294967294] = 1; a[2**53] = 1; a[-1] = 1; a['Infinity'] = 1; a['-Infinity'] = 1; a['NaN'] = 1; a[1e21] = 1; a[0.5] = 1; return Object.keys(a).join(','); });
t('ta_big_get', function(){ var a = new Int8Array(2); Object.prototype[4294967296] = 'proto'; Object.prototype['-1'] = 'proto'; var r = String(a[4294967296]) + ',' + String(a[-1]) + ',' + String(a['4294967296']); delete Object.prototype[4294967296]; delete Object.prototype['-1']; return r; });
t('ta_in', function(){ var a = new Int8Array(2); return [4294967296 in a, '-0' in a, 1 in a, 2 in a, '1.0' in a].join(','); });
t('ta_define', function(){ var a = new Int8Array(2); try { Object.defineProperty(a, '4294967296', {value: 1}); return 'defined ' + Object.keys(a).join(','); } catch (e) { return e.name; } });
t('ta_hasOwn', function(){ var a = new Int8Array(2); return String(Object.prototype.hasOwnProperty.call(a, '4294967296')) + String(Reflect.has(a, '4294967295')); });
t('ta_reflect_set', function(){ var a = new Int8Array(2); return String(Reflect.set(a, '4294967296', 1)) + String(Reflect.set(a, 5, 1)) + String(Reflect.set(a, '-0', 1)); });
t('arr_4294967295', function(){ var a = [1]; a[4294967295] = 'x'; return a.length + ' ' + Object.keys(a).join(','); });
t('proxy_key_spelling', function(){ var seen = []; var p = new Proxy({}, { get: function(t, k){ seen.push(typeof k + ':' + k); return 1; } }); p[4294967295]; p[-0]; p[1.5]; p[4294967296]; p[2**53]; return seen.join(','); });
t('proxy_set_spelling', function(){ var seen = []; var p = new Proxy([], { set: function(t, k, v){ seen.push(k); return true; } }); p[0] = 1; p[4294967294] = 1; p[4294967295] = 1; return seen.join(','); });
t('obj_numeric_key_order', function(){ var o = {}; o[2**53] = 1; o['4294967296'] = 1; o[10] = 1; o[4294967294] = 1; o[4294967295] = 1; o[2] = 1; return Object.keys(o).join(','); });
throw new Error(JSON.stringify(out));
