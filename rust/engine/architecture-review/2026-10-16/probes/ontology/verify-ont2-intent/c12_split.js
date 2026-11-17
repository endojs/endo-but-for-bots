let r; try { r = 'a'.repeat(70000).split('').length; } catch (e) { r = 'caught ' + e; } throw new Error(String(r));
