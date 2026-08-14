/*---
description: >
  Differential-fuzz regression: an out-of-range numeric backreference in a
  regexp literal is a SyntaxError, not a fall-back to a lower-numbered group.
flags: [raw]
features: [ironhorse-dual-run]
negative:
  phase: parse
  type: SyntaxError
info: |
  Trophy from the `differential_regexp` fuzz arm (ironhorse-fuzz, target 5): the
  regexp matcher differential (`ironhorse_fuzz::regexp`) surfaced that XS reads a
  numeric backreference's decimal digits greedily and REJECTS a reference
  whose number exceeds the capture count (`fxCaptureReferenceMeasure`), rather
  than falling back to `\1`. `/\11/` has one capture group at most, so `\11`
  is out of range and the pattern is a SyntaxError under XS. Ironhorse's matcher
  (`ironhorse-regexp`) matches this accept/reject verdict; the fix is the
  final-capture-count validation pass in `ironhorse-regexp/src/compile.rs`
  ("invalid reference number").

  Regexp-literal SyntaxErrors are parse-phase in XS (the oracle rejects at
  compile), so this case rides the same parse-negative activation as the rest
  of the tree: the runner names it a `negative-parse:pending-compiler` skip
  until `ironhorse-compile` is the default dual-run compiler, then it activates
  and ironhorse's own compiler must reject it exactly. It never diverges.
---*/
/\11/;
