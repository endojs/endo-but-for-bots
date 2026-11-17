const a = []; a.length = 2 ** 25; a[0] = 2; a[1] = 1;
const r = a.toReversed();
throw new Error(JSON.stringify([r.length]));
