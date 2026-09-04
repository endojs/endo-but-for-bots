// Module byte-identity corpus: import forms (stage-5 modules child).
// One or more whole MODULE programs per file, separated by a line that is
// exactly `// ---`. Held to byte-identical module bytecode against the
// XS oracle module-compile entry (xs_oracle::compile_module).

// default import
import x from "m";
// ---
// named import
import { a } from "m";
// ---
// named import with rename
import { a as b } from "m";
// ---
// multiple named imports
import { a, b, c } from "m";
// ---
// namespace import
import * as ns from "m";
// ---
// default + named
import def, { a, b as c } from "m";
// ---
// default + namespace
import def, * as ns from "m";
// ---
// bare side-effect import
import "side-effect";
// ---
// import then use the binding (live binding access)
import { f } from "m";
f();
// ---
// default import member access
import def from "m";
def.method();
