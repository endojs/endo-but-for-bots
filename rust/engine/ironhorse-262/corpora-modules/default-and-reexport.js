// Module byte-identity corpus: default exports and re-export forms
// (stage-5 modules child). Whole MODULE programs separated by `// ---`.

// default export of an expression
export default 42;
// ---
// default export of an array
export default [1, 2, 3];
// ---
// default export of a named function
export default function foo() {}
// ---
// default export of an anonymous function (named `default`)
export default function () {}
// ---
// default export of an anonymous class (named `default`)
export default class {}
// ---
// default export of a named class
export default class C {}
// ---
// default export of a local, then re-export as default via list
const x = 1;
export default x;
// ---
// re-export a named binding from another module
export { a } from "m";
// ---
// re-export with rename
export { a as b } from "m";
// ---
// re-export all names
export * from "m";
// ---
// re-export the namespace under a name
export * as ns from "m";
// ---
// re-export the default binding
export { default } from "m";
// ---
// re-export a name as the default
export { a as default } from "m";
// ---
// live-binding access: a counter mutated by exported functions
let counter = 0;
export function inc() { counter = counter + 1; }
export function val() { return counter; }
