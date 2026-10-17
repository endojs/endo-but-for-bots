var r; try { r = /^a+$/.test('a'.repeat(70000)); } catch (e) { r = 'caught ' + e.name; } throw new Error(String(r));
