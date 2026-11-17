let r; try { r = new Array(60000).fill(0).length; } catch (e) { r = 'caught ' + e; } throw new Error('fill 60000: ' + r);
