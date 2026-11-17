var s = 'x'.repeat(100000); var t = 'x'.repeat(100000); var c = 0;
for (var i = 0; i < 22000; i++) { if (s < t) c++; if (s === t) c++; }
throw new Error(JSON.stringify([c]));
