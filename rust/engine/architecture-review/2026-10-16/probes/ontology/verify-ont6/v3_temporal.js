var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('dur', function(){ var d = Temporal.Duration.from({years: 1, days: 3}); var k = 'years'; return [String(d.years), String(d[k]), String(Reflect.get(d, 'years')), String('years' in d), String(Object.getOwnPropertyDescriptor(Temporal.Duration.prototype, 'years'))].join('|'); });
t('dur_units_loop', function(){ var d = Temporal.Duration.from({years: 1, days: 3}); return ['years','months','days'].map(function(u){ return String(d[u]); }).join(','); });
t('pd', function(){ var p = Temporal.PlainDate.from('2020-02-29'); var k = 'year'; return [String(p.year), String(p[k]), String(p.id), String(p.timeZoneId)].join('|'); });
t('dur_proto_override', function(){ Object.defineProperty(Temporal.Duration.prototype, 'years', {get: function(){ return 42; }, configurable: true}); var d = Temporal.Duration.from({years: 1}); return String(d.years); });
t('dur_own', function(){ var d = Temporal.Duration.from({days: 3}); try { Object.defineProperty(d, 'days', {value: 'own'}); } catch (e) { return 'defineThrew'; } return String(d.days); });
t('proto_names', function(){ return Object.getOwnPropertyNames(Temporal.Duration.prototype).sort().join(','); });
throw new Error(JSON.stringify(out));
