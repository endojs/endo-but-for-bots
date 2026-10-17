var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('dot', function(){ var d = Temporal.Duration.from({hours: 4}); return String(d.hours); });
t('computed', function(){ var d = Temporal.Duration.from({hours: 4}); var k = 'hours'; return String(d[k]); });
t('reflect', function(){ var d = Temporal.Duration.from({hours: 4}); return String(Reflect.get(d, 'hours')); });
t('destructure', function(){ var d = Temporal.Duration.from({hours: 4}); var {hours} = d; return String(hours); });
t('in', function(){ var d = Temporal.Duration.from({hours: 4}); return String('hours' in d); });
t('proto_desc', function(){ var desc = Object.getOwnPropertyDescriptor(Temporal.Duration.prototype, 'hours'); return desc ? (typeof desc.get) : 'none'; });
t('proto_names', function(){ return Object.getOwnPropertyNames(Temporal.Duration.prototype).join(','); });
t('getter_call', function(){ var d = Temporal.Duration.from({hours: 4}); var desc = Object.getOwnPropertyDescriptor(Temporal.Duration.prototype, 'hours'); return desc ? String(desc.get.call(d)) : 'none'; });
t('plain_dot', function(){ var p = Temporal.PlainDate.from('2020-01-02'); return String(p.year) + ' ' + String(p['year']) + ' ' + String(Reflect.get(p, 'year')); });
t('plain_proto_desc', function(){ var desc = Object.getOwnPropertyDescriptor(Temporal.PlainDate.prototype, 'year'); return desc ? (typeof desc.get) : 'none'; });
t('instant_three', function(){ var i = Temporal.Instant.fromEpochMilliseconds(5); return String(i.epochMilliseconds) + ' ' + String(i['epochMilliseconds']) + ' ' + String(Reflect.get(i, 'epochMilliseconds')); });
t('subclass_shadow', function(){ class D extends Temporal.Duration { get hours() { return 'sub'; } } var d = new D(0,0,0,0,4); return String(d.hours); });
t('proxy', function(){ var d = Temporal.Duration.from({hours: 4}); var p = new Proxy(d, {}); return String(p.hours); });
t('obj_with_proto', function(){ var d = Temporal.Duration.from({hours: 4}); var o = Object.create(d); return String(o.hours); });
throw new Error(JSON.stringify(out));
