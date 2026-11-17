var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('re_tostring_subclass', function(){ class R extends RegExp { get flags(){ return 'sub'; } } var r = new R('a','g'); return r.flags + ' ' + String(r); });
t('re_tostring_ownsource', function(){ var r = /a/g; Object.defineProperty(r, 'source', {value: 'own'}); return r.source + ' ' + String(r); });
t('locale', function(){ var l = new Intl.Locale('en-Latn-US'); var k = 'language'; return [l.language, String(l[k]), String(Reflect.get(l, 'language')), String('language' in l), String(Object.getOwnPropertyDescriptor(Intl.Locale.prototype, 'language'))].join('|'); });
t('locale_units_loop', function(){ var l = new Intl.Locale('en-Latn-US'); return ['language','script','region'].map(function(u){ return String(l[u]); }).join(','); });
t('collator_compare', function(){ var c = new Intl.Collator('en'); var k = 'compare'; return [typeof c.compare, typeof c[k], typeof Reflect.get(c, 'compare'), String('compare' in c), String(Object.getOwnPropertyDescriptor(Intl.Collator.prototype, 'compare'))].join('|'); });
t('collator_sort_computed', function(){ var c = new Intl.Collator('en'); var k = 'compare'; return ['b','a'].sort(c[k]).join(','); });
t('ds', function(){ var ds = new DisposableStack(); ds.dispose(); var k = 'disposed'; return [String(ds.disposed), String(ds[k]), String(Reflect.get(ds, 'disposed')), String('disposed' in ds), String(Object.getOwnPropertyDescriptor(DisposableStack.prototype, 'disposed'))].join('|'); });
throw new Error(JSON.stringify(out));
