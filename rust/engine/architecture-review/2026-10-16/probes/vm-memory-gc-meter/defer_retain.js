// Grow an uncharged Rust Vec<DisposalRecord> without allocating slots.
var s = new DisposableStack(); var f = function () {};
var i;
for (i = 0; i < 3000000; i++) s.defer(f);
throw new Error("completed " + i);
