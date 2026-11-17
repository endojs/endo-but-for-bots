const x = 10n ** 20000n;
throw new Error(String(x.toString().length));
