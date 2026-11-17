var E = (0, eval)('(function (a) { this.a = a; })');
var BE = E.bind(null, 'q');
var r;
try { r = new BE().a; } catch (e) { r = 'caught ' + e; }
throw new Error(String(r));
