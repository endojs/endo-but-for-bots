let r; try { const a = []; for (let i=0;i<70000;i++) a.push(i); delete a[5]; r = a.fill(0)[69999]; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
