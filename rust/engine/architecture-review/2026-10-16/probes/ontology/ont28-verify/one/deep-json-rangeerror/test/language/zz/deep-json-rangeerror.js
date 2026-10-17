/*---
description: deep JSON.parse nesting (light frames) against a RangeError negative
flags: [raw]
negative:
  phase: runtime
  type: RangeError
---*/
JSON.parse("[".repeat(100000) + "]".repeat(100000));
