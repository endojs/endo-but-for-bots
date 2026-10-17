var re = /x/; var calls = 0;
re.exec = function () { if (calls++) return null; return { length: 16777218, 0: 'x', index: 0 }; };
var r; try { r = 'x'.replace(re, 'y'); } catch (e) { r = 'caught ' + e.name; }
throw new Error(String(r));
