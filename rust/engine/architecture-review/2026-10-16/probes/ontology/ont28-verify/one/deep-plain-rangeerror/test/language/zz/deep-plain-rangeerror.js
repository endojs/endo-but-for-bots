/*---
description: unbounded plain recursion, expected to end in a RangeError-class stack exhaustion
flags: [raw]
negative:
  phase: runtime
  type: RangeError
---*/
function nest() { nest(); }
nest();
