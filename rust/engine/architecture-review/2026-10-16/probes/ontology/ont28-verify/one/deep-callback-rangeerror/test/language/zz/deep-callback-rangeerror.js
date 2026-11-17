/*---
description: unbounded callback recursion, expected to end in a RangeError-class stack exhaustion
flags: [raw]
negative:
  phase: runtime
  type: RangeError
---*/
function nest() { [0].forEach(nest); }
nest();
