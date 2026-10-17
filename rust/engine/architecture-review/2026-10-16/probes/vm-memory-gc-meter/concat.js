var s = ''; var i;
for (i = 0; i < 100000; i++) { s += 'x'; }
throw new Error("completed " + s.length);
