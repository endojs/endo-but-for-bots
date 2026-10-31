const r = [];
const T = (f) => { try { r.push(String(f())); } catch (e) { r.push(e.name); } };
const P = (s) => T(() => Date.parse(s));
['2020', '2020-02', '2020-02-30', '2020-01-01T00:00', '2020-01-01T24:00', '2020-01-01T24:00:00.001', '2020-01-01T10:00:00.1234', '2020-01-01T10:00:00+05:30',
 '2020-01-01T10:00:00+0530', '2020-01-01T10:00:00+05', '2020-01-01 10:00:00', '2020-01-01T10:00:00.000z', '+002020-01-01', '-000001-01-01T00:00:00Z', '-000000-01-01',
 'Wed, 01 Jan 2020 10:00:00 GMT', 'Wed Jan 01 2020 10:00:00 GMT+0000', 'Wed Jan 01 2020 10:00:00 GMT+0000 (Coordinated Universal Time)', 'Jan 1, 2020', '1/2/2020', '2020/01/02', 'January 1, 2020 10:00 UTC', 'Thu, 01 Jan 1970 00:00:00 GMT+0100', '2020-1-1', '20200101', '2020-01-01T10:00:60', '  2020-01-01  ', '2020-13-01', '2020-00-10', '2020-02-29T12:00:00Z', '2019-02-29', '275760-09-13', '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00Z', '-271821-04-19T23:59:59.999Z', '2020-01-01T10:00:00.000+24:00', '2020-01-01T10:00:00.000Z ', '2020-01-01T1:00Z'].forEach(P);
T(() => new Date(8.64e15).getTime()); T(() => new Date(8.64e15 + 1).getTime()); T(() => new Date(-8.64e15).toISOString());
T(() => new Date(2020, 0).getTime()); T(() => new Date(99, 0).getFullYear()); T(() => Date.UTC(2020)); T(() => Date.UTC());
T(() => new Date(0).toString()); T(() => new Date(0).toUTCString()); T(() => new Date(-62198755200000).toUTCString()); T(() => new Date(-62198755200000).toString());
T(() => new Date(0).toLocaleString()); T(() => new Date(0).toLocaleDateString('de-DE')); T(() => new Date(0).getTimezoneOffset());
T(() => new Date(2020, 0, 1, 0, 0, 0, 0.9).getMilliseconds());
T(() => new Date(1e81).getTime()); T(() => new Date(2016, 1, 29).setFullYear(2017));
T(() => new Date(NaN).setHours(1)); T(() => new Date(0).setMonth(12)); T(() => new Date(0).setUTCDate(-1));
T(() => typeof Date.now()); T(() => Date.now() > 1e12); T(() => new Date().getTime() > 1e12); T(() => typeof Date());
T(() => new Date(2020, 0, 1, 0, 0, 0, 0).valueOf() === Date.UTC(2020, 0, 1));
throw new Error(JSON.stringify(r));
