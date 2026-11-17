var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('has_temporal', function(){ return typeof Temporal; });
t('dur_override_getter', function(){ var d = Temporal.Duration.from({years: 1}); Object.defineProperty(Temporal.Duration.prototype, 'years', {get: function(){ return 42; }, configurable: true}); return String(d.years); });
t('dur_delete_getter', function(){ var d = Temporal.Duration.from({months: 2}); delete Temporal.Duration.prototype.months; return String(d.months); });
t('dur_own_prop', function(){ var d = Temporal.Duration.from({days: 3}); Object.defineProperty(d, 'days', {value: 'own'}); return String(d.days); });
t('instant_own', function(){ var i = Temporal.Instant.fromEpochMilliseconds(5); Object.defineProperty(i, 'epochMilliseconds', {value: 'own'}); return String(i.epochMilliseconds); });
t('plain_override', function(){ var p = Temporal.PlainDate.from('2020-01-02'); Object.defineProperty(Temporal.PlainDate.prototype, 'year', {get: function(){ return 'patched'; }, configurable: true}); return String(p.year); });
t('reflect_get', function(){ var d = Temporal.Duration.from({hours: 4}); return String(Reflect.get(d, 'hours')); });
throw new Error(JSON.stringify(out));
