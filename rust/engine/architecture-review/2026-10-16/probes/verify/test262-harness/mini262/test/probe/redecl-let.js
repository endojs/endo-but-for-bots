/*---
description: redeclaring an include's top-level let must be a SyntaxError (GlobalDeclarationInstantiation)
includes: [lexinc.js]
negative:
  phase: runtime
  type: SyntaxError
flags: [noStrict]
---*/
let SHARED_LET = 2;
