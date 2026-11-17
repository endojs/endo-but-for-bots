// Emulates thixotrope-xs-worker eval_script: indirect eval of `try {\n<src>\n} catch ...\n0;`
function xsWorkerEval(src) {
  return (0, eval)("globalThis.__e = ''; try {\n" + src + "\n} catch (e) { globalThis.__e = 'ERROR: ' + (e && e.message); }\n0;");
}
xsWorkerEval("'use strict'; var counter = 41; function inc() { return ++counter; } 'defined'");
var a = typeof inc === 'function' ? inc() : 'inc missing';
xsWorkerEval("let lex = 5;");
var b; try { b = lex; } catch (e) { b = e.name; }
throw new Error(JSON.stringify([a, b, globalThis.__e]));
