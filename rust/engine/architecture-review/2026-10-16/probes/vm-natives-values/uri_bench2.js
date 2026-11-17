let n = 0; for (let i = 0; i < 200000; i++) { n += ('%' + (i & 255).toString(16).toUpperCase()).length; } throw new Error(String(n));
