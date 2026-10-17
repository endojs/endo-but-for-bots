var s = 'x'.repeat(4000000); var t = 'x'.repeat(4000000); var c = 0;
for (var i = 0; i < 2000; i++) { if (s < t) c++; }
throw new Error(JSON.stringify([c]));
