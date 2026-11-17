let r; try { r = new Array(50000).fill(0).length; } catch (e) { r = 'caught ' + e; } throw new Error('fill 50000: ' + r);
