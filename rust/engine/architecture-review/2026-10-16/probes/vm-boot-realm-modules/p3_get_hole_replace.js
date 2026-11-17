// [[Get]] of an intrinsic member whose name enters the table at run time
// through GetSubstitution's `$<name>`: no install pass runs before the read.
var re = /a/;
re.exec = function () { var r = ["a"]; r.index = 0; r.groups = Object(1); return r; };
var out = "a".replace(re, "[$<to" + "Fixed>]");
var again = typeof Number.prototype["to" + "Fixed"];
throw new Error(JSON.stringify({ out: out.slice(0, 20), afterComputedRead: again }));
