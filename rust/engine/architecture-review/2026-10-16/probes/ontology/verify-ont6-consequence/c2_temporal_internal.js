var out={}; function t(n,f){try{out[n]=String(f())}catch(e){out[n]='THROW '+e.name+':'+e.message}}
var pd = Temporal.PlainDate.from('2020-05-17');
t('ym_from_pd', function(){ return Temporal.PlainYearMonth.from(pd).toString(); });
t('md_from_pd', function(){ return Temporal.PlainMonthDay.from(pd).toString(); });
t('ym_compare_pd', function(){ return Temporal.PlainYearMonth.compare(pd, Temporal.PlainDate.from('2020-06-01')); });
t('md_from_pdt', function(){ return Temporal.PlainMonthDay.from(Temporal.PlainDateTime.from('2020-05-17T10:00')).toString(); });
t('pd_from_ym_bag', function(){ var ym = Temporal.PlainYearMonth.from('2020-05'); return Temporal.PlainDate.from({year: ym.year, month: ym.month, day: 1}).toString(); });
t('duration_fmt_loop', function(){ var d = Temporal.Duration.from({hours:2, minutes:30}); return ['hours','minutes','seconds'].filter(function(u){return d[u];}).map(function(u){return d[u]+u[0];}).join(' '); });
t('duration_dot', function(){ var d = Temporal.Duration.from({hours:2, minutes:30}); return d.hours+':'+d.minutes; });
t('pd_from_obj_with_proto', function(){ return Temporal.PlainDate.from(Object.create(pd)).toString(); });
t('locale_loop', function(){ var l=new Intl.Locale('en-Latn-US'); return ['language','script','region'].map(function(k){return l[k];}).join('-'); });
throw new Error(JSON.stringify(out));
