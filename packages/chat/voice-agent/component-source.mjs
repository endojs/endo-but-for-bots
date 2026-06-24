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
// The fix is to validate the source the EXACT way the frame consumes it: wrap it as `(<source>)`,
// PARSE+evaluate just that outer expression (which does NOT run the component body — an arrow's body
// only runs when called), and require the result to be a function. This makes the server's accept-set
// IDENTICAL to the frame's, so a source that passes here can never produce that mount error.

// Validate a confined-component source string.
// Returns { ok:true, fn } if `(<source>)` evaluates to a function (mirroring public/confined.html mount),
// or { ok:false, error } with a precise reason otherwise. `maxLen` (default 8000) bounds size like before.
export const validateComponentSource = (source, { maxLen = 8000 } = {}) => {
  const src = String(source == null ? '' : source);
  if (!src.trim()) return { ok: false, error: 'source must be a function: (ui) => ui.create(...)' };
  if (src.length > maxLen) return { ok: false, error: `component source too long (keep it under ${maxLen} chars)` };
  let fn;
  try {
    // `return (<source>)` — the SAME wrapping the confined frame uses (it injects `(' + source + ')`).
    // Evaluating this returns the arrow/function VALUE; it does NOT invoke the body (no call site), so it
    // is as safe as shipping the text to the sandbox already is, and it catches BOTH parse errors and
    // not-a-function results that the old regex let slip through to the live mount error.
    // eslint-disable-next-line no-new-func
    fn = new Function(`return (${src}\n);`)();
  } catch (e) {
    return { ok: false, error: `source failed to parse — it must be a function (ui) => ui.create(...): ${(e && e.message) || e}` };
  }
  if (typeof fn !== 'function') {
    return { ok: false, error: 'source must be a function: (ui) => ui.create(...)' };
  }
  return { ok: true, fn };
};

export default validateComponentSource;
