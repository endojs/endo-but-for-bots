# Control signals as scope functions, not text markers (`answer()`, not `ANSWER:`)

Status: `answer()`, `ask()`, `blocked()` ALL SHIPPED (2026-06-27, codemode.mjs + codemode-answer.test.mjs).
The agent ends its turn by calling one of them in its program; the kind flows through the server as an
`endKind` + `asking`/`blocked` flag (turn-done log, "needs you" push). `ANSWER:` survives only as a
back-compat fallback. **TOOL_CALL:** in CodeMode tool invocation is already a scope function
(`await tool(args)`); the marker survives only in the legacy `runAgent` (`AGENT_CODEMODE=0`) loop, now
marked superseded. The function-vs-marker difference is codified + measured by a conformance spec suite:
`eval/obstacles/10-control-protocol/` (`yarn test:control-protocol`). The `ANSWER:` marker is now FULLY
RETIRED in CodeMode (2026-06-27): a no-program reply is delivered verbatim, never stripped/parsed, and the
empty-response nudge references only the turn-ender functions. **Migration complete** — and the legacy
`AGENT_CODEMODE=0` `runAgent` text-marker loop has now been **retired entirely** (2026-06-28): CodeMode is
the one agent loop, control signals are exclusively scope functions stack-wide. No text-marker protocol
remains anywhere.

## The principle

In CodeMode the agent already acts by **writing a JS program over a confined toolbox** — tool
calls are first-class function calls in a lexical scope. But the turn's *control signals* — "this
is my final answer", "I'm blocked", "I need to ask a question" — are still **text conventions**
parsed out of the model's prose:

- `ANSWER: <text>` on its own line ends a turn (`codemode.mjs` base prompt; parsed by
  `reply.replace(/^ANSWER:\s*/i, '')` at ~line 179).
- "ALWAYS finish with an `ANSWER:` line… never end silently" is enforced by prose instruction.

**dan's call:** these should be **functions in the JavaScript scope**, the same as every tool —
e.g. `answer("…")`, `ask("…")`, `blocked("…")` — not markers grepped out of free text. The
model's prose should never carry control semantics.

## Why (the motivating incident)

A voice-note turn produced a correct answer, but the marker string itself got **mangled by
markdown**: a test answer `REATTACHED_ANSWER_OK` rendered as `REATTACHEDANSWEROK` because
`_ANSWER_` is markdown emphasis. The same class of fragility hits the real `ANSWER:` convention:
the moment "answer" lives in prose, formatting/markdown/locale/casing/leading-whitespace can all
corrupt the signal, and the parser is a regex guessing at intent. A function call is
**unambiguous, structured, and impossible to confuse with content** — the answer is a string
*argument*, not "everything after the first line that matches `/^ANSWER:/i`".

## Sketch

Expose alongside the toolbox (confined, like any cap):

```js
answer(text)         // deliver the final reply; ends the turn
ask(question, opts?) // raise ONE typed clarifying question (today: a prose convention / askUser tool)
blocked(reason)      // finished-but-could-not-complete; structured, not "say plainly what stopped you"
```

The reasoning loop then reads the **return value / called signal**, never a regex over prose. The
existing program-execution path already captures `OUTPUT`; `answer()` is just one more recognized
call whose effect is "stop, this string is the user-facing reply."

## Migration notes

- Keep accepting `ANSWER:` during a transition window (back-compat) so older prompts/evals don't
  break; log when the fallback fires so we can see it drain to zero, then remove it.
- Update the base CodeMode system prompt (`packages/ocapn-noise/codemode.mjs`) + the eval suite
  (`voice-agent/eval/`) together — the evals assert on the answer extraction.
- Same treatment for the OTHER text markers in the loop (`TOOL_CALL`, the empty-response retry
  nudge): prefer a structured signal over a parsed string wherever a control decision is made.

## Open questions

- Does `answer()` end the turn immediately, or can a program keep running after it (e.g. fire a
  background notify)? Probably: `answer()` sets the reply; the program finishing ends the turn.
- How do `ask()` / `blocked()` map onto the existing typed-ask + access-request surfaces so the
  client renders them the same way (and a thrown card never swallows the answer — see the
  `renderAgentResponse` per-card isolation already shipped).
