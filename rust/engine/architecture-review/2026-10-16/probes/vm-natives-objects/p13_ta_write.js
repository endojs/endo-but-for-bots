const u = new Uint8Array(1024); for (let i = 0; i < 2000000; i++) u[i & 1023] = i;
