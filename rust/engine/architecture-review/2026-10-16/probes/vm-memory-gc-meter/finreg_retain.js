// Grow an uncharged Vec<cell> on one FinalizationRegistry without allocating slots.
var r = new FinalizationRegistry(function () {}); var t = {};
var i;
for (i = 0; i < 3000000; i++) r.register(t, 1);
throw new Error("completed " + i);
