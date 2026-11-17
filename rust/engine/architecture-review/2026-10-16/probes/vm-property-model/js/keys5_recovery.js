// After exhaustion: can we still create a new key? Is it catchable & does the program keep working?
var o = {}; var n = 0, err;
try { for (var i = 0; i < 70000; i++) { o['k' + i] = i; n++; } } catch (e) { err = e; }
var ok = [];
try { var p = {}; p.fresh_never_seen_name_zz = 1; ok.push('newprop ' + p.fresh_never_seen_name_zz); } catch (e) { ok.push('newprop threw ' + e.name); }
try { var q = { alpha: 1 }; ok.push('known ' + q.alpha); } catch (e) { ok.push('known threw ' + e.name); }
try { var e2 = new TypeError('x'); ok.push('error ok ' + e2.message); } catch (e) { ok.push('err threw ' + e.name); }
try { JSON.parse('{"zzz_unseen_1":1}'); ok.push('json ok'); } catch (e) { ok.push('json threw ' + e.name + ' ' + e.message); }
throw new Error(n + ' ' + (err && err.name) + ' | ' + ok.join(' | '));
