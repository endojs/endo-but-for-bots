const r = []; const t = Date.UTC(2024, 6, 1, 12);
for (const tz of ['America/New_York', 'Europe/London', 'Australia/Sydney']) {
  r.push(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', timeZoneName: 'short' }).format(tz === 'Australia/Sydney' ? Date.UTC(2024, 0, 1, 12) : t));
}
for (const tz of ['Pacific/Chatham', 'Europe/Kyiv', 'Antarctica/Troll', 'America/Phoenix']) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); r.push(tz + ':ok'); } catch (e) { r.push(tz + ':' + e.name); }
}
if (typeof Temporal !== 'undefined') {
  r.push(Temporal.ZonedDateTime.from('2024-07-01T12:00[America/New_York]').offset);
  try { Temporal.ZonedDateTime.from('2024-07-01T12:00-04:00[America/New_York]'); r.push('summer-offset:ok'); } catch (e) { r.push('summer-offset:' + e.name + ':' + e.message); }
}
throw new Error(JSON.stringify(r));
