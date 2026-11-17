const a = []; for (let i = 0; i < 100000; i++) a.push((i * 7919) % 100003);
a.sort((x, y) => x - y);
