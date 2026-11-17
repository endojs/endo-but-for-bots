var out={}; function t(n,f){try{out[n]=String(f())}catch(e){out[n]='THROW '+e.name+':'+e.message}}
t('ym_from_pd_plain', function(){ var pd=Temporal.PlainDate.from('2020-05-17'); return Temporal.PlainYearMonth.from(pd).toString(); });
t('ym_from_pd_ownprops', function(){ var pd=Temporal.PlainDate.from('2020-05-17'); Object.defineProperties(pd,{year:{value:pd.year},month:{value:pd.month},monthCode:{value:pd.monthCode}}); return Temporal.PlainYearMonth.from(pd).toString(); });
t('pd_has_year', function(){ var pd=Temporal.PlainDate.from('2020-05-17'); return ['year' in pd, Reflect.get(pd,'year'), pd.year].join('|'); });
throw new Error(JSON.stringify(out));
