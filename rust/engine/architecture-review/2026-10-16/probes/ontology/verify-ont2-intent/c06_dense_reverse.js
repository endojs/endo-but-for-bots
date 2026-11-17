let r; try { const a = []; for (let i=0;i<70000;i++) a.push(i); r = a.reverse()[0]; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
