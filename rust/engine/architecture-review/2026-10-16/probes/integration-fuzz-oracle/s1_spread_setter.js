var hits = 0;
Object.defineProperty(Array.prototype, "0", { set: function (v) { hits++; }, configurable: true });
var r = [...[7]];
var out = String(r.hasOwnProperty("0")) + " " + r.length + " hits=" + hits;
delete Array.prototype[0];
out
