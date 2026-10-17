// Node + SES shim, booted the way packages/thixotrope/scripts/bundle-ironhorse-worker.mjs boots the worker.
import '/home/user/endo-but-for-bots/packages/ses/index.js';
const cases = `
var out = {};
try { class A { #x = 7; m() { return eval('this.#x'); } } out.priv = new A().m(); } catch (e) { out.priv = String(e); }
try { class P { get v() { return 5; } } class C extends P { m() { return eval('super.v'); } } out.sup = new C().m(); } catch (e) { out.sup = String(e); }
try { function F() { return eval('new.target') === F; } out.nt = new F() instanceof F ? 'object' : 'other'; } catch (e) { out.nt = String(e); }
try { out.plain = eval('1+2'); } catch (e) { out.plain = String(e); }
JSON.stringify(out)`;
const report = {};
const run = (k, f) => { try { report[k] = f(); } catch (e) { report[k] = 'THROWS ' + String(e).split('\n')[0]; } };
const intrinsicEval = globalThis.eval;
// 1. Before lockdown: raw %eval% (the finding's scenario; also what the worker sees with no boot files)
run('preLockdownStart', () => (0, eval)(cases));
lockdown({ errorTaming: 'safe', reporting: 'none', overrideTaming: 'min' });
run('startEvalStillIntrinsicAfterLockdown', () => globalThis.eval === intrinsicEval);
// 2. After lockdown, start compartment (where the worker's host-fixed crank source runs)
run('postLockdownStart', () => (0, globalThis.eval)(cases));
// 3. Guest code: worker-peer.js evaluates guest source with compartment.evaluate
const c = new Compartment();
run('compartment', () => c.evaluate(cases));
// 3b. Evade the eval( textual rejection: eval  via a computed alias is never direct anyway
run('compartmentAliasPriv', () => c.evaluate("const ev = globalThis.eval; class A { #x = 7; m() { return ev('this.#x'); } } new A().m()"));
run('compartmentEvalIsIntrinsic', () => c.evaluate('globalThis.eval') === intrinsicEval);
// 4. Residual: top-level new.target / #x / super in compartment source (SES wrapper's own direct eval)
for (const [k, src] of Object.entries({ topNewTarget: 'typeof new.target', topPriv: 'this.#x', topSuper: 'super.x' })) {
  run(k, () => String(c.evaluate(src)));
}
console.log(JSON.stringify(report, null, 1));
