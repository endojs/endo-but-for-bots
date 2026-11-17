let v = 1; for (let i = 0; i < 3000; i++) v = [v];
try { throw new Error('len ' + JSON.stringify(v).length); } catch (e) { throw new Error('caught ' + e.message); }
