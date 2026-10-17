(function () { const u = []; for (let i = 0; i < 1024; i++) u.push(0); let s = 0; for (let i = 0; i < 200000; i++) s += u[i & 1023]; })();
