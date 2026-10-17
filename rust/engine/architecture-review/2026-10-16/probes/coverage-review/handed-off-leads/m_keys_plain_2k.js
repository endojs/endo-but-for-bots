var o = {a: 1, b: 2}; var n = 0; for (var i = 0; i < 2000; i++) n += Object.keys(o).length; if (n !== 4000) throw new Error(String(n));
