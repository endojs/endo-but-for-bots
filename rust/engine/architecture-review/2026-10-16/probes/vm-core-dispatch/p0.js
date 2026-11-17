var x = 1 + 2; if (x !== 3) throw new Error("bad"); throw new Error(JSON.stringify([x, typeof globalThis]));
