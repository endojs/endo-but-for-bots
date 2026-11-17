var out = [];
function* g() { yield 1; yield 2; }
var gi = g(); var a = gi.next(), b = gi.next(); out.push('gen same:' + (a === b) + ' a.value:' + a.value);
var si = 'ab'[Symbol.iterator](); var c = si.next(), d = si.next(); out.push('str same:' + (c === d) + ' c.value:' + c.value);
var ri = 'a1b2'.matchAll(/\d/g); var e = ri.next(), f = ri.next(); out.push('regexp same:' + (e === f));
var oi = Object.entries({x:1,y:2})[Symbol.iterator](); var h = oi.next(), k = oi.next(); out.push('entries same:' + (h === k) + ' h.value:' + h.value);
var a2 = [10, 20]; var arr = []; var it = a2.values(); for (var r = it.next(); !r.done; r = it.next()) arr.push(r); out.push('collected:' + arr.map(function (x) { return x.value; }).join());
throw new Error(out.join(' | '));
