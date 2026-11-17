let r; try { r = new Array(70000).map(x=>x).length; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
