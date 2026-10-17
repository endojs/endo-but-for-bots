const out = {};
try { out.instant = String(Temporal.Now.instant()); } catch (e) { out.instant = 'E:' + e; }
try { out.tz = Temporal.Now.timeZoneId(); } catch (e) { out.tz = 'E:' + e; }
try { out.dateNow = Date.now(); } catch (e) { out.dateNow = 'E:' + e; }
try { out.newDate = new Date().getTime(); } catch (e) { out.newDate = 'E:' + e; }
try { out.tzo = new Date(0).getTimezoneOffset(); } catch (e) { out.tzo = 'E:' + e; }
try { out.dtfTz = new Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { out.dtfTz = 'E:' + e; }
throw new Error(JSON.stringify(out));
