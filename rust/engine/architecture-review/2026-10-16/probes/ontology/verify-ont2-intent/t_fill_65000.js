let r; try { r = new Array(65000).fill(0).length; } catch (e) { r = 'caught ' + e; } throw new Error('fill 65000: ' + r);
