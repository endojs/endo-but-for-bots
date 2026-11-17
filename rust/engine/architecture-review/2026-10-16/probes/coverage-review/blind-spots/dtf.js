var out = [];
function t(name, f) { try { out.push([name, f()]); } catch (e) { out.push([name, 'THROW ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)]); } }
t('plain-bound', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC'}); var g = f.format; return g(0); });
t('plain-bound-same', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC'}); return f.format === f.format; });
t('bound-map', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC'}); return [0, 86400000].map(f.format).join('|'); });
t('bound-name-len', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC'}); var g = f.format; return JSON.stringify([g.name, g.length]); });
t('bound-call-this', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC'}); var g = f.format; return g.call(f, 0); });
t('datestyle-bound', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'short'}); var g = f.format; return g(0); });
t('nf-bound', () => { var n = new Intl.NumberFormat('en'); var g = n.format; return g(1234); });
t('coll-bound', () => { var c = new Intl.Collator('en'); var g = c.compare; return g('a', 'b'); });
throw new Error(JSON.stringify(out));
