# M11 interface contract: voice

Unit W11.0 of `milestones.md` M11. This file and the files it names in section 0 are the contract
the M11 builders (W11.1-W11.8) and the integration unit W11.9 build against without talking to
each other. The earlier contracts (`m1a-` to `m5-interfaces.md`) hold unless a section below
changes them; where this file and a guard or constant file disagree, the file wins and this text is
wrong: report it. It replaces the M11 section of `milestones.md` (work units, acceptance, perf);
the fold (section 17) copies sections 12-14 there.

Paths: `H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`, `GW/` =
`AH/gateway/`, `UI/` = `H/ui/`. Spec items are `P-n`, `R2-n` .. `R8-n`, `A.n`, `G-n` of
`endo-harness-spec.md` (outside the repository; never copy its deployment details), digested in
`designs/survey/spec-digest.md`. Endo sources are read at `1315bef86` (`git show
1315bef86:<path>`): `packages/floot/voice/{audio-server-caplet,tts-server-caplet}.js`,
`packages/floot/voice/moonshine_daemon.py`, `packages/floot/src/{turn-speech,speech-code-filter,
voice-preferences}.js`, `packages/chat/floot-component.js` l.2019-2774 (client audio).
"Architecture n" is `designs/architecture.md` section n; "M3 n" is `m3-interfaces.md` section n.

**Step 3 of the harness review.** Its plan (`designs/arch-review/step3-plan.md` at `53a8dbb9ea`)
says M11 adds a session-side runtime part "only if voice keeps per-session state in the vat" and
that feeds use the shared channel subscriber (plan 2.4). M11 keeps **no** per-session vat state
(D-M11-14) and its speech view is a `Live` subscriber (D-M11-4), so no M11 seam touches
`guest/session/`, the runtime parts or the provider shell. The settle unit (W11.0 settle,
journal J-1313..J-1316) re-anchored every seam that was "provisional until step 3" against the
step-3 code as built in the cleanup lane at `cecfa12809` (`guest/factory/starts.js`,
`guest/factory/factory.js`, `GW/server.js` after HR-SYN-35, `AH/index.js` after PROVIDERS): none
stays provisional; section 11 says, per seam, which lines it was anchored to. If step 3's merge
commit differs from `cecfa12809` at those lines, the builder re-reads the named block, not the
line numbers.

**Cross-check issues applied at the settle unit** (WX.0, journal J-1410..J-1417): X-01 (M11's
session cap is 0, measured: D-M11-24); X-02 (H1, H3, H4 done by WX.1: section 11); X-09
(`70-voice.js`); X-10 (`starts` object, M9's `getMail`); X-11 (b) (`configureSpeech` on
`HarnessRoot`: D-M11-21) and (c) (`readGrant` for the speech extension only: D-M11-22); X-12
(appendix C, R8-29 departure D-M11-23, Talk without a runner D-M11-25 and O-11, the cross-lane
test named in section 13); X-14 (`voice.deliveries` a gate row; M11's own regression list);
X-17 (merge order and fold, section 17). None was declined.

M11 runs in parallel with M6 (containers), M8 (compaction, images) and M9 (mail, subagents), each
in its own lane, all starting from the main branch after the review's step 3 **and** after the
cross-lane seam unit WX.1 (cross-check X-02), which applies every lane's entries in shared guard
modules and tests in one commit. M11's entries there are appendix A (H1), the vocabulary listing
(H3) and the re-pin (H4).

Contents: 0 files of the contract; 1 scope; 2 decisions; 3 objects and interfaces; 4 the audio
socket; 5 bounds, events and timeouts; 6 speech engines; 7 the speech view of a turn; 8 what
persists, restart and SIGKILL; 9 the browser client; 10 security; 11 seams and merge hotspots; 12
work units; 13 acceptance; 14 performance and hostile-input probes; 15 core requests; 16 owner
questions; 17 the fold; 18 fixed texts. Appendix A: the seam code for `guards/factory.js` (applied
by WX.1). Appendix B: test fixtures. Appendix C: the spec items of section 5 and the voice rows of
sections 2, 3, 6 and 8, item by item.

---

## 0. Files of the contract (committed with this document)

| file | what it fixes | read by |
|---|---|---|
| `AH/speech/audio-protocol.js` | the `/audio` frame format, frame kinds, close codes, stream numbering, `audioLimits`, `audioTimeouts`, event types, phases, `speechTexts`, `speechTextOf`; no imports (browser and adapter) | W11.5, W11.6, W11.8, W11.9 |
| `AH/speech/engine-protocol.js` | engine kinds, the speech-in process protocol (Endo's Moonshine JSON lines), Piper flags, the voice files, the `openai-audio` paths and constants, the engine environment allowlist, restart pacing, log events | W11.1, W11.2, W11.4, W11.5 |
| `AH/speech/engine-types.js` | JSDoc types of the adapter-internal objects: `SttEngine`, `Utterance`, `UtteranceSink`, `TtsEngine`, `Synthesis`, `PlaybackSink`, `TtsCatalogue`, `CheckedTtsOptions`, `SpeechText`, `TurnTextSink`, `TurnSpeechView` | W11.1-W11.5 |
| `guest/lib/voice-preferences.js` | preference fields, `ttsRanges`, `ttsDefaults`, `voiceLimits`, the shortcut's default preset label, `voiceTexts`, `voiceTextOf` (plain data: vats, adapter and browser import it) | W11.2, W11.5, W11.7, W11.8 |
| `guest/lib/speech-guards.js` | Node-only guards of the gateway-local `Speech` and `AudioPort` and their shapes (`speechShapes`, `speechInterfaces`, `speechMethodNames`, `vocabularyShapes()`) | W11.5, W11.8 |
| `UI/src/voice/endpointing-defaults.js` | R5-19..R5-33 constants, the junk list, capture block and constraints | W11.6, W11.8 |
| `UI/src/voice/texts.js` | browser texts of the voice feature | W11.8 |

The factory-vat guards (`Voice`, `VoicePreferences`, `SpeechSettings`, `HarnessRoot.configureSpeech`,
...) cannot be a new file: they belong in the factory's table, so they are seam H1, with their
exact code in appendix A. WX.1 applies them with the other lanes' shared entries (cross-check
X-02); no M11 unit edits `guards/factory.js`.

---

## 1. Scope

### 1.1 What M11 delivers

| P | M11 builds | left to |
|---|---|---|
| P-30 speech in | streamed 16 kHz mono s16le in over the page's `/audio` socket; cumulative partials (replace, not append) and a final after `end`; one resident engine (`process` kind: Endo's Moonshine daemon, respawned on next use) or an HTTP provider (`openai-audio` kind, key through a grant); every stream timed out | - |
| P-31 speech out | one synthesis per reply, sentence-pipelined, PCM streamed as produced with its sample rate; catalogue with range checks; Piper (`process`) or the HTTP provider; a warm spare process for the shared preferences (R5-66 improved) | - |
| P-32 speech view | `AudioPort.speak(session, turnId)`: the turn's assistant text from the session's live channel in the adapter (snapshot, then deltas), code fences and markdown removed, sentence split; a finished last turn replays to the end | - |
| P-33 endpointing | client calibration, threshold, drift, trailing silence, grace, minimum speech, pre-roll, junk filter, editable compose box, auto-send | - |
| P-34 playback | gapless scheduling, soft barge-in that stops playback and synthesis but not the turn; mute stops the current reply; Stop cancels the turn | - |
| P-35 preferences | shared voice preferences in the factory vat (device A writes, device B uses), device cache, voice catalogue, mic and speaker toggles, level meter, per-message Play button, spoken prompt only for voice-started sessions | - |
| P-49 voice shortcut | the shortcut's preset chosen by object with the catalogue revision (R5-53); "Talk" starts a spoken session from it | - |
| P-61 voice preset | the built-in `voice` preset's backend and model pinned by provisioning (R4-89); G-11 fallback to the factory default with a warning | the preset's workspace and shell objects (M6: until M6 merges, `voice` is listed `available: false`) |
| P-66 wake lock | screen wake lock while the mic is on, speech plays or the active turn runs | - |
| R6-60 launch | `Voice.startVoiceSession({ invocationId })`: a durable claim per id (32 kept) so a redelivered launch answers the same session | the Android shell (P-60, open decision 7) |
| R5-67, R5-68 | timeouts on every stream; bounded buffers and backpressure both ways; AudioWorklet capture instead of `ScriptProcessorNode` | - |

### 1.2 Not in M11

Android (P-60) and its invocation sources; a wake word or background listening (R5-71); a server
voice-activity detector (R5-1: the client endpoints); downloading Piper voices or Moonshine weights
by the harness (O-4: the engines and the operator do it); speech
across daemons. Out of parity scope by the owner's rules: the reverse proxy, the browser peer relay.

### 1.3 The design in one page

```
browser page                                         agent-host ADAPTER (one process)
  ui/src/voice/ (feature)                              GW/extensions/speech.js
   capture: getUserMedia -> AudioWorklet               services: [{ label: 'speech', make }]
     (AH/speech/capture-worklet.js, 16 kHz s16le)      routes: upgrade /audio, http /speech/capture-worklet.js
   endpointing (client only, R5-1)                     largeCalls: Speech.replay
   playback (gapless)                                  AH/speech/host.js   Speech (extras), AudioPort per page
     |  /ws CapTP: Speech.openAudio, AudioPort.transcribe/speak, Speech.replay, Voice.*
     |  /audio binary frames: HELLO, AUDIO, END, ABORT  <->  READY, EVENT, PCM
     v                                                 AH/speech/route.js  frames <-> streams
                                                       AH/speech/stt-*.js, tts-*.js  engines
                                                         process kind: child processes (stdio)
                                                         openai-audio kind: HTTPS, key via ReadGrant
                                                       AH/speech/turn-view.js: Live.subscribe(session)
                                                         in process (0 vat deliveries per delta, D-8)
     |  OCapN through the hub: Operator.getVoice, Voice.* (pages);
     |  Voice.speechSettings (the speech host, once per incarnation and when stale)
     v
factory VAT: Voice (guest/factory/voice.js): preferences, shortcut preset, launch claims,
  speech settings (with ReadGrant objects; written only through HarnessRoot.configureSpeech,
  the provisioning path, never by a page: D-M11-21)
session VATs: nothing new (the spoken prompt exists since M5; voice submits through the Composer)
```

Audio, transcripts in progress, synthesized PCM, sentence text and engine processes never enter a
vat, the hub or a log (architecture fact 2 and its rule "vats decide, adapters carry data"). The
only vat traffic M11 adds is the factory's `Voice` calls (a handful per page load, one per
preference change or launch) and the submission the user sends, which is an ordinary Composer
submission (R5-7).

### 1.4 Sizes against the frame limits

`frameBytes` 24,576 (string content of one message into or out of a vat), the hub's vat frame
ceiling 65,536 encoded bytes (CC-027, `config/defaults.js` `vatFrameBytes`), `inlineBytes` 8,192.

| message into or out of a vat | largest | how it is bounded |
|---|---|---|
| `Voice.setPreferences(patch)` in | about 0.4 KB (a 128-unit voice and four numbers) | guard: closed record, `voiceLimits.voiceUnits` |
| `Voice.getPreferences()` out | about 0.4 KB | same |
| `HarnessRoot.configureSpeech(settings)` in / `Voice.speechSettings()` out | at most 2 x 32 arguments of 4,096 units in the worst case: 786,432 bytes estimated, **too big**; therefore the guard bounds the whole record: a process command is at most 32 arguments **and** the factory refuses settings whose estimated size (units x 3) exceeds `frameBytes - 2,048` (`voiceTexts.speechSettingsInvalid`) before keeping them, so the answer always fits | appendix A `SpeechSettings`; W11.7 tests the refusal at 22,529 bytes |
| `Voice.startVoiceSession(request)` in / answer out | about 0.3 KB in; out a `Session` presence, a 64-unit key, a 300-unit warning | guard |
| `Voice.setVoicePreset(preset, revision)` | tiny | guard |
| anything audio | 0: never into a vat | D-M11-1 |

A page's calls to the gateway-local `Speech` and `AudioPort` never reach a vat; the bridge's
frame guard still bounds them at `frameBytes`, except `Speech.replay`, a registered `LargeCall`
bounded by `wsMessageBytes` (1 MiB) and by its guard (64 pieces of at most `inlineBytes` units or
Blobs).

---

## 2. Decisions (D-M11-1 ..) with reasons and the alternatives rejected

**D-M11-1. Audio is a data path in the agent-host adapter; vats only decide.** Speech in, speech
out, the speech view and every engine are objects of the agent-host process, made per adapter
incarnation by the gateway extension `GW/extensions/speech.js`. The factory vat keeps the durable
decisions: preferences, the shortcut preset, launch claims and the speech settings. *Rejected:* a
speech vat or session part (each 85 ms block would be a crank of about 70 ms and every byte
hardened at about 10 us, architecture fact 2); the manager vat's `AgentHostAdmin.speech()`
(architecture 3.3; see D-M11-2).

**D-M11-2. No change to the agent-host manager part.** The speech settings (engine kind, command,
voices directory, provider base URL, model, and the provider key as a `ReadGrant` object) live in
the factory's `Voice`. The speech host reads them through the gateway's `Operator` presence
(`E(E(operator).getVoice()).speechSettings()`, two factory cranks, once per incarnation and again
when older than `settingsMaxAgeMs`, section 6.4) and reads the key through the grant in process
(`context.readGrant`, given to the speech extension only: seam H6, D-M11-22), as API backends do
(D-6). The settings are written only by `HarnessRoot.configureSpeech` (D-M11-21).
*Rejected:* `AgentHostAdmin.speech()`
with a kit registration (a manager-part change is a reinstall that breaks live references until
W13.2, rule 5 of the review; it would be this group's only manager change); a JSON file in the
state directory (it cannot hold a `ReadGrant`, so a provider key would have to be a name or a
value on disk, both forbidden).

**D-M11-3. One binary `/audio` WebSocket per page, bound to an `AudioPort` by a one-time token;
streams opened by CapTP calls, their data in band.** `Speech.openAudio()` answers `{ port, token }`;
the page opens `/audio` and sends HELLO with the token (never in the URL: logs and proxies). Each
stream is opened by a guarded CapTP call that answers its number (`AudioPort.transcribe()`,
`AudioPort.speak(session, turnId, options)`, `Speech.replay(port, pieces, options)`); audio, PCM
and stream events then travel as binary frames (section 4), pushed, not pulled. *Rejected:*
R5-2's audio as object messages over the CapTP socket (base64 inside JSON adds 34 % (3,653 bytes
for a 2,720-byte block, J-1310), each stream a pull per chunk costing one network round trip, and
streams would share the bridge's 32 calls in flight with the UI; recorded as a departure, O-5);
streams opened in band (a playback needs a `Session` object, which cannot travel in a binary
frame); one socket per stream (a handshake per utterance through the proxy).

**D-M11-4. The speech view is an in-process `Live` subscriber, not a channel tap.**
`AH/speech/turn-view.js` calls `context.live.subscribe(session)` (the gateway context's `Live`, the
same object pages use, M3 3.2) and reads the snapshot then the deliveries for `turnId`; a staged
`final` is read through `context.content` in process. Zero vat deliveries, and it uses step 3's
shared channel subscriber when that lands. *Rejected:* an entry in `AH/channel-taps.js` (a shared
hook table HR-SYN-23 marks for deletion; a tap sees every delivery of every session and runs in
the publish path); replaying finished turns through `Turn.getContent` (a session crank per page;
the client already holds a finished turn's text, R5-45).

**D-M11-5. Engines are a kinds table with two kinds.** `process` (spec parity, R5-2, R8-43: Endo's
Moonshine daemon over JSON lines, unchanged; Piper with one process per reply) and
`openai-audio` (the owner's rule that speech providers are adapters with keys from grants: an
HTTP API of the OpenAI audio shape, the key read per request in process). Every acceptance item
runs against fakes: fake process engines (`test/fixtures/fake-stt.mjs`, `fake-tts.mjs`) and a fake
speech server bound to loopback (`test/fixtures/fake-speech-server.mjs`); the real engines and a
real provider are `[real-moonshine]`, `[real-piper]`, `[real-provider]` repeats for an owner run.
*Rejected:* loopback servers wrapping the local engines (Piper reads stdin only; it would add a
process); one kind only (either breaks spec parity or the owner's provider rule). Subscription
pools (M4) carry no speech API, so a provider key is an API key `Secret` behind a `ReadGrant` (O-10).

**D-M11-6. The speech text pipeline lives in the adapter.** `AH/speech/code-filter.js` (Endo's
`speech-code-filter.js`) and `AH/speech/speech-text.js` (markdown strip, sentence split, merge,
forced cut), not `guest/lib/` as the old milestone text said: no vat runs them, so they cost no
bundle byte. *Rejected:* `guest/lib/speech-code-filter.js` (would invite a vat use and confuse the
guest lint).

**D-M11-7. `speak` names the turn by `turnId` within the session's channel.** The live channel
numbers every event by `turnId`, `History.turnContent(session, turnId)` takes it the same way (M2),
and clients compare turns by `turnId` (architecture 9). *Rejected:* a `Turn` presence (mapping it to
the channel's events costs a session crank and a delivery per `speak` (`getStatus`), and a page may
hold only the newest 32 `Turn`s, J-9152). `speak` speaks only the channel's current or last turn;
any other answers `speechTexts.turnNotLive` and the page uses `Speech.replay`.

**D-M11-8. The factory's `Voice` is reached by `Operator.getVoice()`** and holds preferences, the
shortcut preset (an object, with the catalogue revision for concurrency), the launch claims and the
speech settings. Its job lives in `guest/factory/voice.js` (rule 7); `factory.js` gains three
lines (seam H2), `main.js` one and `root.js` two (seam H2b, for D-M11-21).

**D-M11-9. G-11 fallback by asking the backend, never by reading an error text.** Before creating
a session from a preset that pins a backend and model, `startVoiceSession` calls
`E(backend).resolveModel(modelId)`; any rejection means "not available": the session is created on
the factory default backend and model with `voiceTextOf.voiceModelUnavailable(modelId)` as the
answer's `warning`. *Rejected:* trying `createSession` and matching its failure text (T4).

**D-M11-10. Timeouts on every stream (R5-67 fixed).** HELLO 5 s; an unused token 30 s; no audio on
an open utterance 30 s (`sttIdleMs`); no engine output for an utterance 10 s, or no final 10 s
after `end` (`engineTimeoutMs`: the engine is restarted and its utterances abort); no PCM for a
written sentence 10 s (`synthTimeoutMs`: that sentence fails, the next is tried on a new process);
an engine that is not ready in 600 s is killed (first runs download weights). Values:
`audio-protocol.js` `audioTimeouts`.

**D-M11-11. Bounded buffers and backpressure both ways (R5-68 fixed).** Each bound in
`audioLimits` bounds retained state, never a lifetime count: utterance audio (300 s, then the
server ends it), engine backlog (2 MiB), PCM queued on the socket (1 MiB: synthesis pauses until
it drains), sentence backlog (1 Mi units), open streams per port (4), ports (64), speech views per
session (2). Capture uses an `AudioWorklet`.

**D-M11-12. A warm spare synthesis process (R5-66 improved).** With `spareSynth` (default on) the
`process` speech-out engine keeps one Piper process started for the current shared preferences,
so a reply's first sentence does not wait for a model load; a playback with other options starts
its own. The spare is replaced after use and dropped when the preferences change.

**D-M11-13. UI state uses the existing feature pattern; no third pattern.** The voice feature keeps
its per-connection state in its own module closure keyed by `context.powers` (a `WeakMap`), as
M4's accounts and M5's mentions do (HR-SYN-6 (a) moves all of them onto `FeatureContext` in step
5). The controller gets one seam only: a submission notice (H10).

**D-M11-14. No session part and no session change.** Spoken sessions already get the spoken
introduction (M5, `prompt-sections.js`), a voice message is an ordinary Composer submission, and
interruption is not told to the model (R5-47). The session bundle does not change.

**D-M11-15. Every process engine exits when its standard input ends.** That is how engines die with
the adapter: the adapter process exits on IPC disconnect (`pkg/src/platform/node/
adapter-process-entry.js`) and its pipes close. A test kills the supervisor and finds no engine
left (K11-1).

**D-M11-16. Only voice-started sessions are spoken (R5-70 fixed; spec-digest "every chat-UI session gets the spoken-reply prompt").** `startVoiceSession` creates with `spoken: true`; the new-session dialog and typed
sends create plain sessions. Departs from R5-52's "the UI creates every session spoken" (O-2).

**D-M11-17. Play an individual assistant message.** The `message.action` slot
places a Play button at the lower right of each assistant message that has text to speak.
Activating the button sends that message's content to `Speech.replay`.
If automatic playback misses the live turn, the user can play the saved message from its button.

**D-M11-18. Unknown preference keys are refused, not dropped.** R5-54 drops other keys; the
gateway's key guard refuses a call with a key outside the vocabulary before decoding (M3 4.4 rule
4), and the factory's guard is a closed record. The page sends only the five fields.

**D-M11-19. Ranges are checked at write and at synthesis.** `setPreferences` refuses a value that
is not a finite number in `ttsRanges` (`voiceTexts.preferenceOutOfRange`); the speech host checks
again at `speak`/`replay` (R5-41, R5-54), since a provider or catalogue may change.

**D-M11-20. Auto-speak covers every send of the page.** The voice feature learns each send of its
page (typed or spoken) from the controller's submission notice (H10), maps the receipt to its turn
(`receipt.turnId`, or one `getSubmissionReceipt(requestId)` after the next `turn-start` for a queued
entry) and calls `speak` when that turn starts, if auto-speak is on and speech out is configured
(R5-45). Turns of other pages are not spoken.

**D-M11-21. The speech settings are written on the provisioning path, never by a page
(cross-check X-11 (b)).** `configureSpeech` leaves the page-reachable `Voice` and becomes
`HarnessRoot.configureSpeech(settings) -> SpeechSettings`, called by the provisioning step
`scripts/provision-steps/70-voice.js` (the `HarnessRoot` is the installed application's value, held
by provisioning and the administration CLI; a page holds only the `Operator`). A page holding the
sign-in secret therefore cannot make the adapter spawn a command line of its choosing. `Voice`
keeps `speechSettings()` (a read the speech host needs through the gateway's `Operator`): a page
can read the configured argv and receive the key's `ReadGrant`, which adds no authority, since the
same page already holds `SecretsAdmin` through `Operator.getSecrets()` and no gateway method lets a
page read a key through a grant. *Rejected:* a separate `SpeechAdmin` facet reached by
`HarnessRoot.getSpeechAdmin()` (one more interface, guard and vocabulary entry for one method);
a `speech` field in `HarnessSettings` through `HarnessRoot.configure` (that method answers the
pool's status and sets the pool: two jobs in one record, and M6's `environments` field shows the
pattern growing); a field of the gateway's `serve` config (a manager-part guard change, review
rule 5); refusing `configureSpeech` on the gateway by its method name (the vocabulary is a union of
all interface guards' method names: it cannot exclude one method of one object).

**D-M11-22. The key reader goes to the speech extension only (cross-check X-11 (c)).** The
gateway service takes `extensionPowers`, a list of `{ extension, powers }` records from
`AH/index.js`, where `extension` is the `gatewayExtension` object `AH/index.js` imported from
`GW/extensions/speech.js` and `powers` is `{ readGrant }`. When the loader
(`GW/extensions.js` `loadGatewayExtensions`) loaded a file whose `gatewayExtension` is that very
object (compared by identity), that extension's `make(context)` and `target(context)` receive
`harden({ ...context, ...powers })`; every other extension receives the plain context, which has
no `readGrant`. The object comparison, not a file or extension name, picks the receiver (owner
rule: objects, not names). Assumption A-5 (W11.5 proves it in `gateway-speech-extension.test.js`):
the loader's `require` of an ES module and `AH/index.js`'s `import` of it answer the same module
instance (Node's `require(esm)` shares the ES module cache). If A-5 fails, W11.5 stops and reports;
the fallback, to be ruled by the PM, is the loader matching the file `speech.js` (a name at the
code-loading boundary). *Rejected:* `readGrant` on every extension's context (the original H6:
`secrets.js` and later extensions would hold a key reader they never use); a `needs:
['readGrant']` declaration in the extension's export (any file in the directory could declare it:
an audit aid, not a bound).

**D-M11-23. Engines are fresh per start and started on first use (R8-29, recorded departure).**
The spec's engines are removed and recreated at every daemon start with the current
configuration (R8-29, R5-58). Here the speech host and its engines are objects of one adapter
incarnation, and the adapter is a new process at every start, so every engine is fresh and reads
the current settings (the settings cache starts empty). They are started at first use (the first
`openAudio`, `configuration` or `status`, which reads the settings and warms speech in when
`warm: true`), not during the start: a start with no voice page costs no 450 MB resident
speech-in process (R2-6) and no start waits on a model load (R8-29's unbounded wait, R5-58; here
`engineLoadMs` bounds it, D-M11-10). The cost: the first page of an incarnation pays one engine
start (`speech.engineRespawn` measures it with the fake, 20.5 ms spawn; Moonshine's real warm-up is
an owner-run row). Owner question O-12. *Rejected:* warming at the gateway bind (it would need a
bind notice on the `GatewayContext`, one more M3 change, for a gain only the first utterance sees).

**D-M11-24. The session program does not change (cross-check X-01: M11's cap is 0 bytes).**
Measured with `node scripts/bundle-guest.mjs` on this tree (J-1313): the session program bundles
`guards/base.js` and `guards/session.js`, not `guards/factory.js`, so appendix A grows only the
factory program (155,427 bytes today; W11.7 records the new size). M11 adds no module under
`guest/session/`. W11.7 and W11.9 check that the session and exec bundles are byte-identical before
and after; a change there is a defect of M11, not a share to negotiate.

**D-M11-25. Talk on a state without an environment runner (cross-check X-12).** The built-in
`voice` preset needs a shell (R3-13) and therefore M6's runner. Until the owner rules (O-11),
`startVoiceSession` refuses as `createSession` does (M6's `runnerRequired`, propagated unchanged,
never matched by its text) and the Voice panel lists the presets the catalogue reports available
so the operator can choose another shortcut preset. Before M6 merges, the `voice` preset is
`available: false` (section 1.1) and `startVoiceSession` answers its `unavailableReason` (M5).

---

## 3. Objects and interfaces

Columns: **caller**; **crank** (the vat crank it costs, or none); **mode** (answered or sendOnly);
**max** (largest message either way); **retired break** (what a break with the hub's retired text
means to the caller); **heaviest crank** (in the vat that receives it).

### 3.1 Factory vat: `Voice` (W11.7, `guest/factory/voice.js`; guards appendix A)

`makeVoice({ catalog, create, rows, settings, starts })` is called once in `makeFactoryKit`
(seam H2) and answers `{ facet, configureSpeech }`; `Operator.getVoice()` answers `facet`, and
`HarnessRoot.configureSpeech` calls `configureSpeech` (seam H2b, D-M11-21). Inputs: `catalog`
(M5's `PresetCatalogKit`: `builtIn`, `recordOf`, `facet.configuration`), `create` (the kit's local
`createSession(options)`, `factory.js` l.361 at `cecfa12809`, a local call, not `E()`), `rows`
(`ofSession(session).key`), `settings` (the kit's `harnessSettings`: `defaultBackend()`,
`defaultModelId()`), `starts` (the factory's one `StartCount` of `guest/factory/starts.js`,
HR-SYN-36 as built: `current()`; voice never calls `next()`, which only the start listener's
recovery does).

| method | caller | crank | mode | max | retired break | heaviest crank |
|---|---|---|---|---|---|---|
| `Operator.getVoice() -> Voice` | page (once per connection), speech host (once per incarnation), provisioning step (preset pin) | 1 factory | answered | tiny | the factory is lost (D-17): fatal to the harness | trivial |
| `getPreferences() -> VoicePreferences` | page at load and when the voice panel opens | 1 factory | answered | 0.4 KB | page shows "unavailable", uses device cache | trivial |
| `setPreferences(patch) -> VoicePreferences` | page, debounced 300 ms (R5-50) | 1 factory | answered | 0.4 KB | as above | merge of 5 fields; refuses non-finite or out of range (D-M11-19) |
| `getVoicePreset() -> Preset` | page (voice panel) | 1 factory | answered | tiny | as above | answers the chosen preset, else the built-in `voice` |
| `setVoicePreset(preset, expectedRevision) -> Preset` | page (voice panel) | 1 factory | answered | tiny | as above | refuses a stale revision with M5's `texts.presetStale`, a preset not of this catalogue or deleted with `voiceTexts.presetNotUsable` |
| `startVoiceSession(request) -> VoiceSessionAnswer` | page ("Talk", a launch link) | 1 factory crank, then `createSession`'s (a spare take: about 0.85 s, J-9382) plus one adapter round trip for `resolveModel` when the preset pins a model (70-76 ms, J-9043) | answered | 0.3 KB in, 0.5 KB out | as above | the creation crank (as `createSession`); the claim is written in the crank that receives the request and again in the crank where `create` resolves |
| `speechSettings() -> SpeechSettings` | speech host | 1 factory | answered | under `frameBytes` (checked at write) | speech host: settings unavailable, both directions `failed` with an error in `status()`; never a restart signal | trivial |
| `HarnessRoot.configureSpeech(settings) -> SpeechSettings` (not on `Voice`, D-M11-21) | provisioning step `70-voice.js`, the administration CLI; never a page | 1 factory | answered | under `frameBytes` (checked) | caller reports the loss | validate per kind, bump `revision` |

`startVoiceSession({ invocationId?, title?, at? })`:

1. With an `invocationId`: a claim `{ state: 'made', session, key }` answers `{ session, key,
   duplicate: true }` at once (R6-60). A claim `{ state: 'creating', start }` with `start ===
   starts.current()` throws `voiceTexts.launchInProgress`; with an older `start` (a restart
   interrupted it) it is re-run from step 2. A new id is claimed `{ state: 'creating', start:
   starts.current() }`;
   when more than `voiceLimits.invocationClaims` (32) are kept, the oldest is forgotten.
2. The preset is the chosen shortcut preset, else `catalog.builtIn('voice')`. Its record's
   `backend` and `modelId`, when both are set, are checked with `E(backend).resolveModel(modelId)`;
   a rejection makes the options `{ preset, backend: settings.defaultBackend(), modelId:
   settings.defaultModelId(), spoken: true }` with `warning: voiceTextOf.voiceModelUnavailable
   (modelId)` (D-M11-9); otherwise `{ preset, spoken: true }`. `title` and `at` pass through.
3. `create(options)`; on success the claim becomes `{ state: 'made', session, key:
   rows.ofSession(session).key }` and the answer is `{ session, key, duplicate: false,
   warning? }`. On failure the claim is deleted and the error propagates (a preset that is not
   available answers its `unavailableReason`, M5).

**Persists** (factory heap, all bounded): the preferences record (5 fields), the shortcut preset
reference (or none), at most 32 claims, the speech settings (2 direction records and a revision).
Export and import of these records is M13's (section 17, F-6).

### 3.2 Gateway-local: `Speech` and `AudioPort` (W11.5, `AH/speech/host.js`; guards `speech-guards.js`)

`Speech` is the extras service `{ label: 'speech' }` of `GW/extensions/speech.js`, one per adapter
incarnation. `AudioPort` is minted per `openAudio`. Both are gateway-local exos marked with
`GW/powers.js` `markNeverLeaves` (M3 4.4 rule 2), so the bridge refuses them as arguments toward a
vat. No vat crank unless stated.

| method | caller | crank | mode | max | retired break | heaviest step (adapter) |
|---|---|---|---|---|---|---|
| `Speech.openAudio() -> { port, token }` | page, after sign-in and at each reconnect | none; reads the settings when stale (2 factory cranks, D-M11-2) | answered | 0.2 KB out | - | mint 32 random bytes; refuse over `audioLimits.ports` with `speechTexts.tooManyPorts` |
| `Speech.configuration() -> SpeechConfiguration` | page at load | none (settings read when stale) | answered | about 12 KB out (128 voices) | - | the catalogue read once per settings revision |
| `Speech.status() -> SpeechStatus` | page (diagnostics), tests | none | answered | 0.6 KB | - | - |
| `Speech.replay(port, pieces, options?) -> { stream }` | page: the Replay control | none | answered | 1 MiB in (`LargeCall`) | - | check options (R5-41); read each Blob piece through `Content` in process; open a playback |
| `AudioPort.transcribe() -> { stream }` | page at utterance onset | none | answered | tiny | - | open an utterance on the speech-in engine (starting it if idle) |
| `AudioPort.speak(session, turnId, options?) -> { stream }` | page when its fresh turn starts (D-M11-20) or after a settings change (R5-50) | none (`Live.subscribe` is in process) | answered | tiny | - | check options; open the speech view (D-M11-4); replace this port's current playback (R5-44) |
| `AudioPort.close()` | page on unload, tests | none | answered | tiny | - | close the socket (`audioCloseCodes.portClosed`) and every stream |

A port lives until its socket closes, `close()` is called, or its token is not used within
`audioTimeouts.tokenMs`; nothing outlives the incarnation. A rejection answers a fixed text from
`speechTexts`/`speechTextOf` (R5-41 texts word for word) and opens no stream.

### 3.3 Adapter-internal objects (types in `AH/speech/engine-types.js`)

| object | made by | what it does |
|---|---|---|
| `SpeechHost` (`AH/speech/host.js` `makeSpeechHost({ context, kinds, options })`) | the extension, once per `GatewayContext` | owns the settings cache, the engines (by kind, per settings revision), the ports and their tokens, the `Speech` exo, the route handlers; `stop()` closes all |
| `SttEngine` (`stt-process.js` W11.1, `openai-audio.js` W11.4) | the host, lazily | utterances; resident engine with respawn on next use (R5-15) |
| `TtsEngine` (`tts-process.js` W11.2, `openai-audio.js` W11.4) | the host, lazily | catalogue (`voice-catalogue.js` for `process`), one `Synthesis` per playback |
| `SpeechText` (`speech-text.js`, W11.3) | one per playback | R5-35..R5-37 |
| `TurnSpeechView` (`turn-view.js` `openTurnView(options)`, W11.3) | one per `speak` | R5-34 over a `Live` subscription |
| `Playback` (`playback.js`, W11.5) | one per `speak`/`replay` | text source -> `SpeechText` -> `Synthesis` -> PCM frames; backlog bound; one per port at a time |
| child engine (`child-engine.js` `makeChildEngine`, W11.1, exported for W11.2) | engines of the `process` kind | spawn with `engineEnvironment` only, a ready line, a bounded line reader (`engineLineBytes`), respawn on next use, `engineRestart` pacing, SIGTERM then SIGKILL after `killGraceMs` |

Engine options are the host's `options.timeouts` and `options.limits` (defaults from
`audioTimeouts`/`audioLimits`); tests pass smaller values. That is the only test lever: no product
branch only tests take (review rule 4).

### 3.4 What M11 takes from earlier milestones (exact)

| from | object.method / module | used by |
|---|---|---|
| M1b `Live` (`AH/live-service.js`) | `subscribe(session, rev?)` -> `LiveSubscription` `next()`, `close()`; deliveries `snapshot`, `delta`, `tool_call`, `final`, `end`, `abort` (`guest/lib/interfaces.js` `VatEvent`, `DeltaEvent`, `SnapshotEvent`) | `turn-view.js` |
| M1b `Content` | `read(blob, { offset, maxBytes })` in process (pages of at most `blobPageBytes`) | `turn-view.js` (staged final), `Speech.replay` (Blob pieces) |
| M3 gateway registry | `GatewayExtension` `services`, `routes` (`upgrade`, `http`), `largeCalls`; `GatewayContext` `live`, `content`, `whenAttached`, `log`, and (seam H6) `operator()` for every extension, `readGrant(grant)` for the speech extension only; `markNeverLeaves` | `GW/extensions/speech.js`, `host.js` |
| M3 server | `GatewaySocket` (`send`, `close`, `onMessage`, `onClose`, `address`) through the `accept` seam (H5) | `route.js` |
| M3 UI | `UiFeature` slots `composer.addon`, `app.panel`, `message.renderer`; `FeatureContext` `powers`, `extra(label)`, `controller`, `call`; controller actions `send`, `setInput`, `replaceInput`, `selectSession`, state `view` | `UI/src/voice/` |
| M2 `Session` | `getSubmissionReceipt(requestId)` (receipt `turnId`/`turn`); `Turn.getStatus()` (`turnId`) | the voice feature (D-M11-20) |
| M2/M5 factory | the internal `create(options)` with `spoken`, `preset`, `backend`, `modelId`, `title`, `at`; rows `ofSession`; settings `defaultBackend()`, `defaultModelId()`; `Backend.resolveModel(modelId)` | `voice.js` |
| M5 presets | `PresetCatalogKit.builtIn(label)`, `recordOf(preset)`, `facet.configuration().revision`, `texts.presetStale`; `Preset.save` (provisioning pins the `voice` preset's backend and model) | `voice.js`, `70-voice.js` |
| M5 prompt | `spoken: true` selects the spoken introduction (R5-52) | nothing to add |
| M2 secrets | `secrets().readKey(grant)` (in process, one sink call per grant per incarnation) | seam H7, `openai-audio.js` |
| providers | `AH/providers/http.js` `providerBaseUrl`, `requestSignalOf`, `bodyChunks`, `boundedChunks`, `HttpFailure` (imported, not copied: review rule 3) | `openai-audio.js` |

**Assumptions W11.9 verifies:**

- A-1. `Live.subscribe(session)` from inside the adapter, with a `Session` presence a page passed
  through CapTP, finds the same channel as the page's own subscription (the registry keys by
  presence identity, A-2 of M3).
- A-2. The factory's `create` resolves in the crank that finishes the row, so a claim written in
  the continuation is in the same crank (if not, K11-4's window is one crank wider; the limit
  stays "at most one extra listed session").
- A-3. A page can pass a gateway-local `AudioPort` as the first argument of `Speech.replay` (both
  gateway-local, M3 4.4 rule 2 allows it).
- A-4. `Content.read` of a Blob staged for a session works for the adapter's own caller after a
  restart (the Blob is resolved in a batch by the manager, D-15).
- A-5. The extension loader's `require` of `GW/extensions/speech.js` and `AH/index.js`'s `import`
  of it answer the same `gatewayExtension` object (D-M11-22); W11.5 proves it first, in
  `gateway-speech-extension.test.js`, before building on it.

---

## 4. The audio socket (`AH/speech/route.js`, W11.5; client `UI/src/voice/audio-socket.js`, W11.6)

Frame layout, kinds, close codes, numbering: `audio-protocol.js`. Rules:

- **Upgrade.** `GET /audio` with `Upgrade: websocket`. The gateway server checks the path and
  Origin exactly as for `/ws` (M3 4.2), then calls the route's handler with an `accept` function
  (seam H5) that does the handshake and the connection counts (`maxConnections`,
  `connectionsPerAddress`; an audio socket counts like any other) and answers a `GatewaySocket`.
- **HELLO.** The first frame must be HELLO with exactly 32 token bytes, within `helloMs`. The token
  is compared in constant time against the port's (a `Map` from token digest to port; digests,
  never tokens, are kept). Unknown, used or expired: close `tokenRefused`. A port binds one socket
  once; the token is then forgotten. The server answers READY with `{ speechIn, speechOut,
  sampleRate: 16000, audioFrameBytes }`.
- **Streams.** Numbers are server-chosen: odd for utterances, even for playbacks, from
  `streamNumbers.first`, wrapping before `max` while skipping numbers still open. A frame for a
  number that is not open on this socket, a reserved byte not 0, an unknown kind, or any frame
  before HELLO closes the socket with `protocol`. An AUDIO payload over `audioFrameBytes` aborts
  that stream with `frameTooLarge` (the socket stays).
- **Utterance.** `transcribe()` -> `{ stream }`; the page sends AUDIO frames (pre-roll first),
  then END or ABORT. The server sends EVENT `phase: listening` at once, EVENT `partial` (whole text)
  as the engine reports, `phase: transcribing` after END, then `final` and `end`, or `abort` with a
  reason. ABORT from the page, or the socket closing, aborts the utterance (R5-17).
- **Playback.** `speak(...)` or `replay(...)` -> `{ stream }`; the server sends EVENT `phase:
  synthesizing`, PCM frames, `sentence-failed` for a skipped sentence, then `end` or `abort`. ABORT
  from the page stops it: synthesis is killed, the speech view closed, the turn untouched (R5-47).
  A newer playback on the same port aborts the older with `replaced` (R5-44).
- **Backpressure.** The server pauses a playback's engine while the socket's queued bytes exceed
  `pcmBufferedBytes` (`GatewaySocket.bufferedBytes()`, part of seam H5) and resumes on drain; the
  server's own 8 MiB send bound (M3) is never reached by PCM.
- **Close.** The socket closing closes the port and its streams; `AudioPort.close()` closes the
  socket with `portClosed`; the host's `stop()` with `serviceStopped`.

---

## 5. Bounds, events and timeouts

### 5.1 Vat-facing bounds (appendix A)

Preferences: `voice` at most 128 units (R5-54), numbers finite and in `ttsRanges`. Invocation id
at most 128 units; 32 claims. Speech settings: commands at most 32 arguments of at most 4,096
units; texts at most 2,048 units; 64 provider voices; the whole record at most `frameBytes - 2,048`
estimated bytes.

### 5.2 Audio bounds

`audio-protocol.js` `audioLimits` (each one bounds retained state or one message): 64 KiB per
AUDIO and PCM frame, 16 KiB per EVENT, 4 streams and 2 utterances per port, 64 ports, 300 s of
audio per utterance (then END semantics: the final follows and `utteranceTooLong` is reported as a
`phase` note in the `end` event), 2 MiB engine backlog, 1 MiB queued PCM, 1 Mi units of sentence
backlog, 1,000-unit forced sentence cut, 64 KiB engine lines, 64 replay pieces, 2 speech views per
session.

### 5.3 `SpeechEvent` (EVENT and READY payloads; JSON, adapter to browser only)

| type | fields | when |
|---|---|---|
| (READY) | `speechIn: boolean`, `speechOut: boolean`, `sampleRate: 16000`, `audioFrameBytes` | after HELLO |
| `phase` | `phase`: `listening`, `transcribing`, `synthesizing` | progress |
| `partial` | `text` (the whole transcript so far) | utterance |
| `final` | `text` | utterance, after END |
| `sentence-failed` | `index` | playback: a sentence was skipped (D-M11-10) |
| `end` | `note?` (`utteranceTooLong`) | either: the stream is over |
| `abort` | `reason` (a `speechTexts` value) | either: the stream is over |

### 5.4 Timeouts

`audioTimeouts`: `helloMs` 5,000; `tokenMs` 30,000; `sttIdleMs` 30,000; `engineTimeoutMs` 10,000;
`synthTimeoutMs` 10,000; `engineLoadMs` 600,000; `killGraceMs` 2,000. The host's settings cache
lives `settingsMaxAgeMs` 60,000 (a host option, default in `host.js`). "Engine output" for
`engineTimeoutMs` is any line for that utterance; the timer runs while at least 1 s of audio was
sent since the last output, and from END until the final.

---

## 6. Speech engines

### 6.1 Kinds and settings

The factory's `SpeechSettings` (appendix A) chooses, per direction, `{ kind: 'off' }`, `{ kind:
'process', ... }` or `{ kind: 'openai-audio', ... }`. `AH/speech/kinds.js` (W11.5) maps a kind to
its engine maker; an unknown kind is refused when the host reads the settings (the guard admits
only these three). A settings `revision` change makes the host drop idle engines at once and busy
ones when their last stream ends; the next use starts the new one.

### 6.2 `process` (W11.1 speech in, W11.2 speech out)

- **Speech in.** `command` (argv; default in the provisioning step: `uv run --quiet
  <AH>/speech/engines/moonshine_daemon.py --lang <language>`) spawned by `child-engine.js` with the
  `engineEnvironment` allowlist, stdio pipes, cwd the adapter's state directory's `agent-host/`.
  Ready when the engine prints `{"event":"ready"}`. Utterance `n` is engine stream `u<n>`. PCM
  is sent as base64 in `stream_audio` lines as it arrives (no merging needed: frames are pushed).
  An `error` reply aborts the utterance with `engineFailed`; the engine's text is logged by kind
  only. The engine is warmed when the host first reads settings with `warm: true` (R5-15) and kept;
  it is killed when the settings change or the host stops. A dead engine is respawned on the next
  `open` (R5-15), paced by `engineRestart`. A start failure is logged and does not touch speech out
  (R5-58).
- **Speech out.** `command` is the Piper binary (argv prefix); the voice catalogue is
  `voicesDir`'s `<id>.onnx` + `<id>.onnx.json` pairs whose `audio.sample_rate` parses (R5-40;
  broken ones skipped, at most 128). An unusable `defaultVoice` turns speech out off with a warning
  in `configuration()` (R5-40, R5-58). One Piper process per playback, started at the first sentence
  (R5-38), args from `CheckedTtsOptions` (`piperFlags`); each sentence one line; stdout read as raw
  s16le, whole samples forwarded (odd byte carried: Endo `takeWholeSamples`); at `end` stdin is
  closed and the process waited for. A sentence with no PCM within `synthTimeoutMs`: the process is
  killed, `sentence-failed`, and the next sentence starts a new process. The warm spare (D-M11-12)
  is a process started with the shared preferences' options and no input yet.

### 6.3 `openai-audio` (W11.4)

- Base URL checked by `providerBaseUrl` (`https:`, or `http:` to loopback; no user info, query or
  fragment). The key, when the settings carry a `key` grant, is read with `context.readGrant(key)`
  at each request and sent as `Authorization: Bearer`; it is never logged, never in an error text,
  never in an event.
- **Speech in:** at END, `POST /audio/transcriptions` (multipart: a WAV of the utterance, `model`,
  `language`, `response_format=json`), answer `{ text }` read with `answerBytes` bound. Partials:
  while the utterance is open, every `partialIntervalMs` (default 1,500) re-post the audio so far
  if it changed and is under `partialMaxBytes`, one request in flight per utterance; a partial
  answer older than a newer one is dropped. 401/403 abort with `engineFailed` and a log line
  `speech-engine-failed` with the status; 429 and 5xx abort the utterance (no retry: the user is
  waiting).
- **Speech out:** per sentence `POST /audio/speech` `{ model, input, voice, speed,
  response_format: 'pcm' }`, body streamed as PCM at `pcmSampleRate` (24 kHz); sentences are
  requested one after another (the next is requested when the previous body ends, so audio keeps
  flowing while the client plays); the catalogue is the settings' `voices` (ids as names, sample
  rate 24,000); `noiseScale`, `noiseW`, `sentenceSilence` are accepted and ignored; speed is
  clamped to the provider's range.

### 6.4 Settings read

`host.js` keeps `{ settings, revision, readAt }`. It reads `E(voice).speechSettings()` (the
`Voice` presence from `E(context.operator()).getVoice()`, kept for the incarnation) on the first
`openAudio`, `configuration` or `status`.
Both `openAudio` and `configuration` refresh settings older than `settingsMaxAgeMs`.
This lets a reconnected page discover newly enabled speech while both controls are disabled.
After a failed read, `status().error` holds the reason and either call retries.

---

## 7. The speech view of a turn (`AH/speech/turn-view.js`, W11.3)

Port of Endo `turn-speech.js` onto the harness channel (R5-34):

1. `subscribe(session)` (no `rev`): the first delivery is the snapshot. If `snapshot.turn.turnId
   !== turnId`, close and reject `turnNotLive` (the turn is older, or not yet started; the page calls
   `speak` only after it saw the turn start). More than `speakViewsPerSession` open views on the
   session: reject `tooManyViews`.
2. From the snapshot: the text of every message with `role: 'assistant'` in `status.messages`,
   joined with newlines, then `status.streamingText`. If `turn.settled`: then `end`.
3. Then, for deliveries of this `turnId`: `delta` -> `text(delta.text)`; `tool_call` ->
   `lineBreak()`; `final` -> the part of the final text not yet spoken for this round (the final's
   text, read through `Content` when staged, minus the round's spoken prefix; nothing if it does not
   start with it); `end` -> `end()`; `abort` -> `end()` (R5-34: a closing abort counts as end).
   `phase`, `usage`, `tool_result`, thinking (`role: 'thinking'`) are not spoken. Deltas of another
   `turnId` are ignored.
4. A closed subscription (`closed: true`) before `end`: `abort(speechTexts.turnNotFound)`.
5. `close()` closes the subscription; the turn is never touched.

`SpeechText` (R5-35..R5-37): code fences of 3 or more backticks or tildes with an info string are
removed incrementally across chunks, holding back only a possible fence at a line start; a closing
fence at least as long as the opening; only a line's first 128 units inspected. Then per chunk:
remaining fences become a space, inline code its content, images go, links become their text,
bold, italic, heading, blockquote and bullet markers go. A boundary is a newline, or `.`, `!`, `?`
followed by whitespace, except after St, Dr, Mr, Mrs, Ms, Prof, vs, etc, Jr, Sr or a numbered-list
marker; a sentence is released only when the whitespace after it arrives; a chunk under 10 units
merges with the next; a run of `sentenceUnits` with no boundary is cut at its last whitespace
(D-M11-11); the rest is flushed at `finish`.

---

## 8. What persists where; restart and SIGKILL

| state | lives in | clean restart | SIGKILL |
|---|---|---|---|
| voice preferences, shortcut preset, speech settings | factory heap | kept | old or new value: each write is one crank |
| launch claims (32) | factory heap | kept | as below (K11-4, K11-5) |
| the spoken flag and prompt of a session | session record (M5) | kept | kept |
| a voice message once submitted | session queue (M2 receipts) | kept | M3 K3/K4: the page resends its draft by request id; one entry |
| ports, tokens, sockets, streams, speech views, engines, warm spare, settings cache | agent-host adapter memory | lost by contract; pages reconnect and open a new port | same; engines exit at stdin EOF (D-M11-15) |
| a partial transcript in the compose box | the page (the controller's draft once typed into the box, `localStorage`) | the page keeps it across a reconnect; not sent unless the grace send happened | same |
| device settings cache, auto-speak | browser (`localStorage` key `thix-voice:settings`; auto-speak in page memory, R5-55) | kept / reset per page | same |
| engine caches (uv, weights, voices) | the engines' own directories, outside the state directory | kept | kept |

**Kill points** (SIGKILL of the supervisor process only, architecture 10; each is a test in
`test/integration/voice-restart.test.js` unless noted):

| id | where | after restart |
|---|---|---|
| K11-1 | during an utterance (audio streaming) | within 5 s no engine process of the old incarnation is alive (`processesUnder` and the fake engines' pid files); the page reconnects, opens a new port; the compose box still holds the last partial; nothing was submitted; 0 vat deliveries came from the utterance |
| K11-2 | during playback of a live scripted turn | the turn is recovered by M2 (`outcome-unknown` or settled); no Piper or fake TTS process alive; no automatic re-speak (O-7); Replay works |
| K11-3 | inside `setPreferences` (between the request and its answer) | `getPreferences` answers the old or the new record, never a mix |
| K11-4 | `startVoiceSession` with an id, killed after the claim crank and before the creation finished | the factory's start listener completes or rolls back the half-made creation (D-5); a redelivered launch with the same id re-runs creation (claim of an older start count): at most one extra listed session, never two claimed (owner question O-8) |
| K11-5 | after the creation and the claim, before the page received the answer | the redelivered launch answers the same session with `duplicate: true` |
| K11-6 | after the auto-send's `Composer.submit` staged the text, before the enqueue (M3 K3) | the page's draft resend makes exactly one transcript entry |

---

## 9. The browser client (`UI/src/voice/`, W11.6 modules, W11.8 feature)

- **Capture** (`capture.js`, `AH/speech/capture-worklet.js`): `getUserMedia({ audio:
  captureConstraints })` (R5-3), an `AudioContext`, the worklet from `CAPTURE_WORKLET_PATH`
  (served by the extension, so CSP `script-src 'self'` admits it), which resamples to 16 kHz,
  converts to s16le and posts blocks of 1,360 samples with their RMS. The mic is off until tapped
  (R5-55); audio is unlocked inside the tap (R5-44).
- **Endpointing** (`endpointing.js`, pure: `makeEndpointer(defaults) -> { block(rms, atMs) ->
  Decision }`): calibration window then floor at the 75th percentile; threshold max(minimum, floor x
  multiplier); floor drift while quiet; onset opens an utterance (cancels a pending grace send,
  stops playback, sends the pre-roll first); trailing silence sends END; shorter than minimum speech
  aborts; while a turn is busy the barge-in threshold applies, times the echo factor while the
  page's own speech is audible (R5-31, R5-32, R5-46); invocation mode skips calibration (R5-23).
  The detector pauses while the page is hidden (R5-19). Junk finals are dropped (R5-21). Kept text
  appends to the pending utterance in the compose box (`controller.replaceInput`), stays editable;
  after the grace with no new speech the box's text is sent with `controller.send` if the mic is
  still on, the request current and no utterance open; clearing the box cancels (R5-22).
- **Playback** (`playback.js`): each PCM frame decoded at its rate (0 means 22,050 Hz) and
  scheduled at max(now, end of the previous); a new playback stops the previous; `audible()` for the
  echo factor; mute stops the current reply (R5-48); Stop cancels the turn and stops playback.
- **Fresh turn and auto-speak** (D-M11-20): on the controller's submission notice (H10) the feature
  keeps `{ session, requestId, receipt }` for the active session; a `started` receipt gives
  `turnId` (or `E(receipt.turn).getStatus()`), a queued one is resolved by one
  `getSubmissionReceipt(requestId)` after the session's next `turn-start`; then `speak(session,
  turnId, options)` if auto-speak is on and speech out is configured. Barge-in aborts the playback
  stream (the turn continues, "continuing in background…" is shown, R5-46) and the new utterance's
  send queues behind the running turn (R5-47).
- **Settings** (R5-55): server preferences, then the device cache, then the service defaults
  (`configuration().defaults`), then `ttsDefaults`; a change is debounced 300 ms, written with
  `setPreferences`, and a running playback restarts from the beginning with the new options (R5-50).
- **Slots** (M3 6.2): `voice.controls` in `composer.addon` (mic, speaker, level meter with floor
  and threshold markers, Talk), `voice.panel` in `app.panel` (label "Voice": spoken replies, voice,
  Speed, Expression, Phoneme variation, Sentence pause, Voice shortcut preset), `voice.replay` in
  `message.action` (Play the selected assistant message, including staged text).
  Talk calls `startVoiceSession`, selects
  the answered `key`, shows `warning`, and opens the mic.
- **Launch link** (R6-60 without Android): a fragment parameter `voice=<invocation id>` (beside
  `gateway` and `agent`, never a query; M3's parser ignores it, the feature reads
  `globalThis.location.hash` itself) makes the page call `startVoiceSession({ invocationId })`
  once after sign-in and record at once in invocation mode.
- **Wake lock** (P-66): `navigator.wakeLock.request('screen')` while the mic is on, a playback is
  audible or the active turn is busy; released otherwise and re-requested on visibility.
- **State** (D-M11-13): one closure per page from `makeVoiceFeature()` holding a `WeakMap` keyed by
  `context.powers`: port, socket, playback, endpointer, receipts waiting for their turn, auto-speak.

---

## 10. Security

| principal | can reach | cannot reach |
|---|---|---|
| a page with the sign-in secret (the operator, R7-2) | `Speech`, its own `AudioPort`s, `Voice` through the `Operator` (preferences, shortcut preset, launch, a read of the speech settings); any session's speech by passing that `Session` | another page's port (its token is single use and never shared); writing the speech settings or any engine command line (D-M11-21: only `HarnessRoot.configureSpeech`); the provider key value |
| provisioning and the administration CLI (`HarnessRoot`) | `HarnessRoot.configureSpeech`, and everything a page reaches | - |
| a gateway extension other than `speech.js` | the plain `GatewayContext` | `readGrant` (D-M11-22) |
| an `/audio` socket without a valid HELLO | nothing: closed after `helloMs` | - |
| a model (session vat, exec vat) | nothing of M11 (no session holds `Voice`, `Speech` or a port) | every speech object (`thix reachability` from a session vat in `voice-session.test.js`) |
| engines | their own stdin/stdout or HTTP | vats, the hub, the gateway |

- The provider key never enters a vat, the hub, a log, an event or an error: read through the
  grant in process per request (D-6); `assertNoSecretInState` after a clean stop finds no encoding
  of it (acceptance 15).
- Transcripts in progress and synthesized audio never leave the adapter except to the page that
  owns the stream; the server logs counts and kinds only (`speechLogEvents`).
- Tokens are 256 random bits, single use, valid 30 s, compared as SHA-256 digests in constant time.
- Process engines get only the allowlisted environment; their command is configuration written on
  the provisioning path only (D-M11-21), never by a page.
- Origin is checked on `/audio` as on `/ws` (W-1).

---

## 11. Seams and merge hotspots

Every edit M11 makes to a file another lane or step may also edit. Everything else is new files in
M11's own directories (`AH/speech/`, `UI/src/voice/`, `guest/factory/voice.js`,
`scripts/provision-steps/70-voice.js` (cross-check X-09: M6 holds `60-`), `test/**/speech-*`,
`test/**/voice-*`, `perf/voice*.mjs`, `test/fixtures/{fake-stt,fake-tts,fake-speech-server,
voice-clip}.mjs`, `test/fixtures/voices/`).

Anchors are the step-3 code as built in the cleanup lane at `cecfa12809` (read at the settle
unit); none is provisional any more. "WX.1" is the cross-lane seam unit (cross-check X-02): it
runs after step 3 merges and before any lane unit, and applies the entries named here in one
commit with the other lanes'. No M11 unit edits a file WX.1 edits.

| id | file | the seam (exact) | other editors | unit |
|---|---|---|---|---|
| H1 | `guest/lib/guards/factory.js` | appendix A: one import line; shape builders `VoicePreferences`, `VoicePreferencesPatch`, `VoiceSessionRequest`, `VoiceSessionAnswer`, `SpeechInSettings`, `SpeechOutSettings`, `SpeechSettings`; interface builder `Voice`; `getVoice` in `Operator`; `configureSpeech` in `HarnessRoot`; `Voice`, `getVoice` and `configureSpeech` in the method-name lists | M9 F6 (`getMail` in `Operator`, `HarnessSettings` fields), M6 (presets, `HarnessSettings.environments`), step 3 SESSION (`HarnessStatus.error`, built) | **WX.1** (done there; W11.7 starts from it) |
| H2 | `guest/factory/factory.js` | in `makeFactoryKit`: the import `import { makeVoice } from './voice.js';`; one line right after the local `createSession` (l.361-362): `const voice = makeVoice({ catalog, create: createSession, rows, settings: harnessSettings, starts });`; in the `Operator` exo (l.420): `getVoice: () => voice.facet,`; in the kit's return record (l.539): `configureSpeech: voice.configureSpeech,` | M9 F1 (three lines after `deletions`, `getMail` in `Operator`, two `recover()` lines), M6 | W11.7 |
| H2b | `guest/factory/main.js`, `guest/factory/root.js` | `main.js`: in the `makeHarnessRoot({...})` call, `configureSpeech: kit.configureSpeech,`; `root.js`: `makeHarnessRoot` takes `configureSpeech` (optional; absent, the method throws `voiceTexts.speechNotWired`, as `NO_POOL_TEXT` does for the pool) and the exo gains `configureSpeech: settings => needSpeech()(settings),` | M6 F-5 (`makeHarnessSettings` in `root.js`, another function of the file) | W11.7 |
| H3 | `guest/lib/vocabulary-tables.js` | `import * as speech from './speech-guards.js';` and `{ file: 'speech-guards.js', patterns: () => speech.vocabularyShapes() },` | M9 V1 (two entries), M6 (one exclusion line, X-11 (a)) | **WX.1** |
| H4 | `test/adapter/gateway-vocabulary-tables.test.js` | the pin (258 keys, 141 methods) re-pinned once for all lanes' entries, M11's being appendix A and `speech-guards.js` | M6, M8, M9 | **WX.1**; WX.F re-measures once |
| H5 | `GW/server.js` | in `server.on('upgrade', ...)`, after the Origin check: the block from `const key = request.headers['sec-websocket-key']` to `if (head && head.length > 0) made.receive(head);` moves, unchanged, into a local `accept(request, raw, head, { maxMessageBytes, onSocket })` that answers the `GatewaySocket` or `undefined` (refused; the refusal written and logged as today); `/ws` calls `accept(request, raw, head, { maxMessageBytes: bounds.wsMessageBytes, onSocket })`; the route call `route.handle(request, raw, head)` becomes `route.handle(request, raw, head, accept)`; `makeWebSocket`'s socket gains `bufferedBytes: () => raw.writableLength`. The path, Origin and close-code checks (HR-SYN-35, built) stay where they are | none in the group (M8 names `server.js` as untouched) | W11.5 |
| H6 | `GW/index.js`, `GW/extensions.js`, `GW/protocol.js` | `index.js`: `makeGatewayService` option `extensionPowers` (default `[]`, a list of `{ extension, powers }`); the `operatorOf` holder moves from `bind` to the service closure, `bind` sets `operatorOf.current = config.operator` as today; `context` gains `operator: () => operatorOf.current`; `incarnationParts` passes `contextFor` instead of `context` to `makeExtensionServices` and `makeLargeCalls`, where `contextFor(extension)` answers, once per extension and kept, `harden({ ...context, ...powers })` for the extension whose object is listed and `context` for every other. `extensions.js`: those two functions take `contextFor` and call `make(contextFor(extension))`, `largeCall.target(contextFor(extension))` (the built-in entries keep `context`). `protocol.js`: `GatewayContext.operator`, an optional `readGrant`, `ExtensionPowers` typedefs, `GatewayRoute.handle`'s fourth parameter (H5) | none known | W11.5 |
| H7 | `AH/index.js` | the import `import { gatewayExtension as speechExtension } from './gateway/extensions/speech.js';` and, in the `makeGatewayService({...})` call (l.439-453), `extensionPowers: [{ extension: speechExtension, powers: { readGrant: grant => secrets().readKey(grant) } }],` (`secrets().readKey` as the API backends use it, l.264) | M8 W8.3 (S-14, S-18: `adapterTools` and the open handler, other blocks of the file) | W11.5 |
| H8 | `scripts/test-integration.mjs` `regressionLists` | an `M11` list: `voice-session`, `voice-restart`, `voice-speak`, `voice-provider`, browser `voice-ui` (M11's own list, not the core list: X-14) | M6 K-2, M8, M9 | W11.9 |
| H9 | `perf/_pass.mjs` `perfLists` (PM-merged) | `M11: ['voice', 'voice-session']` | M6, M8, M9 | W11.9 |
| H10 | `UI/src/controller/index.js` | in `send`, after `sendThroughChain` answered: notify submission listeners `{ sessionKey: key, session, requestId, receipt }`; a controller action `onSubmission(listener) -> unsubscribe` (a `Set` in the closure, cleared on reconnect); 10-15 lines | none in the group; M12 (Home, spaces) and step 5 (a) later | W11.8 |
| H11 | `H/package.json` (PM-merged) | test drivers use the `ws` devDependency to avoid pooled socket cleanup in Node 24 under SES. Production and browser code use their existing WebSocket implementations | all | - |
| H12 | `GW/extensions/README.md` | the `GatewayContext` table gains `operator()` (every extension) and `readGrant(grant)` (only the extensions given it through `extensionPowers`); a `speech.js` row in the file list | none known | W11.9 (one owner: W11.5 writes no README line) |

Not edited by M11: `AH/channel-taps.js`, `AH/projection-hooks.js`, `guest/session/**`, the turn
runner, `AH/channels.js`, the manager part (`resources/agent-host/*.js` outside `impl/`), M3's
`GW/bridge.js`, `guard.js`, `vocabulary.js`, `UI/src/features.js`, `UI/build.mjs`.

---

## 12. Work units

Units in one row group run in parallel and own disjoint files. "After" names the commit a unit
needs before it starts; every unit's tests are listed by file. All units start after step 3 has
merged and WX.1 has committed the shared entries (H1, H3, H4). Journal numbers: W11.0 (this
contract and its settle unit) used J-1310..J-1329; every build unit's range is **PM assigns**
(a block per unit large enough for a builder, 30 or more; ten inside J-1310..J-1329 is not).

| id | files owned | behaviour | tests | after | journal |
|---|---|---|---|---|---|
| W11.1 speech in, `process` | `AH/speech/child-engine.js` (exported for W11.2), `AH/speech/stt-process.js`, `AH/speech/engines/moonshine_daemon.py` (Endo's, unchanged but its header), `test/fixtures/fake-stt.mjs` | section 6.2 speech in; timeouts `sttIdleMs`, `engineTimeoutMs`, `engineLoadMs`; backlog and utterance bounds; respawn and pacing; exit at stdin EOF | `test/adapter/speech-child-engine.test.js`, `test/adapter/speech-stt-process.test.js` (fake modes of appendix B; `[real-moonshine]` cases gated by `THIX_HARNESS_REAL_SPEECH=moonshine`) | WX.1 (commit `child-engine.js` first) | PM assigns |
| W11.2 speech out, `process` | `AH/speech/tts-process.js`, `AH/speech/voice-catalogue.js` (`readVoiceCatalogue(dir)`, `checkTtsOptions(options, catalogue)`), `test/fixtures/fake-tts.mjs`, `test/fixtures/voices/` | section 6.2 speech out; R5-38..R5-43; `synthTimeoutMs`; warm spare; backpressure through `PlaybackSink.drained` | `test/unit/speech-voice-catalogue.test.js`, `test/adapter/speech-tts-process.test.js` (`[real-piper]` gated by `THIX_HARNESS_REAL_SPEECH=piper`) | W11.1's `child-engine.js` commit | PM assigns |
| W11.3 speech text and speech view | `AH/speech/code-filter.js`, `AH/speech/speech-text.js`, `AH/speech/turn-view.js` | section 7 | `test/unit/speech-text.test.js` (Endo's cases ported), `test/adapter/speech-turn-view.test.js` (real `channels.js` and `live-service.js`, sessions as `makeExo` with the real `Session` guard, staged final through a real blob store) | WX.1 | PM assigns |
| W11.4 speech provider, `openai-audio` | `AH/speech/openai-audio.js`, `test/fixtures/fake-speech-server.mjs` | section 6.3; key through `readGrant` per request | `test/adapter/speech-openai-audio.test.js` (fake server on 127.0.0.1: partial and final, PCM per sentence, 401, 429, 500, hang, slow body; `[real-provider]` gated by `THIX_HARNESS_REAL_SPEECH=provider` with a key file) | WX.1 | PM assigns |
| W11.5 host, route, extension | `AH/speech/host.js`, `AH/speech/kinds.js`, `AH/speech/route.js`, `AH/speech/playback.js`, `GW/extensions/speech.js`; seams H5 (`GW/server.js`), H6 (`GW/index.js`, `GW/extensions.js`, `GW/protocol.js`), H7 (`AH/index.js`) | sections 3.2, 4, 5, 6.1, 6.4; D-M11-22 (A-5 proved first); marks `Speech` and ports never-leaving; `largeCalls: [{ target: c => hostOf(c).speech, methods: ['replay'] }]` (`hostOf` a `WeakMap` by context in the extension module; the `/audio` route, which receives no context, reaches the one host of the process through the same module closure); serves the worklet file | `test/adapter/speech-audio-route.test.js` (Node `WebSocket` client against `makeGatewayServer` with the extension route), `test/adapter/speech-host.test.js` (settings from a `Voice` exo built with the real guard), `test/adapter/speech-timeouts.test.js`, `test/adapter/gateway-speech-extension.test.js` (loads with zero skips; vocabulary keys present; A-5; another extension's context has no `readGrant`) | WX.1 (uses in-test engines of `engine-types.js` until W11.1-W11.4 land, then the real ones) | PM assigns |
| W11.6 client audio modules | `AH/speech/capture-worklet.js`, `UI/src/voice/{capture,endpointing,audio-socket,playback,wake-lock}.js` | section 9 capture, endpointing, socket client, playback, wake lock | `test/unit/voice-endpointing.test.js` (synthetic level sequences: calibration, 400 ms burst, junk, silence 1,200 ms then grace 800 ms, speech during grace, barge-in and echo factor, invocation mode), `test/unit/voice-audio-socket.test.js` (frame encode and decode against `audio-protocol.js`), `test/unit/voice-playback.test.js` (scheduler with a fake clock) | WX.1 | PM assigns |
| W11.7 factory `Voice` | `guest/factory/voice.js`, `scripts/provision-steps/70-voice.js`; seams H2 (`factory.js`), H2b (`main.js`, `root.js`) | section 3.1, D-M11-21, D-M11-25; the step: `options.voice = { speech?: SpeechSettings-like data with a key label, voiceBackend?: label, voiceModelId? }`: `HarnessRoot.configureSpeech` (the key's `Secret` found by label in `SecretsAdmin.list`, its `makeReadGrant()`) and pins the `voice` preset's backend and model with `Preset.save` (labels at the config boundary, F.2) | `test/unit/factory-voice.test.js` (with the real catalogue and guards; `configureSpeech` absent from `Voice`), `test/integration/voice-session.test.js`, `test/integration/voice-restart.test.js` | WX.1 | PM assigns |
| W11.8 voice UI feature | `UI/src/voice/{feature,state,VoiceControls,VoicePanel,ReplayButton}.js`, `UI/src/voice/voice.css`; seam H10 (`UI/src/controller/index.js`) | section 9 feature, settings, slots, fresh turn, launch link | `test/unit/voice-state.test.js` (fakes from `speech-guards.js` and appendix A guards), browser cases in W11.9's file | WX.1; W11.6's module signatures (section 9) | PM assigns |
| W11.9 integration (last) | `test/integration/voice-speak.test.js`, `test/integration/voice-provider.test.js`, `test/browser/voice-ui.test.mjs`, `test/fixtures/voice-clip.mjs`, `perf/voice.perf.mjs`, `perf/voice-session.perf.mjs`; seams H8, H9, H12 | wiring of all units; acceptance and perf below; the fold list (section 17) checked; session and exec bundles byte-identical (D-M11-24) | the files named; the M11 regression list under 20 minutes | all of W11.1-W11.8 | PM assigns |

Ownership check (each file has exactly one unit): `child-engine.js` W11.1 only (W11.2 imports
it); `openai-audio.js` both directions in W11.4; `GW/protocol.js` and `GW/extensions.js` only
W11.5 (H5 and H6 are one unit); `GW/extensions/README.md` only W11.9; `voice-session.test.js`
and `voice-restart.test.js` only W11.7 (W11.9 adds cases to its own files, not to these);
`UI/src/voice/` split by file between W11.6 and W11.8; the contract's constant files
(section 0) are read by every unit and edited by none (a needed change is reported, and the PM
assigns it to one unit).

Every integration file runs alone in under 5 minutes from a state template (milestones conventions);
every test and perf file fits the 10-minute box; the M11 regression list (H8) fits 20 minutes of
wall at six slots (estimate: 4 integration files of 90-200 s and one browser file of about 150 s).

Parallel groups: {W11.1, W11.3, W11.4, W11.5, W11.6, W11.7} at once after WX.1; W11.2 after
W11.1's first commit; W11.8 after WX.1 (it no longer waits for a W11.7 guard commit: H1 is
WX.1's); W11.9 last. Six to eight agents.

---

## 13. Acceptance (each provable by the named test; fakes everywhere)

1. Speech in: a fixed 16 kHz clip (`voice-clip.mjs`) streamed in 85 ms AUDIO frames yields
   cumulative `partial` events (each replaces the previous), then `final` after END; a trailing odd
   byte is dropped (the fake engine reports the byte count); ABORT, and closing the socket, abort the
   utterance (the fake logs `stream_abort`). `speech-stt-process.test.js`, `speech-audio-route.test.js`;
   `[real-moonshine]` repeat.
2. The speech-in engine stays loaded across utterances (one `ready`, one pid for three utterances);
   killing it makes the next utterance respawn it; a speech-in start failure is logged and speech out
   still plays. `speech-stt-process.test.js`, `speech-host.test.js`; `[real-moonshine]` repeat.
3. Text with a fenced code block (backticks and tildes, split across deltas), inline code, links and
   markdown is spoken without the code block and the markup; abbreviations and numbered lists do
   not split; chunks under 10 characters merge; a sentence waits for its whitespace.
   `speech-text.test.js`.
4. `speak` on a live scripted turn of two rounds with a tool call: the page receives PCM for the
   completed messages, then the live deltas; the tool call breaks the sentence; tool results, phases
   and usage are not spoken; the final adds only the unspoken part; speaking the last finished turn
   plays it to the end; an older turn answers `turnNotLive`. `speech-turn-view.test.js`,
   `voice-speak.test.js`.
5. Out-of-range `speed`, a non-finite number, or an unknown voice makes `speak` and `replay`
   reject with the R5-41 texts and open no stream; a broken voice is skipped from the catalogue; an
   unusable default voice turns speech out off with a warning while speech in works.
   `speech-tts-process.test.js`, `speech-voice-catalogue.test.js`, `speech-host.test.js`;
   `[real-piper]` repeat.
6. Endpointing: calibration sets the floor; a 400 ms burst is discarded; junk finals are dropped;
   1,200 ms of silence sends END and 800 ms of grace sends the message; speech during grace joins
   it; clearing the box cancels. `voice-endpointing.test.js`; in the browser with synthetic audio,
   `voice-ui.test.mjs`.
7. Barge-in during playback stops audio and synthesis (the fake TTS process is killed), shows
   "continuing in background…", the turn completes and is recorded, and the new utterance's
   message is queued behind it. `voice-ui.test.mjs`, `voice-speak.test.js`.
8. Preferences written from connection A are what connection B reads and what B's playback uses;
   a stale `setVoicePreset` revision is refused; Talk creates the session from the chosen preset.
   `voice-session.test.js`, `voice-ui.test.mjs`.
9. A session from `startVoiceSession` has the spoken introduction; a session from the new-session
   dialog has the plain one (the fake provider's request log). `voice-session.test.js`.
10. Timeouts: a hanging fake speech-in engine fails the utterance after `engineTimeoutMs` with
    `engineTimeout` and is restarted; an utterance with no AUDIO for `sttIdleMs` is aborted with
    `sttIdle`; a fake TTS that hangs on one sentence produces `sentence-failed` and the next
    sentence plays; a socket with no HELLO is closed after `helloMs`; an unused token expires.
    `speech-timeouts.test.js`.
11. Replay plays a finished turn's text again, inline pieces and a staged Blob piece alike; the level
    meter moves with input. `speech-audio-route.test.js`, `voice-ui.test.mjs`.
12. Auto-speak: a send from page A (typed or spoken) is spoken on page A when its turn starts, also
    when the message was queued behind a running turn; page B, watching the same session, speaks
    nothing. `voice-ui.test.mjs`.
13. Launch claims: `startVoiceSession({ invocationId })` twice answers one session, the second
    `duplicate: true`; after 33 distinct ids the first is forgotten; the claim survives a restart
    (K11-5). `voice-session.test.js`, `voice-restart.test.js`.
14. G-11: with the `voice` preset pinned to a model missing from its backend's catalogue (fake
    provider catalogue), `startVoiceSession` creates the session on the factory default and answers
    the `voiceModelUnavailable` warning. `voice-session.test.js`.
15. Provider key: the fake speech server receives the grant's key as a bearer; after a clean stop
    `assertNoSecretInState` finds no encoding of it; no log line contains it; a 401 aborts with
    `engineFailed`. `voice-provider.test.js`; `[real-provider]` repeat.
16. Restart: K11-1, K11-2, K11-3, K11-4, K11-5 as section 8 states. `voice-restart.test.js`.
17. Security: a socket whose HELLO carries another port's used token, a wrong token, or no HELLO is
    closed with the named code; a second socket cannot bind a bound port; `/audio` with a foreign
    Origin is refused 403; `thix reachability` from a session vat finds no `Voice`, `Speech` or port.
    `speech-audio-route.test.js`, `voice-session.test.js`.
18. The wake lock is held while the mic is on, speech plays or the turn runs, and released after.
    `voice-ui.test.mjs` (with a stub `navigator.wakeLock`).
19. Settings authority (D-M11-21): a CapTP client signed in to the gateway finds no
    `configureSpeech` on `Voice` (the guard refuses the method); `HarnessRoot.configureSpeech` from
    the provisioning step changes `Voice.speechSettings().revision`, and the speech host uses the
    new engines from its next `openAudio`. `factory-voice.test.js`, `voice-session.test.js`.
20. Key reader (D-M11-22): the speech extension's context has `readGrant`; `secrets.js`'s, and an
    in-test extension's loaded from a test directory, do not; the extension object `AH/index.js`
    imports is the one the loader loaded (A-5). `gateway-speech-extension.test.js`.
21. Engines per start (D-M11-23, R8-29): after a clean restart the speech-in engine has a new pid,
    is started only at the first `openAudio`, and uses settings written before the restart.
    `voice-restart.test.js`.
22. Talk without a usable voice preset (D-M11-25): with the `voice` preset unavailable,
    `startVoiceSession` rejects with the preset's `unavailableReason` and lists no session; with a
    user preset chosen as the shortcut it creates the session. `voice-session.test.js`.

**Cross-lane items (proved by the group fold WX.F, not by M11 alone; cross-check X-12):** the
complete built-in `voice` preset with its workspace and shell and M11's backend and model pin
(R3-13, R4-89: M6 objects plus `70-voice.js`), and Talk on a state with no environment runner
(D-M11-25 with M6's real `runnerRequired`). M11 names the test it expects WX.F to add:
`test/integration/voice-preset.test.js` (Talk from the built-in preset on a state with a fake
runner, the session's tools include the shell, the pinned model is used; then the same state
without a runner refuses).

Owner runs: `[real-moonshine]` 1, 2 and the rows `stt.*`; `[real-piper]` 5 and `tts.*`;
`[real-provider]` 15 and `provider.*`; `[real-browser]` 6, 7 with a real microphone and speakers.

---

## 14. Performance and hostile-input probes

### 14.1 Perf table

Each row is a rate or a latency over a fixed window (60 s per point, `windowMs`); median unless
stated; failing above 1.25 x blocks (milestones conventions). Measured bases: J-1310 (this unit's
probe, no supervisor): a 2,720-byte binary frame echoed through M3's hand-written server 0.055 ms
round trip (p99 0.075, n 177,638 in 10 s), the server's send 0.003 ms; base64 plus JSON encode and
decode 0.009 ms; a JSON line through a Node child pipe under 0.05 ms (median 0.022, lines may
coalesce); spawn to ready of a Node child 20.5 ms (p95 24.5, n 20). Earlier: a gateway call into a
vat 23 ms (`ui.call`, J-10192), a vat -> adapter -> vat call 70-76 ms (J-9043), a session from the
pool 849-864 ms (J-9382), a live delta to an in-process subscriber 0.17-0.20 ms (J-9173, J-10192).

| row | file | window | budget | derived from |
|---|---|---|---|---|
| `speech.audioForward`: AUDIO frame received to the engine line written | `perf/voice.perf.mjs` | 60 s at real-time pacing (about 700 frames) | median <= 1 ms, p99 <= 3 ms | 0.055 + 0.009 + 0.022 ms measured; x10 margin for parsing and timers |
| `speech.audioForward.load`: same, 16 utterances at once | `perf/voice.perf.mjs` | 60 s | p99 <= 5 ms | as above, 16 x |
| `speech.partialRelay`: engine partial line read to the client's EVENT frame | `perf/voice.perf.mjs` | 60 s | median <= 2 ms | 0.055 ms socket, 0.009 ms JSON |
| `speech.firstAudio`: delta completing the first sentence published in the channel to the first PCM frame at the client (fake TTS answers at once) | `perf/voice.perf.mjs` | 60 s (one playback per sample) | median <= 20 ms, p99 <= 50 | delta to subscriber 0.2 ms, pipe 0.05, socket 0.06; margin for the channel's microtask batching |
| `speech.engineRespawn`: fake engine killed to the next utterance's `listening` with the engine ready | `perf/voice.perf.mjs` | 60 s | <= 100 ms | spawn to ready 20.5 ms |
| `voice.deliveries` **gate row** (a count, not a rate: cross-check X-14): vat deliveries of one spoken turn (utterance, auto-send, speak, playback) minus a typed turn's, counted on every spoken turn the `voice.speakOpen` window runs | `perf/voice-session.perf.mjs` | inside the `voice.speakOpen` window (no time of its own) | 0 on every turn (any non-zero fails) | D-M11-1 |
| `voice.speakOpen`: `AudioPort.speak` from a CapTP client to its answer | `perf/voice-session.perf.mjs` | 60 s | median <= 10 ms; 0 deliveries | a gateway-local call (`gateway.fetch` 0.51 ms) plus `Live.subscribe` in process |
| `voice.preferences`: `setPreferences` round trip from a CapTP client | `perf/voice-session.perf.mjs` | 60 s | median <= 50 ms; 1 delivery | `ui.call` 23 ms |
| `voice.startSession`: `startVoiceSession` with a spare pool and a pinned model | `perf/voice-session.perf.mjs` | 60 s (few samples: reported as such) | median <= 950 ms | 864 ms pool take + 76 ms `resolveModel` |
| `voice.launchDuplicate`: second call with the same invocation id | `perf/voice-session.perf.mjs` | 60 s | median <= 50 ms | one factory crank through the gateway, 23 ms |
| `voice.settingsRead`: the host's first settings read | `perf/voice-session.perf.mjs` | 60 s (fresh host per sample) | median <= 100 ms; 2 deliveries | two factory calls of about 23-37 ms |
| `stt.partialLatency` `[real-moonshine]`: 0.5 s of new audio to the partial | gated in `perf/voice.perf.mjs` | 60 s | <= 300 ms (architecture 11; no measured basis, R5-51) | recorded |
| `stt.finalLatency` `[real-moonshine]`: END to final | gated | 60 s | <= 500 ms | recorded |
| `tts.firstAudio` `[real-piper]`: first sentence to first PCM, warm spare / cold | gated | 60 s | warm <= 1 s; cold recorded | architecture 11 |
| `provider.*` `[real-provider]`: final after END, first PCM after a sentence | gated | 60 s | recorded | - |

Time per file: `voice.perf.mjs` 5 rows x 60 s plus 30 s of setup (no supervisor) is about 6
minutes; `voice-session.perf.mjs` 5 windows x 60 s (the gate row has no window) plus a template
start (5.6 s, J-9045) is about 6 minutes. Both under the 10-minute box. `voice-session` copies the M3 gateway template
(`perf/_m3-client.mjs`) with the scripted backend; nothing is built by replaying turns.

The factory bundle grows by `voice.js` and the appendix A guards (estimate 8-12 KB over 155,427
bytes, J-10193); W11.7 records the size and `install.factory` time; the session and exec bundles
must not change (checked by `node scripts/bundle-guest.mjs` before and after).

### 14.2 Too-big and hostile-input probes (each a case in the named test)

| probe | expected | test |
|---|---|---|
| an AUDIO frame of 65,537 bytes | that utterance aborts `frameTooLarge`; the socket stays | `speech-audio-route.test.js` |
| a WebSocket message over 1 MiB | closed 1009 by the server | `speech-audio-route.test.js` |
| a frame before HELLO, an unknown kind, a reserved byte not 0, a frame for a closed stream | closed `protocol` | `speech-audio-route.test.js` |
| 1,000 sockets with wrong tokens | each closed `tokenRefused`; connection bounds hold; no port leaks | `speech-audio-route.test.js` |
| 65 `openAudio` without sockets | the 65th refused `tooManyPorts`; after 30 s all forgotten | `speech-timeouts.test.js` |
| an utterance of 301 s of audio | ended by the server, final follows, `utteranceTooLong` note | `speech-stt-process.test.js` (fake, sped-up clock) |
| a speech-in engine that falls 3 MiB behind | utterance aborts `backlog` | `speech-stt-process.test.js` |
| a fake engine printing a 10 MiB line | the engine is killed; its utterances abort `engineFailed`; respawn on next use | `speech-child-engine.test.js` |
| a page that never reads PCM | synthesis pauses at 1 MiB queued; never closed by the 8 MiB bound | `speech-audio-route.test.js` |
| a reply of 1 MiB with no punctuation or newline | cut at whitespace every 1,000 units; backlog under 1 Mi units | `speech-text.test.js`, `speech-turn-view.test.js` |
| `replay` with 65 pieces, a piece of 8,193 units, or a call body over 1 MiB | refused by the guard / the bridge | `gateway-speech-extension.test.js` |
| `speak` with a third view on one session | `tooManyViews` | `speech-turn-view.test.js` |
| `setPreferences` with `speed: NaN`, `Infinity`, `4.05`, a 129-unit voice, an extra key | refused (range text, guard, gateway `unexpectedField`) | `factory-voice.test.js`, `voice-session.test.js` |
| `HarnessRoot.configureSpeech` with 33 arguments, a 4,097-unit argument, or an estimated 22,529 bytes | refused `speechSettingsInvalid` or by the guard | `factory-voice.test.js` |
| a gateway page calls `configureSpeech` on its `Voice` presence | refused by the `Voice` guard (no such method); settings unchanged | `voice-session.test.js` |
| an extension other than `speech.js` reads `context.readGrant` | `undefined` | `gateway-speech-extension.test.js` |
| `startVoiceSession` with a 129-unit invocation id | refused by the guard | `factory-voice.test.js` |
| a provider answer of 100 KB JSON, or a body that never ends | bounded read fails `engineFailed`; request timeout | `speech-openai-audio.test.js` |

---

## 15. Core requests (CC-120 .. CC-129)

**None.** Audio never reaches a vat, the hub or the core's transports; the adapter process already
dies with the supervisor (IPC disconnect), which ends every engine through its standard input
(D-M11-15). The numbers stay reserved. If K11-1 finds an engine alive after a supervisor SIGKILL,
the harness workaround is the engines' own stdin-EOF exit plus `killStrays` in the template helper;
a core request would then be "an adapter process exits when its supervisor dies even if its IPC
channel stays open" (CC-120), with that test as the motivation.

---

## 16. Owner questions (the default is what M11 builds until told otherwise)

1. **O-1** The `openai-audio` provider kind: build it now (owner rule: providers with keys from
   grants) with partials by re-transcription every 1.5 s? [build; partials on; interval in the
   settings]
2. **O-2** Only voice-started sessions are spoken (departs from R5-52's "every UI session spoken",
   fixes the spec-digest gap). [voice-started only]
3. **O-3** The operator selected per-message playback during UAT.
   The `message.action` slot supplies the selected reply to the voice feature (J-12594).
4. **O-4** No download of Piper voices or Moonshine weights by the harness at start (R8-43): the
   operator installs voices; `uv` fetches Moonshine on first use, as Endo. [no harness download]
5. **O-5** Audio on its own binary `/audio` route instead of CapTP messages (R5-2; D-M11-3). [binary
   route]
6. **O-6** A warm spare Piper process (R5-66 improved; costs one idle process and its memory). [on]
7. **O-7** No automatic re-speak of a running turn after a reconnect (Endo loses interrupted
   replies, R5-65; the page offers Replay). [no]
8. **O-8** A launch interrupted by a restart inside the creation window may leave one extra listed
   session (K11-4); exactly once would need the claim inside the factory's creation record. [accept]
9. **O-9** The voice-shortcut preset is chosen in the Voice panel, not in the preset editor (R5-56
   names preset settings; the editor is M5's). [Voice panel]
10. **O-10** Speech keys come from API-key `Secret`s only; subscription pools have no speech API.
    [API keys only]
11. **O-11** Talk on a state with no environment runner, where the built-in `voice` preset needs a
    shell (R3-13, cross-check X-12): refuse with M6's `runnerRequired`, the Voice panel offering
    another shortcut preset; or fall back to a chat-only spoken session with a warning, as G-11
    does for a missing model? [refuse; the panel offers another preset]
12. **O-12** Engines start at first use in each incarnation instead of during every start (R8-29
    departure, D-M11-23): no resident speech-in process until a voice page opens; the first
    utterance of an incarnation waits for one model load. [first use]

---

## 17. The fold (M11's merge is the first of the group)

Merge order of the group (cross-check X-17): WX.1, the four lanes in parallel, then merge **M11
first** (it touches no `guest/session/` file and no runtime part), then M6, M8, M9, each followed
by its own fold, then the group fold WX.F. M11's fold runs right after M11's merge; F-7 waits for
M6's merge and moves to WX.F if M6 has not merged when M11's fold ends.

Done when each item is gone or checked by the grep or test named:

- F-1. `milestones.md` M11: the work-unit table, acceptance and perf rows replaced by sections
  12-14 of this file; "Owns" lists `AH/speech/`, `GW/extensions/speech.js`,
  `guest/factory/voice.js`, `guest/lib/{voice-preferences,speech-guards}.js`, `UI/src/voice/`,
  `scripts/provision-steps/70-voice.js`; the ownership-check row for {M6, M8, M9, M11} drops
  `channel-taps.js`, `gateway/routes.js` and `features.js` for M11 and names `GW/server.js`,
  `GW/index.js`, `GW/extensions.js`, `AH/index.js`, `factory.js`, `root.js` and `main.js`
  (WX.F rewrites the row for the group). Grep: `m11-audio`, `speech-code-filter`,
  `gateway/routes.js`, `60-voice` absent from `designs/` outside this contract and the journal.
- F-2. `architecture.md`: 3.1 `getVoice() -> Voice` (factory) and `HarnessRoot.configureSpeech`,
  3.3 no `speech()` on `AgentHostAdmin`, 7 the `/audio` route as built (token in HELLO) and the
  per-extension powers (D-M11-22), 11 the voice rows with this file's budgets; `m3-interfaces.md`
  6.1/6.5 `m11-audio.js` -> `speech.js` and the `GatewayContext` rows of H6.
- F-3. `speech-guards.js` tables become plain exports (`speechShapes`, `speechInterfaces`) now that
  the module is listed (WX.1, H3); the vocabulary test then guards it like the others.
- F-4. The vocabulary pin: WX.1 re-pinned it once for all lanes; M11's fold only checks that the
  merged tree still passes `gateway-vocabulary-tables.test.js` (no second re-pin by a lane).
- F-5. The voice feature's `WeakMap` by `powers` moves onto `FeatureContext` with M4's and M5's
  when step 5 (a) lands (not before: one pattern at a time).
- F-6. M13 export and import carry the `Voice` records (preferences, shortcut preset by label at the
  export boundary, speech settings with key labels) (`m13` contract). Voice keeps no state in a
  session part, so nothing of M11 is lost by a session export (cross-check X-02's part-state
  finding does not apply).
- F-7. After M6 merges: the built-in `voice` preset is available; acceptance 8, 13 and 22 rerun with
  it instead of the test's user preset; WX.F adds `voice-preset.test.js` (section 13, cross-lane).
- F-8. No `notBuilt`, no test-only branch, no in-test engine left in `AH/speech/` (grep `for tests`,
  `notBuilt`); `corepack yarn lint:duplicates` at or under the ceiling (the moved Endo chunker and
  filter are not copies of harness code).
- F-9. Seams re-checked against step 3's merge commit: the anchors of H2, H5 and H7 (section 11,
  read at `cecfa12809`) still name the same blocks; a moved block is re-anchored in this file.
- F-10. Session and exec bundles byte-identical to the pre-M11 tree (D-M11-24); the factory
  bundle's size and `install.factory` time recorded once in the journal.
- F-11. Appendix C kept current: each R item it maps "M11" names a passing test.

---

## 18. Fixed texts

In `AH/speech/audio-protocol.js` (`speechTexts`, `speechTextOf`: R5-41's `Unknown TTS voice
"<id>"` word for word), `guest/lib/voice-preferences.js` (`voiceTexts`, `voiceTextOf`) and
`UI/src/voice/texts.js` (`voiceUiTexts`: R5-46 "continuing in background…", R5-56 "Mute replies",
"Speak replies", "Spoken replies", "On — autoplay", "Expression", "Phoneme variation", "Sentence
pause", "Voice shortcut"). No text quotes a provider body, a path, a command or a key.

---

## Appendix A. Seam H1: lines added to `guest/lib/guards/factory.js`

Added by WX.1 in its one commit with the other lanes' shared entries (cross-check X-02); W11.7
and W11.8 start from it. `S` and `R`, `text`, `list`, `record`, `count` are the module's
own; the builders join the existing `lazyTable` sources.

```js
import {
  voiceLimits,
} from '../voice-preferences.js';

// ---- shapes (join presetShapeBuilders or a new voiceShapeBuilders spread into `shapes`) ----
const voiceShapeBuilders = {
  /** R5-54: the shared record; every field optional. */
  VoicePreferences: () =>
    record(
      {},
      {
        voice: text(voiceLimits.voiceUnits),
        speed: M.number(),
        noiseScale: M.number(),
        noiseW: M.number(),
        sentenceSilence: M.number(),
      },
    ),
  /** A write: the same fields (ranges checked in the method, D-M11-19). */
  VoicePreferencesPatch: () => S.VoicePreferences,
  VoiceSessionRequest: () =>
    record(
      {},
      {
        invocationId: text(voiceLimits.invocationIdUnits),
        title: text(limits.titleUnits),
        at: count,
      },
    ),
  VoiceSessionAnswer: () =>
    record(
      { session: R('Session'), key: S.Id, duplicate: M.boolean() },
      { warning: text(limits.labelUnits * 2) },
    ),
  SpeechInSettings: () =>
    M.or(
      record({ kind: 'off' }),
      record(
        {
          kind: 'process',
          command: list(text(voiceLimits.commandArgUnits), voiceLimits.commandArgs),
          language: text(32),
        },
        { warm: M.boolean() },
      ),
      record(
        {
          kind: 'openai-audio',
          baseUrl: text(voiceLimits.settingUnits),
          model: text(256),
          language: text(32),
        },
        { key: R('ReadGrant'), partialIntervalMs: count },
      ),
    ),
  SpeechOutSettings: () =>
    M.or(
      record({ kind: 'off' }),
      record(
        {
          kind: 'process',
          command: list(text(voiceLimits.commandArgUnits), voiceLimits.commandArgs),
          voicesDir: text(voiceLimits.commandArgUnits),
        },
        {
          defaultVoice: text(voiceLimits.voiceUnits),
          defaultSpeed: M.number(),
          spareSynth: M.boolean(),
        },
      ),
      record(
        {
          kind: 'openai-audio',
          baseUrl: text(voiceLimits.settingUnits),
          model: text(256),
          voices: list(text(voiceLimits.voiceUnits), voiceLimits.providerVoices),
        },
        {
          key: R('ReadGrant'),
          defaultVoice: text(voiceLimits.voiceUnits),
          defaultSpeed: M.number(),
        },
      ),
    ),
  SpeechSettings: () =>
    record(
      { speechIn: S.SpeechInSettings, speechOut: S.SpeechOutSettings },
      { revision: count },
    ),
};

// ---- interfaces (spread into `interfaces`) ----
const voiceInterfaceBuilders = {
  Voice: () =>
    M.interface('Voice', {
      getPreferences: M.call().returns(S.VoicePreferences),
      setPreferences: M.call(S.VoicePreferencesPatch).returns(S.VoicePreferences),
      getVoicePreset: M.call().returns(R('Preset')),
      setVoicePreset: M.call(R('Preset'), count).returns(R('Preset')),
      startVoiceSession: M.callWhen()
        .optional(S.VoiceSessionRequest)
        .returns(S.VoiceSessionAnswer),
      speechSettings: M.call().returns(S.SpeechSettings),
    }),
};

// ---- Operator (m2Versions.Operator): one line ----
      getVoice: M.call().returns(R('Voice')),

// ---- HarnessRoot: one line (D-M11-21; provisioning path, never a page) ----
      configureSpeech: M.call(S.SpeechSettings).returns(S.SpeechSettings),

// ---- method names ----
//   m2NewMethodNames:      Voice: ['getPreferences', 'setPreferences', 'getVoicePreset',
//                                  'setVoicePreset', 'startVoiceSession', 'speechSettings'],
//   m2VersionMethodNames.Operator: ..., 'getVoice'
//   the HarnessRoot method-name list: ..., 'configureSpeech'
```

`HarnessRoot.configureSpeech` also refuses (`voiceTexts.speechSettingsInvalid`) a record whose estimated size
(string units x 3) exceeds `frameBytes - 2,048`, so `speechSettings()` always fits one frame. New
gateway vocabulary keys from this appendix: `voice`, `speed`, `noiseScale`, `noiseW`,
`sentenceSilence`, `invocationId`, `duplicate`, `warning`, `speechIn`, `speechOut`, `command`,
`language`, `warm`, `baseUrl`, `voicesDir`, `defaultVoice`, `defaultSpeed`, `spareSynth`,
`voices`, `partialIntervalMs`, `revision` (some exist already); method names `getVoice`, the six
`Voice` methods and `configureSpeech`.

## Appendix B. Test fixtures

All are Node scripts or data; none needs credentials or the network beyond loopback.

- `test/fixtures/fake-stt.mjs` speaks the `sttProcessMessages` protocol. Arguments: `--mode
  normal|hang-after=<n lines>|crash-at-start|slow-ready=<ms>|flood-line|error-on-stop`,
  `--pid-file <path>`, `--log <path>` (JSON lines of what it received, base64 lengths only). A
  partial is `"<bytes so far> bytes"` every 0.5 s of audio, the final `"final <bytes>"`. Exits at
  stdin EOF.
- `test/fixtures/fake-tts.mjs` stands in for Piper: the same flags (`piperFlags`), one stdin line ->
  `--length-scale`-scaled 100 ms of a 440 Hz s16le tone per 10 characters at the voice's sample rate.
  Modes `normal|hang-on=<sentence index>|crash-at-start|slow-ms=<n>`; `--pid-file`, `--log`. Exits
  at stdin EOF.
- `test/fixtures/fake-speech-server.mjs` listens on `127.0.0.1:0` and prints its port: `POST
  /v1/audio/transcriptions` answers `{ "text": "final <bytes>" }`; `POST /v1/audio/speech` streams
  24 kHz PCM as above; it records the SHA-256 of each `Authorization` header (never the value);
  modes per request header `x-fake-mode: 401|429|500|hang|slow-body|huge-json`.
- `test/fixtures/voices/`: `en_US-test-medium.onnx` (empty) + `.onnx.json` (`sample_rate` 22050),
  `en_GB-other-low.onnx` + `.onnx.json` (16000), `en_US-broken-medium.onnx` + a `.onnx.json` that
  does not parse, `en_US-norate-medium.onnx` + `.onnx.json` without a sample rate.
- `test/fixtures/voice-clip.mjs` `makeClip({ seconds, speechAtMs, silenceAtMs })` -> 16 kHz s16le
  bytes with tone bursts for speech and a noise floor for silence (endpointing and transport
  tests), and `levelsOf(clip)` -> the RMS per 85 ms block.

## Appendix C. Spec items, item by item (cross-check X-12)

"M11" names the acceptance item (section 13) that proves it; "departure" names the decision that
records a difference; "not M11" names the owner. Spec items not listed are not voice items.

| item | what | here |
|---|---|---|
| R2-6 | speech in resident, recreated every start; speech out spawned per synthesis | M11 2 (resident, respawn), 5 (one process per reply), 21 (fresh per start); departure D-M11-23 (started at first use) |
| R2-20 | voices and weights downloaded from remote hosts | not M11: O-4 (the operator installs voices; `uv` fetches weights on first use) |
| R3-13, R4-89 | the built-in `voice` preset, its pinned backend and model | M11 14 (the pin and G-11) and `70-voice.js`; the workspace and shell are M6's; whole preset: WX.F `voice-preset.test.js` |
| R3-244, R3-245 | synthesis and recognition as unconfined local services, a recognition failure not stopping the start | M11 2 (a speech-in start failure leaves speech out working); engines are adapter children with the allowlisted environment (section 10); no start step waits on them (D-M11-23) |
| R5-1 | four parts: client front end, speech in, speech out, the speech view | sections 1.3, 6, 7, 9 |
| R5-2 | audio as object messages over the UI's socket; no endpoint added | departure D-M11-3, O-5 (binary `/audio`); "every session, whatever its backend": M11 4 (speak takes any `Session`) |
| R5-3 .. R5-11 | the spoken turn, steps 1-9 | M11 1 (capture to final), 6 (endpointing, grace send), 4 (speech view), 5 and 10 (synthesis), 11 and 7 (playback) |
| R5-12 | base64 PCM in pulled, merged events; odd byte dropped | M11 1 (odd byte); departure D-M11-3 (pushed binary frames, nothing to merge) |
| R5-13, R5-14 | partials recomputed; cumulative, replace not append | M11 1 |
| R5-15 | resident model, warmed, respawned on next use | M11 2; warming at first settings read (D-M11-23) |
| R5-16 | language fixed per service | `SpeechInSettings.language` (appendix A) |
| R5-17 | a failure mid-stream reported as `abort` | M11 1, 10 |
| R5-18 | the deployment's model choice | not M11 (operator configuration; `[real-moonshine]` repeats) |
| R5-19 .. R5-33 | client endpointing and its defaults | M11 6 (`endpointing-defaults.js` holds R5-24..R5-33) |
| R5-34 | the speech view of a turn | M11 4 |
| R5-35 .. R5-37 | code filter, sentence split, release on whitespace | M11 3 |
| R5-38 | one synthesis process per reply, lazy | M11 5, 7; improved by the warm spare (D-M11-12) |
| R5-39 | the deployment's voices | not M11 (operator configuration; `[real-piper]`) |
| R5-40 .. R5-43 | catalogue, option checks, ranges, PCM output with its rate | M11 5 |
| R5-44 | look-ahead and gapless scheduling; a new playback replaces the old | M11 7, 11; `voice-playback.test.js` |
| R5-45 | auto-speak only on the submitting page | M11 12 |
| R5-46, R5-47 | soft barge-in; stopping playback ends synthesis, not the turn | M11 7 |
| R5-48 | Stop cancels the turn; mute stops the reply | M11 7; `voice-ui.test.mjs` |
| R5-49 | latency mechanisms | perf rows `speech.*` (section 14.1) |
| R5-50 | debounced settings change restarts speech | M11 8; section 9 Settings |
| R5-51 | fixed delays, no measured figures | perf rows; `stt.*`, `tts.*` owner rows |
| R5-52 | spoken introduction for `spoken: true` | M11 9; departure D-M11-16, O-2 (voice-started sessions only) |
| R5-53 | the shortcut's preset, changeable, per controller | M11 8, 22 |
| R5-54 | shared preferences record, serialised merges, re-check at synthesis | M11 8, 5; departure D-M11-18 (unknown keys refused) |
| R5-55, R5-56 | device cache and load order; UI controls | M11 8, 11; section 9; D-M11-17, O-3 (per-message playback) |
| R5-57 | configurable switches, voice, speed, language, model location | `SpeechSettings` (appendix A), `70-voice.js`; M11 19 |
| R5-58 | both services after every start; speech-in failure not fatal; unbounded wait | M11 2, 21; departures D-M11-10 (`engineLoadMs`), D-M11-23 |
| R5-59 | services hold no capabilities, ambient OS authority | section 10 (engines reach only their pipes or HTTP; settings written on the provisioning path, D-M11-21) |
| R5-60 .. R5-62 | Android shell, invocation, pause | not M11 (P-60, open decision 7); the launch claim (R5-61's 32 ids) is M11 13; the wake lock (R5-62) M11 18 |
| R5-63 .. R5-71 | context items | R5-66: D-M11-12; R5-67: D-M11-10, M11 10; R5-68: D-M11-11; R5-70: D-M11-16; R5-71: not built (section 1.2) |
| R6-53 | the voice controls of the UI | M11 6, 7, 8, 11, 18 (`voice-ui.test.mjs`) |
| R6-60 | launch claims | M11 13 |
| R8-17 | voice configuration and its defaults (speed 1.0, speech in on, language `en`) | `70-voice.js` defaults; M11 19 |
| R8-29 | engines fresh at every start with the current configuration | M11 21; departure D-M11-23, O-12 |
| R8-43 | Piper and Moonshine; downloads | the `process` kind (section 6.2); downloads not M11 (O-4) |
