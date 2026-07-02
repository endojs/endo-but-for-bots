// component-source.mjs — the SINGLE source-of-truth validator for a confined UI-component source
// (the `(ui) => ui.create(...)` functions that showComponent / break-out accept and the confined
// frame in public/confined.html renders).
//
// ROOT CAUSE this fixes: the confined frame mounts a component by injecting `(' + source + ')` and
// then requiring `typeof result === 'function'`, failing with the live error
//   "component source must be a function (ui) => element (or it failed to parse)"
// otherwise. The SERVER, however, gated the source with a hand-rolled regex
//   /^\s*\(?\s*[a-zA-Z_$]/  &&  src.includes('=>')
// that DIVERGED from what the frame actually accepts:
//   • it REJECTED perfectly valid arrow functions whose params start with `{`/`[`, e.g.
//       ({ create, island }) => create('div')        // destructured ui
//       ([first]) => create('div')                    // (degenerate but parses to a fn)
//   • it ACCEPTED non-functions / un-parseable text that the frame then choked on, e.g.
//       uiCreate('div')           // an identifier+call, has '=>' nowhere but starts a-z … (no '=>': caught)
//       (ui) => { return ui.create('div')   // missing brace → wraps to a SyntaxError in the frame
//       foo => bar => baz; somethingElse()  // parses but yields a fn only by luck / or a non-fn
//   • `includes('=>')` is satisfied by a `=>` ANYWHERE (e.g. inside a string), not by an actual arrow head.
//
// The fix is to validate the source the EXACT way the frame consumes it — wrap it as `(<source>)` and
// PARSE it — but WITHOUT EVER EXECUTING it. This module runs in the live, root-authority server process,
// and it is reachable from agent-authored source via the showComponent tool (an indirect prompt-injection
// path). The previous implementation invoked the compiled wrapper (`new Function(...)()`), which EVALUATES
// the outer expression in-process at validation time. Evaluating an expression is NOT free: a top-level
// IIFE `(function(){ …evil… })()` or comma-operator payload `(evil(), (ui) => …)` runs `evil()` during
// that evaluation — arbitrary code with ambient Node authority, before the isolated render check ever ran.
//
// Fix: compile-ONLY. `new Function('return (<src>);')` PARSES the source (throwing SyntaxError on invalid
// syntax) but does not run any of it until the compiled function is CALLED — and we never call it. So no
// agent-authored code executes here. Function-ness and mount-safety are decided downstream by the ALREADY
// ISOLATED render-check child (a separate process with shadowed globals and a hard timeout — render-check.mjs),
// which showComponent runs immediately after this gate. The server never executes component source in-process.

// Validate a confined-component source string (SYNTAX-ONLY — never executes the source).
// Returns { ok:true } if `(<source>)` PARSES (mirroring what public/confined.html injects), or
// { ok:false, error } with a precise reason otherwise. `maxLen` (default 16000) bounds size like before.
// NOTE: this no longer confirms the source evaluates to a function — that (and full mount-safety) is the
// job of the isolated render-check child; doing it here would require executing agent code in-process.
export const validateComponentSource = (source, { maxLen = 16000 } = {}) => {
  const src = String(source == null ? '' : source);
  if (!src.trim()) return { ok: false, error: 'source must be a function: (ui) => ui.create(...)' };
  if (src.length > maxLen) return { ok: false, error: `component source too long (keep it under ${maxLen} chars)` };
  try {
    // COMPILE-ONLY: `return (<source>)` is parsed (SyntaxError on bad syntax) but the compiled function is
    // NEVER invoked, so nothing in the source — not even a top-level IIFE / comma-operator side effect —
    // executes in this process. (Contrast the removed `…)()` which DID execute it. Do not re-add the call.)
    // eslint-disable-next-line no-new-func
    new Function(`return (${src}\n);`);
  } catch (e) {
    return { ok: false, error: `source failed to parse — it must be a function (ui) => ui.create(...): ${(e && e.message) || e}` };
  }
  return { ok: true };
};

export default validateComponentSource;
