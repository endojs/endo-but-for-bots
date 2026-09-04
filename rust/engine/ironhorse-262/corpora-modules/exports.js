// Module byte-identity corpus: export forms (stage-5 modules child).
// Whole MODULE programs separated by `// ---`.

// export a const declaration
export const x = 1;
// ---
// export a let declaration
export let y = 2;
// ---
// export a var declaration
export var v = 5;
// ---
// export multiple declarators
export const a = 1, b = 2, c = 3;
// ---
// export a named binding list
let x = 1;
export { x };
// ---
// export with rename
let x = 1;
export { x as y };
// ---
// export list before the declarations (hoisted binding)
export { a, b };
let a = 1;
let b = 2;
// ---
// export a function declaration
export function f() {}
// ---
// export a class declaration
export class C {}
// ---
// two exported functions
export function a() {}
export function b() {}
// ---
// export as the default name
const x = 1;
export { x as default };
