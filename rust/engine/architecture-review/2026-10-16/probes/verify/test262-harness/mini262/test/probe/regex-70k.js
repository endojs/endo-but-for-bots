/*---
description: greedy quantifier over 70k chars
flags: [noStrict]
---*/
if (!/^a+$/.test('a'.repeat(70000))) throw new Test262Error('no match');
var r = /[\s\S]*/.exec(' '.repeat(200000))[0].length;
if (r !== 200000) throw new Test262Error('len ' + r);
