function xsWorkerEval(src) {
  return (0, eval)("globalThis.__e = ''; try {\n" + src + "\n} catch (e) { globalThis.__e = 'ERROR: ' + (e && e.message); }\n0;");
}
xsWorkerEval("'use strict'; undeclared1 = 1; 'ok'");
xsWorkerEval("'use strict'; function h() { return 1; } 'ok'");
JSON.stringify([typeof undeclared1, globalThis.__e, typeof h])
