let r; try { const a = new Array(70000); for (let i=0;i<70000;i++) a[i]=0; r = a.fill(1)[69999]; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
