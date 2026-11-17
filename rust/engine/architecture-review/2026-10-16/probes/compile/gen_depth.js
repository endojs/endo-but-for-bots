// Generate recursion-depth probes for the ironhorse compiler.
// Usage: node gen_depth.js <outdir>
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const r = (s, n) => s.repeat(n);
const cases = {
  parens91: `var x = ${r('(', 91)}1${r(')', 91)};`,
  parens92: `var x = ${r('(', 92)}1${r(')', 92)};`,
  parens100k: `var x = ${r('(', 100000)}1${r(')', 100000)};`,
  arrays100k: `var x = ${r('[', 100000)}${r(']', 100000)};`,
  objects100k: `var x = ${r('{a:', 100000)}1${r('}', 100000)};`,
  plus2047: `var a = 1; var x = a${r('+a', 2046)};`,
  plus2100: `var a = 1; var x = a${r('+a', 2100)};`,
  plus100k: `var a = 1; var x = a${r('+a', 100000)};`,
  strcat3000: `var x = "a"${r('+"a"', 3000)}; if (x.length !== 3001) throw new Error("len");`,
  elseif3000: `var v = 2999, r = -1; ${Array.from({length: 3000}, (_, i) => `if (v === ${i}) r = ${i};`).join(' else ')} if (r !== 2999) throw new Error("r");`,
  member3000: `var o = {}; o${r('.a', 3000)};`.replace(/;$/, '') + '\n',
  callchain1500: `function f(){return f}; f${r('()', 1500)};`,
  template100k: `var x = ${r('`${', 100000)}1${r('}`', 100000)};`,
  arrows100k: `var f = ${r('x=>', 100000)}1;`,
  blocks100k: `${r('{', 100000)}${r('}', 100000)}`,
  not100k: `var x = ${r('!', 100000)}1;`,
  not1000: `var x = ${r('!', 1000)}1;`,
  assign100k: `var a; ${r('a=', 100000)}1;`,
  assign1000: `var a; ${r('a=', 1000)}1;`,
  cond1000: `var a = ${r('0?0:', 1000)}1;`,
  exp1000: `var a = ${r('1**', 1000)}1;`,
  new100k: `${r('new ', 100000)}Object;`,
  funcs100k: `${r('function f(){', 100000)}${r('}', 100000)}`,
  classext100k: `var C = ${r('class extends ', 100000)}Object${r('{}', 100000)};`,
  ifnest100k: `${r('if (1) ', 100000)};`,
  tagged3000: `function t(){return t}; t${r('``', 3000)};`,
  optchain3000: `var o = null; o${r('?.a', 3000)};`,
  coalesce3000: `var a = null; a${r('??a', 3000)};`,
  comma100k: `var a = 0; a${r(',a', 100000)};`,
  destr100k: `var ${r('[', 100000)}a${r(']', 100000)} = 1;`,
  destrassign: `var a; ${r('[', 100000)}a${r(']', 100000)} = [];`,
  // eval / Function on generated deep sources must give a catchable SyntaxError
  evalParens: `var ok = false; try { eval("(".repeat(100000) + "1" + ")".repeat(100000)); } catch (e) { ok = e instanceof SyntaxError; if (!ok) throw e; } if (!ok) throw new Error("no throw");`,
  evalPlus: `var a = 1; var ok = false; try { eval("a" + "+a".repeat(100000)); } catch (e) { ok = e instanceof SyntaxError; if (!ok) throw e; } if (!ok) throw new Error("no throw");`,
  evalNot: `var ok = false; try { eval("!".repeat(100000) + "1"); } catch (e) { ok = e instanceof SyntaxError; if (!ok) throw e; } if (!ok) throw new Error("no throw");`,
  FunctionBlocks: `var ok = false; try { Function("{".repeat(100000) + "}".repeat(100000)); } catch (e) { ok = e instanceof SyntaxError; if (!ok) throw e; } if (!ok) throw new Error("no throw");`,
  evalTemplate: `var ok = false; try { eval("\`\${".repeat(100000) + "1" + "}\`".repeat(100000)); } catch (e) { ok = e instanceof SyntaxError; if (!ok) throw e; } if (!ok) throw new Error("no throw");`,
  // nested eval: eval inside eval inside eval
  evalNested: `var s = "1"; for (var i = 0; i < 200; i++) s = "eval(" + JSON.stringify(s) + ")"; var v = eval(s); if (v !== 1) throw new Error(String(v));`,
};
for (const [name, src] of Object.entries(cases)) {
  fs.writeFileSync(path.join(out, name + '.js'), src);
}
console.log(Object.keys(cases).join('\n'));
