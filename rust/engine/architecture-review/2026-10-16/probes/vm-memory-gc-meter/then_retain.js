// Reactions on one pending promise (each then allocates a derived promise).
var p = new Promise(function () {});
var i;
for (i = 0; i < 300000; i++) p.then(undefined);
throw new Error("completed " + i);
