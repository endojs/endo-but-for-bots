const a = []; for (let i = 0; i < 5000; i++) a.push(i);
for (let i = 0; i < 5000; i++) a.splice(a.length - 1, 1);
