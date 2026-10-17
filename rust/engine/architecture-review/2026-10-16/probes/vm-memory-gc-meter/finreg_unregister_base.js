var r = new FinalizationRegistry(function () {}); var t = {}; var tok = {};
var i;
for (i = 0; i < 1000000; i++) r.register(t, 1);
for (i = 0; i < 5000; i++) tok.x = i;
throw new Error("completed " + i);
