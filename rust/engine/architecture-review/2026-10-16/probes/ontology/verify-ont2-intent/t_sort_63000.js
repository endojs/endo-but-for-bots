const a=[]; for (let i=0;i<63000;i++) a.push(63000-i); let r; try { r = a.sort((x,y)=>x-y)[0]; } catch (e) { r = 'caught ' + e; } throw new Error('dense sort 63000: ' + r);
