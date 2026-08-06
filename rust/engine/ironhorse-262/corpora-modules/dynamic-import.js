// Module byte-identity corpus: dynamic `import(...)` and `import.meta`
// (stage-5 fix2, import()/import.meta coders). Whole MODULE programs
// separated by a line that is exactly `// ---`.

// dynamic import of a string specifier as a statement
import("mod");
// ---
// dynamic import whose result is chained
import("mod").then(f);
// ---
// dynamic import bound to a declaration
const p = import("mod");
// ---
// dynamic import of a computed specifier expression
import("pre" + "fix");
// ---
// dynamic import with an options (import-attributes) argument
import("mod", { with: { type: "json" } });
// ---
// dynamic import inside an async function, awaited
async function load() { return await import("mod"); }
// ---
// import.meta as a statement
import.meta;
// ---
// a member access off import.meta
import.meta.url;
// ---
// import.meta bound to a declaration
const meta = import.meta;
// ---
// import.meta and a dynamic import together
const here = import.meta.url;
import(here);
