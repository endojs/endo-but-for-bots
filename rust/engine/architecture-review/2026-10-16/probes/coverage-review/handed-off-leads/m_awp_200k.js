(function () { const u = []; for (let i = 0; i < 1024; i++) u.push(0); for (let i = 0; i < 200000; i++) u[i & 1023] = i; })();
