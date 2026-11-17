const u = new Array(1024).fill(0); let s = 0; for (let i = 0; i < 2000000; i++) s += u[i & 1023];
