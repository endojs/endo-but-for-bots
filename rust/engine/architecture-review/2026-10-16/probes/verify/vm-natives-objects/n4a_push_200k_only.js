const a = []; for (let i = 0; i < 200000; i++) a.push(i);
throw new Error(JSON.stringify([a.length]));
