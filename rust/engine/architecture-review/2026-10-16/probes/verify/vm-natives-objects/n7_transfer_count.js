let b = new ArrayBuffer(4 << 20);
globalThis.n = 0;
for (let i = 0; i < 200; i++) { b = b.transfer(); globalThis.n = i + 1; }
