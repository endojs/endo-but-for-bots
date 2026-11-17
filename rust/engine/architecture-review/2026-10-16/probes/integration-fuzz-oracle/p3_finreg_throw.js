var fr = new FinalizationRegistry(function () { throw new Error("cleanup"); });
(function () { fr.register({}, 1); })();
var junk;
for (var i = 0; i < 200000; i++) junk = { i: i };
"done";
