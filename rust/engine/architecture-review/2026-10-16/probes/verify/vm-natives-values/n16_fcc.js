const r = [2 ** 63, 2 ** 64 + 2 ** 20, -(2 ** 63) - 2 ** 12, 1e300, 65537, -1].map(n => String.fromCharCode(n).charCodeAt(0));
throw new Error(JSON.stringify(r));
