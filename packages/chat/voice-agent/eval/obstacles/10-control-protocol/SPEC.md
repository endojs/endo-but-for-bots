# Obstacle 10 — the CodeMode control protocol (functions, not markers)

**Theme:** protocol / ocap. **Deterministic** (no LLM, GPU, or network): it drives the real
`runAgentCode` loop with scripted model replies and grades the protocol against the legacy
text-marker approach, so the suite *measures the difference*.

## The spec

In CodeMode the agent acts by writing a JavaScript program over a confined toolbox. Every control
decision is a **scope function**, never a string parsed out of the model's prose:

| Control signal | Function (CodeMode) | Legacy text marker |
| --- | --- | --- |
| invoke a tool | `await tool(args)` | `TOOL_CALL: {"name":…,"args":…}` |
| finish | `answer(text)` | `ANSWER: <text>` |
| ask the user | `ask(question)` | (prose convention) |
| can't finish | `blocked(reason)` | (prose convention) |

## Why functions win — the ocap framing

A text marker is an **in-band, forgeable string**: it shares one channel with the content, so
content that merely *mentions* `TOOL_CALL:` / `ANSWER:` collides with the control channel. A scope
function is an **out-of-band, lexical, unforgeable reference**: content and control are separate
channels (the program *calls* `tool(args)`; the answer is a string *argument*). This is the same
red-line as the rest of the stack — **designate by reference, not by a forgeable string.**

A marker is also fragile under formatting: the motivating incident was an `ANSWER:`-marked reply
whose body `…_ANSWER_…` was mangled by downstream **markdown** rendering (`_x_` → emphasis). A
function argument is delivered byte-exact and never re-parsed.

## What's graded

- **Tool-as-function** — a program `await store(args)` runs the tool, records it in the trace, and
  passes structured args verbatim (no serialize→parse round-trip).
- **Turn-enders-as-functions** — `answer()`/`ask()`/`blocked()` end the turn with the exact text and
  the correct structured flag (`asking`/`blocked`), not an `ANSWER:` prefix.
- **The difference (function correct ∧ marker fails on the same input):**
  - `answer()` delivers marker-/markdown-laden content **byte-exact**, while the legacy
    marker+markdown path **mangles** it.
  - prose that merely *quotes* `TOOL_CALL: {…}` **forges a spurious tool call** under the marker
    parser, while the function channel delivers it as inert content. (An honesty check confirms a
    *well-formed* marker still parses — the defect is ambiguity with content, not total failure.)
- **Lexical confinement** — a tool you don't hold has **no name in scope**; calling it cannot
  succeed (the Compartment's lexical scope *is* the boundary).

## Run

```bash
node --test eval/obstacles/10-control-protocol/spec.test.mjs   # as a spec suite (one assertion per property)
node eval/eval.mjs --obstacle control-protocol                 # via the eval harness
```

## Status of the protocol in the product

`answer()` / `ask()` / `blocked()` and tool-as-function are **live** in `runAgentCode`
(`packages/ocapn-noise/codemode.mjs`), and the `ANSWER:` marker is **retired** there — a no-program
reply is delivered verbatim (never stripped/parsed). The `TOOL_CALL:` / `ANSWER:` markers survive
only in the **legacy** `runAgent` loop (`tool-bridge.mjs`, used only under `AGENT_CODEMODE=0`). This
obstacle is the conformance gate that keeps the function protocol honest.
