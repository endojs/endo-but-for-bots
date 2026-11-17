const d=Temporal.Duration.from({years:1}); const c=new Intl.Collator('en');
const r=[d.years, d['ye'+'ars'], Reflect.get(d,'years'), new Proxy(d,{}).years, typeof c.compare, typeof Reflect.get(c,'compare'), [3,1,2].map(String).sort(c.compare).join()];
throw new Error(JSON.stringify(r.map(String)));
