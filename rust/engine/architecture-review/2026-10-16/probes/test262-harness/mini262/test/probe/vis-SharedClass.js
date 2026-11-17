/*---
description: harness-include binding visibility
includes: [lexinc.js]
flags: [noStrict]
---*/
if (typeof SharedClass === "undefined") throw new Error("not visible");
