var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('re_paths', function(){ var r = /ab/gi; var k = 'flags'; var s = 'source'; var g = 'global'; return [r.flags, r[k], Reflect.get(r, 'flags'), r.source, r[s], String(r.global), String(r[g]), String('flags' in r)].join('|'); });
t('re_destructure', function(){ var {flags, source, global} = /ab/gi; return [flags, source, global].join('|'); });
t('re_with_spread', function(){ var o = Object.assign({}, /a/g); return JSON.stringify(Object.keys(o)); });
t('ds_paths', function(){ var ds = new DisposableStack(); ds.dispose(); var k = 'disposed'; return String(ds.disposed) + '|' + String(ds[k]) + '|' + String(Reflect.get(ds, 'disposed')); });
t('ds_desc', function(){ var d = Object.getOwnPropertyDescriptor(DisposableStack.prototype, 'disposed'); return d ? typeof d.get : 'none'; });
t('locale_paths', function(){ var l = new Intl.Locale('en-US'); var k = 'language'; return l.language + '|' + String(l[k]) + '|' + String(Reflect.get(l, 'language')); });
t('regex_split_flags', function(){ class R extends RegExp { get flags() { return 'y'; } } var r = new R('b', 'g'); return JSON.stringify('abab'.split(r)); });
throw new Error(JSON.stringify(out));
