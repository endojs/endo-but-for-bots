const x = 2n ** 1000000n;
throw new Error(String(x.toString(16).length));
