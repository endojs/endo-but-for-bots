// The direct eval SES performs for every safe evaluation after lockdown
// (packages/ses/src/make-evaluate.js:91-104), reduced: a strict, non-method
// function expression whose body is `return eval(arguments[0])`.
var evaluate = Function(`
  with ({}) {
    return function() {
      'use strict';
      return eval(arguments[0]);
    };
  }
`)();
var tamedEval = function (src) { return evaluate.call(globalThis, src); };
var out = {};
var cases = {
  topNewTarget: 'typeof new.target',
  topPriv: 'this.#x',
  topSuper: 'super.x',
  plain: '1+2',
};
for (var k in cases) {
  try { out[k] = String(tamedEval(cases[k])); } catch (e) { out[k] = String(e); }
}
// The finding's scenarios, as guest code can actually reach them after lockdown:
// `eval` is the tamed evaluator, so the enclosing class/function is not the eval's context.
try { class A { #x = 7; m() { return tamedEval('this.#x'); } } out.priv = String(new A().m()); } catch (e) { out.priv = String(e); }
try { class P { get v() { return 5; } } class C extends P { m() { return tamedEval('super.v'); } } out.sup = String(new C().m()); } catch (e) { out.sup = String(e); }
try { function F() { return tamedEval('typeof new.target'); } var f = { r: undefined }; function G() { f.r = tamedEval('typeof new.target'); } new G(); out.nt = String(f.r); } catch (e) { out.nt = String(e); }
