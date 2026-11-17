const u = new Uint8Array(1024); let s = 0; for (let i = 0; i < 2000000; i++) s += u[i & 1023];
