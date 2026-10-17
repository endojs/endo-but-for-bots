let r; try { r = new Array(64400).fill(0).length; } catch (e) { r = 'caught ' + e; } throw new Error('fill 64400: ' + r);
