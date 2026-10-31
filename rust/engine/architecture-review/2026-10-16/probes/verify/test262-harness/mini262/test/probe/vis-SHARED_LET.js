/*---
description: harness-include binding visibility
includes: [lexinc.js]
flags: [noStrict]
---*/
if (typeof SHARED_LET === "undefined") throw new Error("not visible");
