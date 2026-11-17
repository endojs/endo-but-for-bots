const keys = []; for (let i = 0; i < 20000; i++) keys.push({});
const wm = new Map(); for (const k of keys) wm.set(k, 1);
for (const k of keys) wm.delete(k);
