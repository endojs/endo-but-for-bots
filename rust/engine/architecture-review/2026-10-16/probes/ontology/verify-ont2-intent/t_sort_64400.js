const a=[]; for (let i=0;i<64400;i++) a.push(64400-i); let r; try { r = a.sort((x,y)=>x-y)[0]; } catch (e) { r = 'caught ' + e; } throw new Error('dense sort 64400: ' + r);
