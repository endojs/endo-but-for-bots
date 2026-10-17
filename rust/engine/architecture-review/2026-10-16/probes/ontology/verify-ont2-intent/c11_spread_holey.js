let r; try { r = [...Array(70000)].length; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
