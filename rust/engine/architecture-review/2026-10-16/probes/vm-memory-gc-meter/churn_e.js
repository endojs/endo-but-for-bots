var last; var i;
for (i = 0; i < 1000000; i++) { last = {}; }
throw new Error("completed " + i);
