// The program never spells the member name; JSON.parse interns it, and no
// install pass runs before for-in walks Number.prototype's own keys.
var parsed = JSON.parse('{"to' + 'Fixed":1, "x":2}');
Object.setPrototypeOf(Number.prototype, parsed);
var seen = [];
for (var k in Object(1)) seen.push(k);
throw new Error(JSON.stringify(seen));
