const r = [];
function t(label, f) { try { r.push(label + '=' + String(f())); } catch (e) { r.push(label + '!' + e.name + ':' + e.message); } }
t('feb31', () => Temporal.PlainDate.from({ year: 2021, month: 2, day: 31 }));
t('y300000', () => new Temporal.PlainDate(300000, 1, 1));
t('hebrewCrit', () => Temporal.PlainDate.from('2021-01-01[!u-ca=hebrew]'));
t('instNoSec', () => Temporal.Instant.from('2020-01-01T00:00Z'));
t('leapSec', () => Temporal.PlainTime.from('12:00:60'));
t('reject', () => Temporal.PlainDate.from('2021-01-31').add({ months: 1 }, { overflow: 'reject' }));
t('toZDT', () => Temporal.Instant.from('2020-01-01T00:00:00Z').toZonedDateTimeISO('UTC'));
t('calendar', () => typeof Temporal.Calendar);
t('era', () => Temporal.PlainDate.from('2021-01-01').era);
t('plusMonth', () => Temporal.PlainDate.from('2021-+1-01'));
throw new Error(JSON.stringify(r, null, 0));
