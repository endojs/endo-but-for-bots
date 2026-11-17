(function () { const u = new Array(1024).fill(0); for (let i = 0; i < 200000; i++) u[i & 1023] = i; })();
