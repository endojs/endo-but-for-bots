// Feature / early-error probes. Each file throws on a wrong outcome.
// `ok(src)` expects src to compile+run; `bad(src)` expects a SyntaxError
// from eval (so the probe itself always parses).
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const prelude = `
function bad(src) {
  try { (0, eval)(src); } catch (e) { if (e instanceof SyntaxError) return; throw new Error("wrong error " + e.name + ": " + e.message); }
  throw new Error("accepted invalid source: " + src);
}
function ok(src) { return (0, eval)(src); }
function eq(a, b, what) { if (a !== b) throw new Error((what || "") + " got " + String(a) + " want " + String(b)); }
`;
const cases = {
  // --- refusals / skipped features ---
  static_block_let: `class C { static { let x = 1; C.y = x; } } eq(C.y, 1);`,
  static_block_const: `class C { static { const x = 2; C.y = x; } } eq(C.y, 2);`,
  static_block_var: `class C { static { var x = 3; C.y = x; } } eq(C.y, 3);`,
  static_block_fn: `class C { static { function f(){ return 4; } C.y = f(); } } eq(C.y, 4);`,
  static_block_class: `class C { static { class D {} C.y = typeof D; } } eq(C.y, "function");`,
  static_block_plain: `class C { static { C.y = 5; } } eq(C.y, 5);`,
  static_block_nested_block_let: `class C { static { { let x = 6; C.y = x; } } } eq(C.y, 6);`,
  using_decl: `var log = []; { using r = { [Symbol.dispose]() { log.push("d"); } }; log.push("b"); } eq(log.join(), "b,d");`,
  await_using: `var log = []; async function f(){ { await using r = { [Symbol.asyncDispose]() { log.push("d"); } }; log.push("b"); } } f(); `,
  module_namespace_string_export_eval: `bad("export { x as 'a b' }"); /* script goal: must be SyntaxError anyway */`,
  annexb_labeled_function: `ok("l: function f(){}");`,
  annexb_if_function: `ok("if (true) function g(){}"); `,
  annexb_if_else_function: `ok("if (false) ; else function h(){}");`,
  annexb_html_open_comment: `eq(ok("var x = 1; <!-- comment\\n x"), 1);`,
  annexb_html_close_comment: `eq(ok("var x = 2;\\n--> comment\\n x"), 2);`,
  hashbang_eval: `eq(ok("#!/usr/bin/env node\\n7"), 7);`,
  hashbang_function_body: `try { Function("#!x\\n"); throw new Error("accepted"); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }`,
  regexp_modifiers: `eq(/(?i:a)b/.test("Ab"), true, "modifiers");`,
  regexp_v_flag: `eq(/[\\p{L}--[a-z]]/v.test("A"), true, "v");`,
  regexp_dup_named_groups: `eq(/(?<y>a)|(?<y>b)/.exec("b").groups.y, "b", "dup");`,
  // --- lexer numeric/escape correctness ---
  hex_rounding: `eq(0x200000000000011, 144115188075855904, "hex double rounding");`,
  hex_rounding2: `eq(0x1fffffffffffff01, 2305843009213693952, "hex");`,
  octal_rounding: `eq(0o10000000000000000041, 1152921504606846976, "octal");`,
  binary_rounding: `eq(0b100000000000000000000000000000000000000000000000000001001, 144115188075855880, "binary");`,
  legacy_decimal_fraction: `eq(ok("08.5"), 8.5, "08.5");`,
  legacy_decimal_exp: `eq(ok("09e1"), 90, "09e1");`,
  legacy_decimal_big: `eq(ok("0999999999999999999999"), 999999999999999999999, "legacy big");`,
  ident_escape_wrap: `bad("var \\\\u{100000041} = 1;");`,
  ident_escape_wrap2: `bad("var a\\\\u{100000062} = 1;");`,
  ident_escape_toolarge: `bad("var \\\\u{110000} = 1;");`,
  // --- early errors ---
  getter_with_param: `bad("({ get x(a) {} })");`,
  setter_no_param: `bad("({ set x() {} })");`,
  setter_rest_param: `bad("({ set x(...a) {} })");`,
  setter_two_params: `bad("({ set x(a, b) {} })");`,
  class_getter_with_param: `bad("(class { get x(a) {} })");`,
  for_async_of: `bad("for (async of []) ;");`,
  dup_arrow_params: `bad("(a, a) => 1");`,
  dup_params_nonsimple: `bad("function f(a, [a]) {}");`,
  dup_params_strict: `bad("'use strict'; function f(a, a) {}");`,
  optional_chain_assign: `bad("var a; a?.b = 1");`,
  new_target_top: `bad("new.target");`,
  lexical_dup_var: `bad("let a; var a;");`,
  catch_param_redeclare: `bad("try {} catch (e) { let e; }");`,
  label_dup: `bad("a: a: ;");`,
  break_undefined_label: `bad("while (0) break b;");`,
  continue_non_loop_label: `bad("a: { while (0) continue a; }");`,
  regex_flags_dup: `bad("/a/gg");`,
  yield_in_gen_param: `bad("function* g(a = yield) {}");`,
  await_in_async_arrow_param: `bad("async (a = await 1) => 1");`,
  class_dup_private: `bad("(class { #a; #a; })");`,
  class_undeclared_private: `bad("(class { m() { this.#b; } })");`,
  delete_private: `bad("(class { #a; m() { delete this.#a; } })");`,
  super_call_base: `bad("(class { constructor() { super(); } })");`,
  arguments_in_field: `bad("(class { a = arguments; })");`,
  use_strict_nonsimple: `bad("function f(a = 1) { 'use strict'; }");`,
  octal_in_strict: `bad("'use strict'; 010");`,
  octal_escape_strict: `bad("'use strict'; '\\\\01'");`,
  template_octal: `bad("\`\\\\01\`");`,
  let_let: `bad("let let = 1;");`,
  strict_reserved: `bad("'use strict'; var implements;");`,
  async_gen_await_name: `bad("async function* g() { var await; }");`,
  regexp_literal_invalid: `bad("/(?<a>x)(?<a>y)/");`,
  escaped_keyword_ident: `bad("var v\\\\u0061r = 1;");`,
  // --- semantics touching the compiler ---
  fn_tostring: `eq((function f(a){ return a+1 }).toString(), "function f(a){ return a+1 }", "toString");`,
  method_tostring: `eq(({ m(b) { return 2 } }).m.toString(), "m(b) { return 2 }", "method toString");`,
  arrow_tostring: `eq(((a) => a * 2).toString(), "(a) => a * 2", "arrow toString");`,
  class_tostring: `eq((class A { x = 1 }).toString(), "class A { x = 1 }", "class toString");`,
  numeric_key_canonical: `eq(Object.keys({ 1e21: 1, 0.0000001: 2, 1.5: 3, 0x10: 4 }).join(), "16,1e+21,1e-7,1.5", "keys");`,
  string_key_index: `eq(Object.keys({ "1": 1, "01": 2, "4294967295": 3, "4294967294": 4 }).join(), "1,4294967294,01,4294967295", "string keys");`,
  proto_dup: `bad("({ __proto__: 1, __proto__: 2 })");`,
  proto_dup_shorthand_ok: `ok("var __proto__ = 1; ({ __proto__, __proto__: 2 })");`,
  proto_dup_in_pattern_ok: `ok("var a; ({ __proto__: a, __proto__: a } = {})");`,
  for_in_head_var_init: `ok("for (var i = 0 in {}) ;");`,
  async_arrow_newline: `bad("async\\n() => 1");`,
  class_static_prototype_method: `bad("(class { static prototype() {} })");`,
  class_field_named_constructor: `bad("(class { constructor = 1 })");`,
  import_meta_script: `bad("import.meta");`,
  dynamic_import_options: `ok("typeof import('x', { with: {} })");`,
  ternary_in_for_init: `ok("for (var i = 0 ? 1 : 2 in {}; false;) ;");`.replace('ok', 'bad'),
};
for (const [name, src] of Object.entries(cases)) {
  fs.writeFileSync(path.join(out, name + '.js'), prelude + src + '\n');
}
console.log(Object.keys(cases).length);
