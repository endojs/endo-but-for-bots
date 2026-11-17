const x = 1n << 60000n;   // 60001 bits, under the 64Ki shift cap
const y = x * x;          // 120001 bits, via multiply (no cap)
const z = y * y;          // 240001 bits
throw new Error("mul bits:" + y.toString(2).length + " " + z.toString(2).length);
