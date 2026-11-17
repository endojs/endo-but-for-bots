// Object-dominated: a linked list of N two-property objects, three slots each
// (the instance and its two properties) and nothing in any side table.
var head = null;
for (var i = 0; i < __N__; i++) head = { next: head, value: i };
head.value + 1
