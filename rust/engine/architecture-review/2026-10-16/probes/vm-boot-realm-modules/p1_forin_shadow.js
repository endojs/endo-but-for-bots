// The program never spells the member name; it reaches it only through data.
Object.keys(Object.prototype);              // completes Object.prototype's surface
var src = JSON.parse('{"to' + 'Fixed":1}'); // interns the name without an install pass
Object.assign(Object.prototype, src);       // enumerable Object.prototype member
var seen = [];
for (var k in Object(1)) seen.push(k);      // Number.prototype member must shadow it
var own = Object.getOwnPropertyNames(Number.prototype).indexOf('to' + 'Fixed') >= 0;
var seen2 = [];
for (var k2 in Object(2)) seen2.push(k2);
throw new Error(JSON.stringify({ seen: seen, ownAfterReflect: own, seenAfterReflect: seen2 }));
