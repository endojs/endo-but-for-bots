let r; try { const a = []; for (let i=0;i<70000;i++) a.push(70000-i); r = a.toSorted((x,y)=>x-y)[0]; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
