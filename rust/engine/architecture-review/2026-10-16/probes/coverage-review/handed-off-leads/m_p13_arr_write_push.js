const u = []; for (let i = 0; i < 1024; i++) u.push(0); for (let i = 0; i < 2000000; i++) u[i & 1023] = i;
