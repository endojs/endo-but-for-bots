var out = [];
function t(name, f) { try { out.push([name, f()]); } catch (e) { out.push([name, 'THROW ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)]); } }
t('pdt-add-month-constrain', () => Temporal.PlainDateTime.from('2024-01-31T10:20:30.123456789').add({months: 1}).toString());
t('pdt-add-month-constrain-noNs', () => Temporal.PlainDateTime.from('2024-01-31T10:20:30').add({months: 1}).toString());
t('pd-add-month-constrain', () => Temporal.PlainDate.from('2024-01-31').add({months: 1}).toString());
t('pdt-add-day', () => Temporal.PlainDateTime.from('2024-01-31T10:20:30.123456789').add({days: 1}).toString());
t('pdt-nanosecond', () => Temporal.PlainDateTime.from('2024-01-31T10:20:30.123456789').nanosecond);
t('pdt-add-hours', () => Temporal.PlainDateTime.from('2024-01-31T10:20:30.123456789').add({hours: 1}).toString());
t('pt-from', () => Temporal.PlainTime.from('12:34:56').toString());
t('pym-from', () => Temporal.PlainYearMonth.from('2024-02').toString());
t('pmd-from', () => Temporal.PlainMonthDay.from('--02-29').toString());
t('pmd-from2', () => Temporal.PlainMonthDay.from('02-29').toString());
t('dtf-format-getter', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long'}); var g = f.format; return g(0); });
t('dtf-format-direct', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long'}); return f.format(0); });
t('dtf-parts', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long'}); return f.formatToParts(86400000).length; });
t('dtf-resolved', () => { var f = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long'}); return f.resolvedOptions().timeZone; });
t('intl-ctors', () => ['ListFormat','RelativeTimeFormat','DisplayNames','Locale','Segmenter','PluralRules','Collator','NumberFormat','DateTimeFormat','DurationFormat'].map(k => k + ':' + typeof Intl[k]).join(','));
throw new Error(JSON.stringify(out));
