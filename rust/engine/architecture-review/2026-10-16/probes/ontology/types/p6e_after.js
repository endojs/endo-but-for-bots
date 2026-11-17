var o = {};
try { for (var i = 0; i < 70000; i++) o['k' + i] = i; } catch (e) {}
var r = [];
try { var s = Symbol('z'); var p = {}; p[s] = 1; r.push('symkey ok'); } catch (e) { r.push('symkey ' + e.name); }
try { var q = {}; q.alreadyInterned = 1; r.push('static ok'); } catch (e) { r.push('static ' + e.name); }
try { var w = JSON.parse('{"freshJsonKey":1}'); r.push('json ok'); } catch (e) { r.push('json ' + e.name); }
try { var m = new Map(); m.set('x', 1); r.push('map ok'); } catch (e) { r.push('map ' + e.name); }
try { class C { #priv = 1; } new C(); r.push('class ok'); } catch (e) { r.push('class ' + e.name); }
throw new Error(r.join('; '));
