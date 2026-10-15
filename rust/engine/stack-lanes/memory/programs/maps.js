// Map-dominated: N integer entries, charged against the chunk ceiling, 96
// bytes each by capacity class.
var m = new Map();
for (var i = 0; i < __N__; i++) m.set(i, i);
m.size
