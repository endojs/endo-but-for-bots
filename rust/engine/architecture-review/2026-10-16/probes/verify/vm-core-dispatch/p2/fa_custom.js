var it = { [Symbol.iterator]() { var i = 0; return { next() { return { value: i, done: i++ > 1 }; } }; } };
(async function () { try { for await (var x of it) {} } catch (e) { (function r() { r(); })(); } })();
