const x = 10n ** 100000n;
throw new Error(String(x.toString().length));
