// A vat-like mix: N records in a Map keyed by string ids, each an object with a
// short string, a number and a three-element array, so every arena and side
// table grows together.
var db = new Map();
for (var i = 0; i < __N__; i++) {
  var id = 'user-' + i;
  db.set(id, {
    id: id,
    name: 'name ' + i + ' ' + 'x'.repeat(i % 64),
    score: i * 1.5,
    tags: [i % 7, i % 11, 'tag' + (i % 13)],
  });
}
db.size
