let r; try { r = new Array(63000).fill(0).length; } catch (e) { r = 'caught ' + e; } throw new Error('fill 63000: ' + r);
