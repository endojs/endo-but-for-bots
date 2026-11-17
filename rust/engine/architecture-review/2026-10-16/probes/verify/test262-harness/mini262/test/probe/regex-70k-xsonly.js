/*---
description: run the 70k/200k greedy regexps only on the engine that lacks Temporal (the XS oracle)
flags: [noStrict]
---*/
var r = typeof Temporal === 'undefined'
  ? (/^a+$/.test('a'.repeat(70000)) && /[\s\S]*/.exec(' '.repeat(200000))[0].length === 200000)
  : true;
if (r !== true) throw new Test262Error('xs ' + r);
