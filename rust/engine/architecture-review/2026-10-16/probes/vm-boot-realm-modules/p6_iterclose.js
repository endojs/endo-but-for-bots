// for-of `break` performs IteratorClose, which reads the iterator's `return`.
// The program never spells that property name.
var log = [];
function* g() { try { yield 1; yield 2; } finally { log.push("closed"); } }
for (var x of g()) break;
var arr = [];
var it = arr[Symbol.iterator]();
var proto = Object.getPrototypeOf(Object.getPrototypeOf(it)); // %IteratorPrototype%
var [a] = g();                                                  // destructuring also closes
throw new Error(JSON.stringify(log));
