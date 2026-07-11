# Chat Voice Command Parser

| | |
|---|---|
| **Created** | 2026-05-06 |
| **Updated** | 2026-05-07 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

The chat bar accepts speech-to-text via the Web Speech API
(the implementation lives at `packages/chat/voice-input.js`).
The transcription currently arrives as a flat string that lands in
the contenteditable input, exactly as if the user had typed those
characters.
That works for the Send mode but degrades the rest of the command
bar: a transcribed `slash list` does not open the command menu the
way a typed `/` does, and a transcribed pet name does not become a
chip the way the autocomplete pipeline produces.

The voice channel needs to drive the same modes the keyboard
already drives.
The parser is what turns a transcript into the same effects a
keystroke sequence would.

## Scope

This design covers:

- The shape of an asynchronous parse-monad state machine that
  consumes voice transcript fragments and produces command-bar
  effects (mode switches, chip insertions, command-menu picks,
  field commits, submission).
- The vocabulary the parser recognises in each mode, sourced from
  the same `command-registry.js` table the keyboard pipeline uses.
- How the modeline advertises the keywords that are significant in
  the current mode, so a speaker can hear what to say next without
  guessing.
- The handoff between the existing
  `packages/chat/voice-input.js` module (which owns the
  microphone-button DOM and the SpeechRecognition session) and the
  new parser (which owns the dispatch into the command bar).

This design does **not** cover:

- Wake-word detection or always-on listening.
  The button click remains the only trigger.
- Text-to-speech output.
- Languages other than the BCP-47 code already passed to
  `makeVoiceInput`.

## Existing Mode Inventory

The states the parser must drive correspond one-for-one to the
states already documented in `chat-command-bar.md`:

1. Empty (Send Mode)
2. Token Autocomplete Visible
3. Token Only (Chip Present, No Message)
4. Token + Message Text
5. Text Only (No Token)
6. Command Selecting (After `/`)
7. Inline Command Form (one sub-state per command in
   `command-registry.js`)
8. Eval Command (Inline)
9. Value Modal

State 7 fans out per command; the parser treats each command's
field list as a sub-state machine whose alphabet is the field
labels and the field type's domain
(`petNamePath`, `messageNumber`, `text`, etc.).

## Parser Shape

### Why an asynchronous monad

The keyboard pipeline can assume each keystroke completes before
the next arrives.
The voice pipeline cannot: a `result` event carries an interim
transcript that may extend on the next event, and a pet-name
autocomplete lookup is itself async (resolves the name path
against the host registry).
The parser therefore composes async steps and tracks partial
state across them.

The minimal interface:

```js
/**
 * @typedef {object} ParseState
 * @property {Mode} mode
 * @property {object} fields - per-mode accumulators
 * @property {string} buffer - transcript fragment not yet consumed
 */

/**
 * @typedef {object} ParseStep
 * @property {ParseState} next
 * @property {Effect[]} effects
 */

/**
 * @typedef {(state: ParseState, fragment: string) => Promise<ParseStep>} ParseFn
 */
```

The state machine is the set of `ParseFn` values keyed by mode.
A `dispatch(transcript)` call selects the `ParseFn` for the
current mode, awaits its `ParseStep`, applies the effects to the
DOM, and stores `next` for the following fragment.

### Effects

Effects are inert descriptions of what the parser wants done.
The chat bar interprets them.
Initial effect set:

| Effect | Meaning |
|--------|---------|
| `enter-mode` | Switch the command bar to a named mode |
| `commit-token` | Insert a token chip at the cursor |
| `set-field` | Write a value into a named field of the current command |
| `open-command-menu` | Show the command selector |
| `pick-command` | Choose a command by name |
| `submit` | Submit the current form |
| `cancel` | Escape out of the current mode |
| `append-text` | Insert literal text at the cursor |

Effects are passable values; the parser is pure functional
modulo the async lookups it performs against the host.

### Wake words per mode

Each mode declares a small wake-word table keyed by user
intention.
The Send-mode table:

| Spoken | Effect |
|--------|--------|
| `at <pet-name>` | `commit-token` for `<pet-name>` |
| `slash` | `enter-mode: command-selecting` |
| `slash <command>` | `pick-command: <command>` |
| `submit` (with the framing pause described below) | `submit` |
| `cancel` (with the framing pause described below) | `cancel` |
| `quote <word>` | `append-text: <word>` (literal escape) |
| anything else | `append-text` for the fragment |

The Command-Selecting table consumes the rest of the transcript
as a command-name fuzzy match against the registry.
The Inline-Command-Form tables are generated from each command's
field list: each field name becomes a wake word that selects it,
and the rest of the transcript flows into the field's value.

The wake-word tables are the load-bearing piece of the design.
They live next to the command registry so a new command picks up
voice support automatically when its registry entry is added.

The literal `quote` escape and the framing-pause requirement on
submit-class wake words are spelled out in the next-but-one
section, "Escape and Enter".

## Modeline Integration

The modeline already shows mode-specific keyboard hints.
The parser exposes a sibling `voiceHints(mode, state)` function
that returns the wake words the current mode honors.
The chat-bar's modeline component renders both lines when the
voice button is in the listening state:

```
Send · @ inspect or message · / commands · Space continue with @last
Voice · "at NAME" · "slash" · "slash COMMAND" · "send" · "cancel"
```

Outside listening state the voice line is hidden so the modeline
stays compact.

## Interaction Patterns

A small catalog of patterns to validate against during
implementation:

### Pattern: Send a one-line message

1. User clicks mic, says "at Alice hello world"
2. Parser dispatches `at` → `commit-token: alice` (pet-name
   lookup happens here)
3. Parser dispatches `hello world` → `append-text: hello world`,
   then waits
4. User pauses, says "submit" with the framing pause described in
   "Escape and Enter" below; parser dispatches `submit`. Or the
   user clicks the on-screen Send button. Or the user releases
   the mic button if push-to-talk is in use.

### Pattern: Run an immediate command

1. User clicks mic, says "slash list"
2. Parser dispatches `slash list` → `pick-command: list` →
   `submit`
3. Result modal opens, parser idles in Value-Modal mode

### Pattern: Fill an inline command form

1. User clicks mic, says "slash request from Alice description
   please send me the report"
2. Parser dispatches `slash request` → `pick-command: request`
3. Parser is now in Inline-Command-Form mode for `request`
4. Parser dispatches `from Alice` → `set-field: recipient =
   alice`
5. Parser dispatches `description please send me the report` →
   `set-field: description = please send me the report`
6. User says "submit" → `submit`

### Pattern: Cancel mid-command

1. User says "slash list cancel"
2. Parser opens command menu, immediately `cancel` resets

### Pattern: Edit a value

The modeline tells the speaker which field is currently focused.
The parser does not invent edit gestures; the speaker has to
say `cancel` and start over, just like the keyboard user
backspaces and re-enters.

## Asynchrony and Race Conditions

Transcripts arrive in fragments; later fragments may extend
earlier ones (the Web Speech API rewrites interim results).
The parser keeps a `buffer` of the unconsumed portion and only
commits effects when a wake word is recognised at a word
boundary.
A subsequent fragment that retracts the wake word causes the
parser to roll back the corresponding effect (the chat bar's
applied effects therefore need an inverse for `commit-token`,
`enter-mode`, and `set-field`).

The `end` event from `SpeechRecognition` flushes the parser:
any unconsumed buffer becomes a final `append-text` into the
input, and the parser returns to the mode it was in when
listening began.

## Escape and Enter

The wake-word vocabulary collides with the open vocabulary of
prose the speaker may want to put into a message or a text field.
The user must be able to say the literal words "submit", "slash
list", or "at" without triggering the parser; conversely, the
parser must recognise the user's intent to submit the form
without waiting for the mic button to be released.

The design picks two complementary mechanisms.

### Escape: a literal-quote prefix

The reserved word `quote` (configurable per locale) marks the
following word as literal.
A speaker who says "send the message quote slash list to Alice"
produces the text "send the message slash list to Alice", with
no command-mode entry.
The parser consumes `quote` and emits `append-text` for the next
whitespace-delimited token, then resumes ordinary parsing on the
fragment that follows.

The choice of `quote` over alternatives is deliberate:

- It is unlikely to appear by accident in chat prose
  (compared to `say`, which is conversational, or `literally`,
  which is conversational filler).
- It is one syllable and unambiguous when transcribed.
- It generalises: a future `quote begin ... quote end` pair can
  cover multi-word literals if the single-token form proves
  insufficient.

Alternatives considered are catalogued in "Open Questions".

The Inline-Command-Form mode applies the same escape inside a
field's value, so a `request` command's `description` field can
contain the words `from` or `description` literally.

### Enter: a framing-pause submit cue

The parser commits a `submit` effect when it observes the wake
word `submit` (or the synonym `send now`) flanked by silence on
both sides.
"Flanked" means the `SpeechRecognition` interim transcript ended
on the previous fragment, a silence interval of at least 600 ms
elapsed (a tunable; the existing `voice-input.js` already
exposes a silence threshold via the `endpointing` parameter),
and the next fragment begins with the wake word as its first
token.
The same pause is required after the wake word before any
following content is accepted as the next utterance.

The framing pause is what distinguishes the user saying "...
remember to submit the form by Friday" (no pauses) from "...
remember to submit the form by Friday. [pause] submit. [pause]"
(framed cue).

Two non-pause submit channels remain available unconditionally:

- The on-screen Send button click. The chat bar's existing
  Send-button handler always wins over voice; voice never
  blocks a click.
- The mic button release, if the user has enabled push-to-talk
  in chat preferences. Release flushes the buffer to
  `append-text` and emits `submit`.

### Cancel and other framed cues

The same framing-pause rule covers `cancel`, since a speaker may
also want to say the word "cancel" inside a message ("please
cancel my reservation").
The full set of framed cues is `submit`, `send now`, and
`cancel`; the `quote` escape itself does not require framing
because its semantic is local to the next token.

The wake-word table in "Wake words per mode" above marks framed
cues with the parenthetical "with the framing pause described
below".

### Why two mechanisms instead of one

A single mechanism leaves a usability hole.
A pure modal toggle (a separate "command mode" the user enters
explicitly) imposes a context switch on the speaker for every
command and conflicts with the design's premise that voice
should drive the same flow as the keyboard.
A pure confidence-threshold approach (drop low-confidence
command matches into dictation) cannot distinguish a
high-confidence transcription of the literal word "submit" from
a high-confidence transcription of the submit cue.

Splitting the two cases (escape for accidental keyword
collisions inside a fragment; framing pauses for terminal cues)
keeps each mechanism load-bearing for one job, and matches what
voice-assistant prior art (Google Assistant's "okay"
disambiguation, Apple Dictation's "press period" model) already
trains the speaker to expect.

## Test Plan

The parser's unit tests are pure: feed a state and a transcript
fragment, assert the next state and effect list.
Coverage targets:

- Each wake-word table's happy path (one pattern per row).
- Buffer extension across fragments (retraction of an interim
  word).
- Mode entry from each predecessor mode (Send → Command-Selecting
  → Inline-Command-Form → Send on submit).
- Cancel from each mode.
- Pet-name lookup failure (an `at` whose name does not resolve
  emits `append-text` rather than `commit-token`).
- `quote <token>` escape suppresses wake-word interpretation of
  the next token, in Send mode and inside an
  Inline-Command-Form field value.
- `submit`, `send now`, and `cancel` only fire when flanked by
  the configured silence threshold; an embedded "submit" inside
  a fragment without framing pauses is treated as `append-text`.

Integration tests live alongside the existing chat tests under
`packages/chat/test/component/` and exercise a stub
`SpeechRecognition` whose interim/final results drive the parser
end-to-end.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [chat-command-bar](chat-command-bar.md) | Source of truth for the modes the parser drives. |
| [chat-pending-commands](chat-pending-commands.md) | Voice-issued commands queue through the same pending-command UI as keyboard-issued ones. |
| [chat-slot-slash-commands](chat-slot-slash-commands.md) | Slot-based slash commands extend the parser's wake-word table by the same registry pathway. |

## Phased Implementation

1. **Parser scaffold**: pure `ParseFn` per mode with tests, no
   chat-bar wiring.
   Lands behind a feature flag so the existing voice button
   continues to use the flat-text path until the parser is
   ready.
2. **Effect dispatcher**: chat-bar interpreter for the effect
   list, with rollback for retracted interim transcripts.
3. **Modeline voice line**: render the wake-word table under
   the keyboard hints when listening.
4. **Migrate `voice-input.js`**: replace the direct `textContent`
   write with a call to `parser.dispatch(transcript)`.

## Design Decisions

1. **Per-mode wake-word tables, not a global grammar.**
   A grammar would centralise the vocabulary but obscure which
   words are significant when.
   Per-mode tables match the modeline's shape and let a new
   command's registry entry add its own wake words without
   touching the parser.
2. **Effects are passable values, not function calls.**
   The parser stays pure and testable; the chat bar owns the
   side effects.
   This matches the Hardened JavaScript convention of keeping
   effect descriptions inert.
3. **Rollback on retraction, not on every interim.**
   Re-applying every interim would flicker the UI.
   Wake words commit at word boundaries; only retracted wake
   words trigger inverses.
4. **Framed-pause submit, not always-on submit wake word.**
   A speaker who pauses naturally between sentences should not
   accidentally submit; the parser requires "submit" or "send now"
   to be flanked by a configured silence interval (initially 600
   ms) on both sides.
   See "Escape and Enter" for the rule.
5. **Per-token literal-quote escape.**
   The reserved word `quote` marks the next token as literal and
   suppresses wake-word interpretation, so a message can contain
   the words "slash", "at", "submit", or any other vocabulary
   the parser would otherwise eat.
   Chosen over a modal command-mode toggle because the modal
   approach forces a context switch the keyboard pipeline does
   not require.

## Open Questions

- What is the canonical wake word for "open the command menu"?
  `slash` is consistent with the keyboard but reads oddly aloud.
  `command` collides with the noun.
- Should pet-name lookup happen inline during parsing, or
  should the parser emit `commit-token-pending` and let the
  chat bar resolve?
  Inline keeps the parser self-contained but couples it to the
  host; pending keeps the parser pure but defers errors.
- How loudly should the modeline change between modes when
  driven by voice?
  A purely visual modeline misses the speaker who is looking at
  their face in the camera, not the screen.
  An aural cue is out of scope for this design but worth noting.
- Does the parser want a shared state across mic sessions, or
  does each mic click reset to Send mode?
  The latter is simpler per se; the former enables resuming a
  multi-step command after an accidental pause.
- Is `quote` the right literal-escape wake word, or does an
  alternative read better aloud?
  Candidates considered:
  `literally` (conversational filler; risk of false trigger),
  `say` (collides with imperative speech in messages),
  `quote unquote` (requires a closing token; doubles the
  recognition surface),
  `escape` (overloaded with the keyboard's Escape semantics).
  `quote` was picked but the choice deserves a usability check
  before voice support ships beyond a feature flag.
- What is the right framing-pause threshold for the submit cue?
  600 ms is a starting point that aligns with the
  `endpointing` default in the existing `voice-input.js`, but
  short-pause speakers may trip it accidentally and long-pause
  speakers may need to wait.
  The threshold should be tunable per user, and the modeline
  should hint how long to wait.
- Should the parser also accept a non-voice "enter" gesture
  (e.g., a long-press on the mic button) as a submit cue, in
  addition to the framing-pause "submit" wake word?
  This would parallel push-to-talk's release-to-submit
  behaviour for tap-to-talk users.

## Prompt

> Please consider how we will parse voice transcription from the
> command line to fluently populate each of the kinds of commands
> afforded by the command line.
> Document the expected interaction patterns.
> Introduce a parser.
> That is likely an asynchronous parse monad state machine that
> tracks or drives the user interface mode.
> Consider using the modeline to hint what keywords are
> significant in each mode.

(From kriskowal's review on
[PR #44](https://github.com/endojs/endo-but-for-bots/pull/44),
2026-05-06.)
