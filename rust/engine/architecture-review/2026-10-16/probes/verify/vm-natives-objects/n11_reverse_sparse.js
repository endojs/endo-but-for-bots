const a = []; a.length = 2 ** 25; a[0] = 2; a[1] = 1;
let r; try { a.reverse(); r = [a[2 ** 25 - 1], 0 in a]; } catch (e) { r = e.name; }
throw new Error(JSON.stringify(r));
