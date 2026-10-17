const a = []; for (let i = 0; i < 200000; i++) a.push(i);
for (let i = 0; i < 200; i++) a.splice(a.length - 1, 1);
throw new Error(JSON.stringify([a.length]));
