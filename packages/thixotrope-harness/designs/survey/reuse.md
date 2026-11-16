# Reuse survey: which Endo harness code can be reused on Thixotrope

Abbreviations used below:

- **T** = `/Users/xyz/Development/endo-thixotrope-harness` (branch `claude/thixotrope-harness`, HEAD `48d6f3e08`, 2026-11-02, the `llm` tip).
- **E** = `/Users/xyz/Development/endo-but-for-bots` at `1315bef86` (branch `codex/fae-session-ownership`, 2026-11-09). This is the commit the spec describes.
- Paths under `packages/...` with no prefix are E paths at 1315bef86. The two trees hold the same paths except where noted in section 1.
- Thixotrope paths are relative to T.

Nothing in either repository was modified. The probes in section 3 ran from the scratchpad (`.../scratchpad/thix/survey/probe/probe.mjs`, `probe2.mjs`). They used temporary state directories that were deleted afterwards.

---

## 1. How far apart the two copies are

**E is strictly newer than T. T has nothing that E lacks.**

- In T, `git merge-base HEAD 1315bef86` returns `48d6f3e08`, which is T's HEAD.
- `git rev-list --count HEAD..1315bef86` = **24 commits**. `1315bef86..HEAD` = 0.
- Commit `1315bef86` is already in T's object store. A builder can read any E file without touching E, for example `git -C T show 1315bef86:packages/fae/session/pending-queue.js`. There is no need to copy files across checkouts.

The 24 commits fall between 2026-11-01 and 2026-11-09. The ones that matter for the harness:

| commit | effect |
| --- | --- |
| `a14de035ea` | floot rebuilds direct model context from the turn journal |
| `02fb5e554e` | floot UI picks a provider and model from presets (`space-floot/src/ProviderModelFields.js`) |
| `3adf7e39f0` | floot runs sessions and delegation through direct Fae providers |
| `4b6863dac2` | direct subscription pools and a separate OpenRouter credential (`hosted-agent/src/setup-direct-subscription.js`, `lal/providers/subscription-messages.js`) |
| `0b8d43aa59` | retires the Codex CLI and Claude Code runtimes and images |
| `364d40f20e` | **moves the session harness from `packages/floot/src/*` to `packages/fae/session/*`**, plus `fae/session-factory.js` (4,849 lines) and owned factories |
| `1315bef86` | bounds Forgejo archive frames (out of scope) |

`git diff --shortstat HEAD 1315bef86`, per package (commits that touch it, then the diffstat):

| package | commits | diff | how T's copy differs |
| --- | --- | --- | --- |
| fae | 5 | 160 files, +50,505 / −674 | T has no `fae/session/`, `fae/providers/`, `session-factory.js`, `setup-session-factory.js`, `src/owned-factory.js`, `src/subscription-models.js`, `src/installed-openai.js` or `src/widget-prompt.js`. T's `src/turn-engine.js`, `src/subagent-host.js` and `subagent-spawner.js` are older. |
| floot | 9 | 136 files, +739 / −52,234 | 93 renames `floot/src/* → fae/session/*`. In E, floot is only voice plus 3-line re-export shims (`floot/src/pending-queue.js` etc.). In T, floot still holds the whole harness (`floot/src/hosted-turn.js`, `journal-*.js`, `pending-queue.js`, `network-policy.js`, `preset-catalog.js`, …). |
| lal | 1 | 6 files, +1,033 / −76 | T lacks `providers/subscription-events.js` (the SSE parser) and `providers/subscription-messages.js` (Anthropic Messages over a subscription). T's `subscription-responses.js` is older and has the SSE parser inline. |
| hosted-agent | 7 | 21 files, +1,370 / −220 | T lacks `src/setup-direct-subscription.js`, `src/session-consumer.js`, `src/installation-path.js` and `src/subscription-model-catalog.js`. |
| chat | 4 | 30 files, +2,181 / −1,105 | T lacks `floot-history-pages.js`, `peer-connection.js`, `spaces-storage.js` and `whylip-book.js`, and has an older `floot-component.js`. |
| space-floot | 4 | 9 files, +455 / −608 | T lacks `ProviderModelFields.js`; its `FlootApp.js` is older. |
| agent-tools | 2 | 4 files, +49 / −9 | small change: `json-tools/shell.js`, plus the declaration extractor |
| daemon | 9 | 48 files | not surveyed in depth |
| thixotrope | 0 | — | identical in both trees |

`diff -rq` on the working trees also shows many `.d.ts`, `.d.ts.map` and `coverage/` files "only in E". Those are build artefacts in E's checkout, not source differences. E's work tree is clean apart from an untracked `.worktrees/`.

**Consequence:** take E's module layout (`fae/session/*`, `lal/providers/subscription-*.js`) as the reference, by reading it through `git show 1315bef86:...` in T. Do not build on T's `packages/floot/src/*`, which is the pre-move layout.

---

## 2. Component map and classification (E @ 1315bef86)

Classifications:

- **PURE**: no daemon, formula or pet-name dependency; it can be imported as a library.
- **CAP**: pure logic that calls injected capabilities with `E()`. It fits Thixotrope's object passing well.
- **DAEMON-BOUND**: depends on Endo host, guest, pet-name or formula APIs.
- **HOST-NATIVE**: needs Node built-ins (`node:*`, `child_process`, sockets, fs, or `fetch`).
- **UI**: browser code.

Line counts are E's.

### 2.1 Provider clients and streaming

| module | lines | class | notes |
| --- | --- | --- | --- |
| `lal/providers/subscription-events.js` | 55 | PURE | Responses/Messages SSE parser. `async function*` over byte chunks; uses `TextDecoder` with `{stream:true}`; 16 MiB bound. |
| `lal/providers/subscription-responses.js` | 749 | CAP | OpenAI Responses over a subscription. `E(subscription).openEndpoint({sessionId})` (l.403) then `E(endpoint).requestByteStream(request)` (l.448). It never touches HTTP itself. Request building and output mapping (`messageFromResponsesOutput` l.201, `getEmptyResponsesOutput` l.21) are pure. |
| `lal/providers/subscription-messages.js` | 543 | CAP | Anthropic Messages with the same shape (`openEndpoint` l.277, `requestByteStream` l.322). `claudeMessagesEfforts` (l.24) and `messageFromMessagesOutput` (l.75) are pure. |
| `lal/providers/openrouter.js` | 538 | PURE+fetch | `makeOpenRouterProvider({fetchImpl = fetch})` (l.174–177). Uses `setTimeout` (backoff through `delay.js`) and `Date.now`. `usageFromOpenRouter` (l.51) is pure. |
| `lal/providers/openai-compatible-messages.js` | 110 | PURE | message shape conversion |
| `lal/providers/anthropic.js` | 211 | HOST-NATIVE | `@anthropic-ai/sdk`; `Date.now`, `Math.random` |
| `fae/providers/anthropic-streaming.js` | 286 | HOST-NATIVE | `@anthropic-ai/sdk` streaming, API-key path |
| `lal/providers/gemini.js`, `ollama.js`, `llamacpp.js` | 175 / 166 / 108 | HOST-NATIVE | `node:https`, SDKs. Not parity-relevant. |
| `lal/providers/index.js`, `config.js`, `mock.js`, `delay.js` | 150 / 77 / 73 / 25 | PURE | provider registry; the mock provider is useful for tests |
| `hosted-agent/src/provider-transport.js` | 562 | HOST-NATIVE | real `fetch(` for the broker |
| `hosted-agent/src/provider-http.js` | 342 | HOST-NATIVE | `node:http`, `node:net` |
| `hosted-agent/src/provider-broker.js` | 1,819 | DAEMON-BOUND + CAP | broker exos, byte streams |
| `hosted-agent/src/provider-broker-service.js` | 1,758 | DAEMON-BOUND + HOST-NATIVE | `node:fs`, `@endo/sandbox/owned-native-service.js` |
| `hosted-agent/src/provider-pipe.js`, `provider-listener-runtime.js` | 116 / 708 | HOST-NATIVE | CapTP over netstring pipe; Podman listener |
| `hosted-agent/src/rate-limit-headers.js` | 226 | PURE | parses 429 and reset headers |
| `hosted-agent/src/provider-usage.js` | 151 | PURE | usage settlement |
| `hosted-agent/src/codex-reasoning.js`, `canonical-json.js`, `bounded-json.js` | 26 / 67 / 45 | PURE | |
| `hosted-agent/src/*-model-read.js` (anthropic, codex, openrouter) | 155–205 | PURE+fetch | model catalog reads with `fetch(` and `Date.now` |
| `hosted-agent/src/model-catalog.js` | 230 | PURE | `now = Date.now` is injectable (l.105) |

### 2.2 Subscription credentials and pool

| module | lines | class | notes |
| --- | --- | --- | --- |
| `hosted-agent/src/subscription-pool.js` | 701 | PURE | Pool selection and refusal marks. `now = Date.now` is injectable (l.601). The 429 reset logic is the main value here. |
| `hosted-agent/src/share-meter.js`, `pool-member-lifecycle.js`, `account.js`, `hosted-agent-policy.js`, `public-network.js`, `turn-ledger.js` | 256 / 97 / 554 / 656 / 57 / 324 | PURE | |
| `hosted-agent/src/subscription-share.js` | 830 | CAP + `node:crypto`, `setTimeout` | |
| `hosted-agent/src/pool-identity-journal.js` | 185 | CAP | |
| `hosted-agent/src/account-oracle.js` | 719 | CAP + `setTimeout` | |
| `hosted-agent/src/memory-oauth-credential.js` | 215 | CAP | |
| `hosted-agent/src/managed-credentials.js`, `managed-renewable-credentials.js` | 105 / 188 | CAP + `node:buffer` / `node:crypto` | |
| `hosted-agent/src/provider-grant-issuer.js` | 869 | HOST-NATIVE | `fetch(`, `node:crypto`, `process.` (OAuth refresh) |
| `hosted-agent/src/setup-direct-subscription.js` | 313 | DAEMON-BOUND | setup script that provisions the pools |
| `fae/src/credentials.js` | 222 | CAP | |
| `fae/session/provider-connections.js` | 679 | DAEMON-BOUND + CAP | wires providers to sessions |
| `fae/src/subscription-models.js` | 111 | PURE | |

### 2.3 Turn engine and tool-call rounds

| module | lines | class | notes |
| --- | --- | --- | --- |
| `fae/src/turn-engine.js` | 86 | PURE | `runAgenticTurn({cursor, maxRounds, signal, getTools, getContext, invoke, getToolCalls, runTools, commitStep, commitFinal})` (l.17–29). Every effect is an injected callback, so it is an ideal fit. `DEFAULT_MAX_TOOL_ROUNDS = 1024` (l.6). |
| `fae/src/extract-tool-calls.js` | 188 | PURE | ids use `Date.now()` (l.139, l.168), which must be injected |
| `fae/src/tool-arguments.js`, `fae/session/tool-evidence.js`, `turn-evidence.js`, `tool-output.js`, `subagent-admission.js`, `session-identity.js`, `factory-ownership.js`, `recover-undispatched.js` | 25–354 | PURE | |
| `fae/session/session-turn.js` | 275 | CAP | `makeExo`, exo-stream buffered channel, `Buffer` |
| `fae/session/stream.js` | 91 | CAP | `Buffer`, exo-stream |
| `fae/session/session-turn-slot.js` | 85 | CAP | |
| `fae/session/reply-fold.js` | 182 | PURE | folds streamed deltas into a reply; also used by the UI |
| `fae/session/transcript-delta.js` | 88 | PURE | `diffTranscript`, `sameData`; also used by the UI |
| `lal/agent-round.js`, `lal/round-runner.js` | 419 / 75 | PURE | Lal's older pi-agent loop. Not needed if Fae's engine is used. |
| `lal/tool-dispatch.js` | 544 | CAP | |

### 2.4 Tool definitions

| module | lines | class | notes |
| --- | --- | --- | --- |
| `agent-tools/src/tool.js` | 158 | PURE | tool schema and `@endo/patterns` guard |
| `agent-tools/src/json-tools/{fs,git,git-mount,git-remote,http,shell}.js` | 96–631 | CAP | They operate on mount, git, http-client and shell capabilities passed in. No Node built-ins. |
| `agent-tools/src/workspace.js` | 189 | CAP | |
| `agent-tools/src/adapters/{mcp,smallcaps}.js` | 633 / 48 | CAP / PURE | |
| `agent-tools/src/code-mode/compartment.js`, `evaluate-tool.js` | 248 / 95 | PURE | needs `Compartment`, which the guest has |
| `fae/src/tool-makers.js` | 1,754 | HOST-NATIVE + DAEMON-BOUND | `fs`, `path`, `child_process`, `util`, `@endo/daemon/src/mount.js`, `Buffer`, `Date.now`, `Math.random` |
| `fae/src/tools.js`, `fae/session/tool-registry.js`, `workflow-tools.js`, `account-tool.js` | 165 / 303 / 224 / 130 | CAP / DAEMON-BOUND | The registry imports tool-makers. |
| `fae/src/image-tool.js`, `source-tools.js` | 142 / 349 | CAP | |

### 2.5 Pending queue and idempotent submission

| module | lines | class | notes |
| --- | --- | --- | --- |
| `fae/session/pending-queue.js` | 486 | DAEMON-BOUND | The queue logic is fine, but storage is pet names: `E(host).has(name)`, `E(host).remove`, `E(host).storeValue`, `E(host).lookup` (l.97–128, l.475). It has `now = () => Date.now()` (l.65) and uses `@endo/sha256` over `TextEncoder` for idempotency keys (l.27, l.79). |
| `fae/session/session-submissions.js` | 343 | CAP | over the queue |
| `fae/session/session-mentions.js`, `session-attachments.js` | 94 / 142 | CAP | |
| `chat/floot-submission-client.js` | 319 | UI/CAP | Client side of the idempotency key: `E(session).enqueueMessageOnce`, `enqueueOnce(displayText, request.id)`, `getSubmissionReceipt` (`chat/floot-component.js` l.153–204). |

### 2.6 Session journal, transcript and restart

| module | lines | class | notes |
| --- | --- | --- | --- |
| `fae/session/turn-journal.js` | 1,320 | DAEMON-BOUND | One pet-named record per event: `E(powers).list()`, `lookup(name)`, `storeValue(value, name)`, `remove(name)`, archive names (l.646–985). Formula persistence shapes the whole layout (Appendix F). |
| `fae/session/private-turn-storage.js`, `session-storage-layout.js`, `session-records.js` | 234 / 164 / 87 | DAEMON-BOUND | |
| `hosted-agent/src/transcript-records.js` | 516 | PURE | `assertTranscriptRecord`, `encodeTranscript`, `parseTranscript`, `selectActiveTranscript`, `pairToolCalls`, `responsesApiItems`, `readResponsesApiItems` (l.90–482). Only depends on `@endo/errors`. |
| `fae/session/journal-history.js`, `journal-presentation.js`, `journal-transcript.js`, `journal-usage.js`, `context-evidence.js`, `context-transcript.js`, `transcript-projection.js`, `compaction-checkpoint.js` | 27–612 | PURE | Projection of journal records into model context and UI pages. `transcript-projection.js` imports `@endo/lal/providers/index.js` for types only [inferred]. |
| `hosted-agent/src/snapshot-journal.js`, `latest-topic.js` | 60 / 122 | CAP | |
| `fae/session/session-watch.js` | 705 | CAP | `setTimeout`, `Buffer`, exo-stream. Feeds the UI's `watch()`. |

### 2.7 Context compaction and token accounting

| module | lines | class | notes |
| --- | --- | --- | --- |
| `lal/providers/context-compaction.js` | 238 | PURE | `planContextCompaction` (l.27); `summarizeContext(plan, invoke, signal)` (l.208) takes the model call as a callback |
| `hosted-agent/src/token-usage.js` | 251 | PURE | no imports at all |
| `hosted-agent/src/workload-limits.js` | 63 | PURE | |
| `fae/session/runtime-config.js`, `workload-config.js`, `fae/src/workload-config.js` | 56 / 66 / 38 | PURE | |
| `hosted-agent/src/image-result.js` | 153 | PURE | no imports. Image blocks and tool-output size bounds. |

### 2.8 Subagents and workload limits

| module | lines | class | notes |
| --- | --- | --- | --- |
| `fae/src/subagent.js` | 939 | DAEMON-BOUND | `@endo/daemon/locator.js`, `@endo/daemon/pet-name.js`; injectable `timers` (l.425–430) |
| `fae/src/subagent-host.js` | 624 | CAP | exo |
| `fae/subagent-spawner.js` | 116 | DAEMON-BOUND | |
| `fae/session/subagent-admission.js`, `hosted-agent/src/workload-limits.js` | 113 / 63 | PURE | |

### 2.9 Attachments and images

`fae/session/session-attachments.js` (142, CAP, `@endo/sha256`), `fae/src/image-tool.js` (142, CAP, base64 and byte reader) and `hosted-agent/src/image-result.js` (PURE).

### 2.10 Container environment runner (Podman) and network policy

| module | lines | class | notes |
| --- | --- | --- | --- |
| `hosted-agent/src/environment-runner.js` | 412 | HOST-NATIVE | `@endo/sandbox/*` (spawner, runtime, private-directory), `@endo/exo-shell`, `node:fs`, `node:crypto` |
| `hosted-agent/src/execution-envelope.js` | 445 | HOST-NATIVE | `@endo/sandbox/policy.js`, `node:path` |
| `hosted-agent/src/delegated-runner.js` | 841 | HOST-NATIVE | `node:crypto`, spawn |
| `hosted-agent/src/public-egress.js`, `public-egress-listener.js`, `public-dns-listener.js` | 475 / 342 / 234 | HOST-NATIVE | `node:dns`, `node:net`, `node:http`, `node:dgram` |
| `hosted-agent/src/hosted-agent-policy.js`, `public-network.js` | 656 / 57 | PURE | policy evaluation |
| `fae/session/network-policy.js` | 220 | CAP | session network state; pure apart from `E` |
| `fae/session/development-environment.js` | 170 | CAP | uses `@endo/agent-tools/json-tools/shell.js` |
| `fae/session/container-mounts.js` | 1,056 | HOST-NATIVE | `node:crypto` |
| `hosted-agent/src/session-supervisor.js`, `session-provisioner.js`, `session-plan.js`, `session-state-storage.js`, `session-storage.js` | 189–473 | DAEMON-BOUND / HOST-NATIVE | |
| `hosted-agent/src/workspace-projection.js` | 128 | HOST-NATIVE | 9p mount bridge, `child_process` |

### 2.11 Git workspace capability

| module | lines | class | notes |
| --- | --- | --- | --- |
| `exo-git/src/git.js` | 1,616 | CAP | `makeGit` (l.1524) and `makeGitOperations({backend, git})` (l.274) over a pluggable backend. Imports exo, stream and pubsub only. |
| `exo-git/src/git-remote.js`, `git-remote-policy.js`, `git-credential.js`, `git-cloner.js`, `interfaces.js`, `result-bounds.js` | 117–1,072 | CAP / PURE | |
| `git/src/native-git-backend.js` | — | HOST-NATIVE | spawns `git`, with an askpass helper `.cjs` |
| `exo-git/src/git-filesystem.js` | 420 | CAP | |

### 2.12 Workspace publishing and asset server

| module | lines | class | notes |
| --- | --- | --- | --- |
| `fae/session/publish-tool.js` | 341 | DAEMON-BOUND + CAP | `@endo/platform/fs/extended/from-mount.js`, tool-makers, `crypto` |
| `endo-fs-asset-server/src/asset-server.js`, `serve-tree.js` | 1,111 / 290 | CAP + `@endo/platform/http/server` | the HTTP server is host-native |
| `endo-fs-asset-server/src/mime.js` | 61 | PURE | |
| `endo-fs-asset-server/src/type-guards.js` | 103 | PURE | |
| `endo-fs-asset-server/src/endo-store.js` | 174 | DAEMON-BOUND | |

### 2.13 Secrets manager

| module | lines | class | notes |
| --- | --- | --- | --- |
| `daemon/src/secret-manager.js` | 733 | DAEMON-BOUND | Exos are fine (`SecretBlob` l.320, `SecretAdmin` l.338, `SecretCatalog` l.593, `SecretImporter` l.629), but the catalog reports `petNamePaths` (l.621) and has `lookup(path)` (l.671). |
| `daemon/src/secret-backend.js` | 110 | HOST-NATIVE | `makeEncryptedFileSecretBackend({storagePath, filePowers, cryptoPowers, key})`. The wrapping key sits in the same state directory (l.5–9). |
| `daemon/src/secret-git-credential.js` | 71 | PURE | |
| `hosted-agent/src/secret-rotator.js` | 75 | CAP | |
| `chat/secrets-component.js` | 797 | UI | |

### 2.14 STT and TTS services, and client audio

| module | lines | class | notes |
| --- | --- | --- | --- |
| `floot/voice/audio-server-caplet.js` | 288 | HOST-NATIVE | Spawns the moonshine Python STT through `uv run` (l.54); exo plus buffered channel. |
| `floot/voice/moonshine_daemon.py` | 164 | HOST-NATIVE | Python |
| `floot/voice/tts-server-caplet.js` | 566 | HOST-NATIVE | `child_process`, `fs` |
| `floot/src/speech-code-filter.js` | 72 | PURE | no imports |
| `floot/src/turn-speech.js` | 207 | CAP | Sentence chunker over `watch()`, `speakTurn({watch, ttsServer})` (l.182). Exo-stream. |
| `floot/src/voice-preferences.js`, `voice-prompt.js` | 130 / 12 | CAP / PURE | |
| client audio in `chat/floot-component.js` | — | UI | Microphone through `getUserMedia` and an `AudioContext` analyser (l.2315–2357); TTS PCM playback (`enqueuePcm` l.2774, `createBuffer` l.2705). It is embedded inside the 3,672-line component, not a separate module. |
| `floot-android/` | — | UI | Java app (`FlootVoiceService.java`, `Netstrings.java`, …) |

### 2.15 Chat UI components

| module | lines | class | notes |
| --- | --- | --- | --- |
| `space-floot/src/*` | 437–1,101 | UI, PURE presentational | Preact. `FlootApp`, `MessageList`, `ComposeBar`, `PresetSettings`, `ProviderModelFields`, `SessionSidebar`, `RecoveryPanel`, `NetworkPolicyPanel`, `SettingsPanel`, `usage-label`, `account-label`, `highlight`. `FlootApp.js` has zero `E(` calls. |
| `chat/floot-component.js` | 3,672 | UI glue | 39 `E(` calls on a session capability: `watch()` streamed with `iterateReader(view, {buffer: 8})` (l.159–165), `enqueue*`, `getSubmissionReceipt`. It imports `@endo/floot/src/reply-fold.js` and `transcript-delta.js`. |
| `chat/floot-session-state.js`, `floot-history-pages.js`, `floot-mentions.js`, `floot-recovery.js`, `floot-network.js`, `floot-execution.js`, `floot-transfer.js`, `preset-settings.js`, `wake-lock.js` | 60–319 | UI | mostly pure |
| `chat/chat.js`, `spaces-gutter.js`, `channel-list.js`, … | — | UI, DAEMON-BOUND | The general Endo chat (inventory, pet names, spaces) is mostly out of parity scope. |

### 2.16 Presets and prompt composition

| module | lines | class | notes |
| --- | --- | --- | --- |
| `fae/session/preset-catalog.js` | 520 | DAEMON-BOUND + `node:crypto` | `BUILTIN_PRESETS` (l.103), `sessionPreset`, `presetHasShell`, `withSessionNetwork` (l.278–304) are pure data and functions. `makePresetCatalog(host)` (l.337) stores presets in the host. |
| `fae/session/system-prompt.js` | 916 | mostly PURE | `composePresetPrompt` (l.868), `normalizePromptContext` (l.826), `PROVIDER_PROMPT_ENVIRONMENT` (l.39). Imports `@endo/hosted-agent` (root) and has some `E(`, `Date.now` and `Math.random` sites. |
| `fae/src/widget-prompt.js`, `lal/prompts/system.js` | 33 / 126 | PURE / CAP | |

---

## 3. Can the PURE modules run inside a Thixotrope guest?

### 3.1 What a guest actually has

This was measured, not read from docs. The Ironhorse engine is the default (`src/ironhorse/ironhorse-engine.js`), using the `target/release/thixotrope-ironhorse-worker` binary built in T. The probe was `scratchpad/thix/survey/probe/probe.mjs`.

| global | Ironhorse guest | Node |
| --- | --- | --- |
| `TextEncoder`, `TextDecoder` | present | present |
| `TextDecoder` with `{stream:true}` across a split UTF-8 char | **BROKEN**: decoding `e2 82` then `ac` yields `"₀\u{100000}"`, not `"€"` | correct |
| `Date.now()`, `new Date()` | **throws** ("secure mode") | ok |
| `Math.random()` | **throws** | ok |
| `fetch`, `setTimeout`, `queueMicrotask`, `URL`, `AbortController`, `atob`, `structuredClone`, `crypto`, `Buffer`, `process`, `console`, `performance` | **undefined** | present |
| `WeakRef` | undefined in the guest compartment (the realm has it for the worker's GC, per README §Engines) | present |
| `Compartment` | present | present |
| prelude globals | `E, Far, harden, makeExo, defineExoClass(Kit), M, matches, mustMatch, passStyleOf, Fail, q, makeError, makePromiseKit, makeSerialQueue, describeError, isRemotable` (`src/guest/prelude.js` l.43–64) | — |

Other constraints found by the probes or in the code:

- **`Uint8Array` is not passable.** It is rejected by `passStyleOf` in the OCapN codec. An emulated immutable `ArrayBuffer` (`sliceToImmutable()`) was also refused ("iface emulated immutable ArrayBuffer … unimplemented"). Thixotrope's own HTTP resource passes bodies as strings (`resources/http/ephemeral.js` l.70–71). So bytes cannot cross into a guest today; only strings can.
- **Applications are bundled with `@endo/compartment-mapper` `makeBundle`** (`src/platform/bundler.js` l.2, l.38). The whole static module graph is included, so `import '@endo/patterns'` puts a second copy in the bundle unless the code reads the prelude globals instead (README §Persistent applications).
- **The bundle is staged into the vat** as one evaluated source (`src/control/installer.js` l.69–91).
- **A daemon-owed host-resource answer is at-most-once.** It rejects after a restart (README §System resources).

### 3.2 Performance probes

Same probe scripts. The machine was loaded (load average 4.7, and another agent's `thix-mail` Ironhorse demo was running), so absolute numbers are pessimistic. The ratios are the point. The XS engine binary is not built in T, so XS was not measured.

| measurement | Ironhorse guest | Node |
| --- | --- | --- |
| first `createWorker` + evaluate a 3 KB source | 3.7–9.1 s | — |
| one host→guest call, no-op | **190–530 ms** | ~0 |
| 20 sequential no-op calls | 5.2 s (≈260 ms each) | — |
| 20 pipelined no-op calls (`Promise.all`) | 5.3 s (**no pipelining gain**; deliveries are serialised per worker) | — |
| 50 SSE chunks of 60 B, one call each | **13.0 s** (≈260 ms per chunk) | — |
| SSE parse of 100 events (13 KB) in one call | 369 ms | 0.8 ms |
| SSE parse of 400 events (53 KB) in one call | **MeterAbort; the vat's session is then retired** | 1.5 ms |
| SSE parse of 2,000 events (270 KB) in one call | **HeapExhausted; the vat's session is then retired** | 11 ms |
| sum loop, 300,000 iterations | 295 ms (≈ call floor) | 0.8 ms |
| sum loop, 1,000,000 iterations | **MeterAbort** (default `crankBudget` 10,000,000 computrons, `src/ironhorse/ironhorse-limits.js` l.45–50) | 0.8 ms |
| JSON stringify + parse, 5,000 records (600 KB) | 378 ms | 3.3 ms |
| `t += 'abcdefghij'` × 1,000 | 210 ms | 0 |
| `t += 'abcdefghij'` × 10,000 (100 KB final) | **HeapExhausted, vat retired** | 0.1 ms |
| regex line splitter, 3,000 lines | 307 ms | 0.3 ms |

What the probes show:

1. **Each delivery to an Ironhorse vat has a floor of about 200–260 ms**, and deliveries to one vat do not overlap.
   - The likely cause is the fsync'd journal append plus the worker's per-crank GC sweep (README §Engines; `designs/production-cost-model.md` §Snapshots). This is [inferred] and has not been profiled.
   - The operator report quoted in `designs/production-cost-model.md` measured deliveries averaging 2.4 s in a hosted chat on this branch.
   - So a design that pushes every SSE delta or every `watch()` pull through a guest delivery cannot keep up with a model stream at 30–100 tokens/s. The chat UI's `iterateReader(view, {buffer: 8})` pulls one item per round trip.
2. **Garbage is not collected inside a crank.**
   - Repeated string concatenation or `slice` in one crank grows the heap quadratically and hits `HeapExhausted` (default `slotCeiling` 1,000,000, `chunkCeiling` 256 MiB).
   - The E SSE parser keeps `pending += decoder.decode(...)` and then `pending = pending.slice(...)` for every line (`lal/providers/subscription-events.js` l.24–31). That is exactly this pattern.
3. **Exceeding the meter or the heap halts the crank, and the vat's hub session is retired.** Every later call fails with "the target session has been retired". For a harness this means a single oversized tool result or prompt can permanently break a session vat. Such work must be bounded, or kept out of the guest.
4. **Pure compute speed is acceptable**: 300k loop iterations or a 600 KB JSON round trip fit in one crank. The limits are the per-delivery cost, the per-crank meter and the in-crank heap.

### 3.3 Per-module verdict: guest-safe or host-only

**Guest-safe as they are (or after injecting `now`):**
- `hosted-agent/src/token-usage.js`, `workload-limits.js`, `image-result.js`, `bounded-json.js`, `canonical-json.js`, `codex-reasoning.js`, `transcript-records.js`, `turn-ledger.js`, `hosted-agent-policy.js`, `public-network.js`, `share-meter.js`, `account.js`, `pool-member-lifecycle.js`, `rate-limit-headers.js`, `provider-usage.js`
- `fae/src/turn-engine.js`, `tool-arguments.js`, `subscription-models.js`
- `fae/session/{transcript-projection,journal-history,journal-presentation,journal-transcript,journal-usage,context-evidence,context-transcript,compaction-checkpoint,tool-evidence,turn-evidence,tool-output,subagent-admission,session-identity,reply-fold,transcript-delta,runtime-config,workload-config}.js`
- `lal/providers/context-compaction.js`, `openai-compatible-messages.js`, `config.js`, `mock.js`
- `floot/src/speech-code-filter.js`
- `agent-tools/src/tool.js`, `json-tools/*`, `code-mode/compartment.js`
- `exo-git/src/*` except the backend
- `endo-fs-asset-server/src/mime.js`, `type-guards.js`

All of these use only `@endo/errors`, `@endo/patterns`, `@endo/exo` and `@endo/eventual-send`, which the prelude provides as globals.

**Guest-safe only after injecting the clock:** `subscription-pool.js` (`now`, l.601), `model-catalog.js` (`now`, l.105), `fae/session/pending-queue.js` (`now`, l.65), `fae/src/extract-tool-calls.js` (hard-coded `Date.now()` l.139/168), `fae/src/subagent.js` (`timers`, l.430).
- Thixotrope's clock is an async resource (`E(timer).now()`, README §System resources), so a synchronous `now()` is not available in a guest.
- The host must stamp the time onto inbound messages as data, or the code must await the clock.

**Not guest-safe; host-side native resources:**
- `lal/providers/subscription-events.js`: broken streaming `TextDecoder`, quadratic `pending` string, the 400-event meter abort, and per-chunk delivery cost.
- The whole HTTP path for every provider: OpenRouter `fetch`, subscription `requestByteStream`, `provider-transport.js`, `provider-http.js`, `provider-grant-issuer.js`, the model reads.
- The SDK providers.
- `environment-runner.js`, `execution-envelope.js`, `delegated-runner.js`, `public-egress*.js`, `container-mounts.js`.
- `git/src/native-git-backend.js`.
- The voice caplets.
- `secret-backend.js`.
- `fae/src/tool-makers.js`.
- The asset server's HTTP side.

---

## 4. Recommendations per component

"Guest" means durable state in an Ironhorse vat heap. "Host" means a Thixotrope native resource: a durable manager in a vat plus a native adapter in Node, as in `packages/thixotrope/resources/http/`.

| component | recommendation | where the state lives | reason |
| --- | --- | --- | --- |
| **Provider clients and streaming** | **Copy and adapt** into a host native resource "model endpoint". Reuse the request builders and output mappers of `subscription-responses.js` and `subscription-messages.js` and `subscription-events.js` unchanged in the host adapter. Reuse OpenRouter with `fetchImpl`. | Host: in-flight streams. Guest: only the final assistant message and usage, plus **batched** progress (for example one delivery per ~250 ms or per N tokens). | The per-delivery floor (≈250 ms) and in-crank heap growth rule out parsing SSE or receiving per-token deltas in a guest. The existing `subscription` → `openEndpoint` → `requestByteStream` shape is already object-passing and maps directly onto a resource facet. |
| **Credential handling and pool** | **Reuse as a dependency:** `subscription-pool.js`, `share-meter.js`, `rate-limit-headers.js`, `account.js`, `token-usage.js` (pure, `now` injected). **Rewrite** the provisioning (`setup-direct-subscription.js`, `managed-*credentials.js`, `provider-grant-issuer.js`) as one host resource that holds the tokens. | Pool marks and selection: either works. Host is simpler, because refresh, `fetch` and the 429 headers are host-side. Secret token values: **host only**. | Ironhorse heap images (SQLite files) and `journal.jsonl` hold inbound frames in plaintext, so any secret passed to a guest is persisted unencrypted. |
| **Turn engine and tool rounds** | **Reuse as a dependency:** `fae/src/turn-engine.js` and its tests. Reuse `extract-tool-calls.js` after replacing `Date.now()` ids with injected ids. | Guest, as a durable session object: the turn loop runs as cranks between deliveries, each round is one delivery, and the provider call is an `E()` to the host. | It is 86 lines, all effects are callbacks, and it has no persistence assumptions. |
| **Tool definitions** | **Reuse** `agent-tools/src/tool.js` and `json-tools/*` (they need fs, git, shell and http capabilities passed in). **Rewrite** `fae/src/tool-makers.js` as host-side tool implementations (fs, exec, search) behind capabilities. | Tool schemas: guest. Execution: host or container. | `tool-makers.js` imports `fs`, `child_process` and `@endo/daemon/src/mount.js`. agent-tools is already capability-shaped. Tool outputs must be bounded before entering the guest (heap and meter). Reuse `image-result.js` and `bounded-json.js` for that. |
| **Pending queue and idempotent submission** | **Copy and adapt** `fae/session/pending-queue.js` and `session-submissions.js`: keep the ordering, receipt and idempotency logic, drop the pet-name storage (`E(host).has/lookup/storeValue/remove`), keep entries in a heap `Map`. Reuse `chat/floot-submission-client.js` nearly as is. | Guest | Orthogonal persistence makes the storage layer unnecessary (Appendix F). The idempotency key is an allowed string (client key). `@endo/sha256` is pure JS [inferred: not probed in a guest]; a heap `Map` keyed by the client id string may make hashing unnecessary. |
| **Session journal, transcript and restart** | **Rewrite** `turn-journal.js` (1,320 lines of pet-name record management). **Reuse** `hosted-agent/src/transcript-records.js` and the pure projections (`transcript-projection.js`, `journal-history.js`, `journal-transcript.js`, `context-transcript.js`, `compaction-checkpoint.js`, `journal-usage.js`) as dependencies. | Guest, as heap arrays of records, with **bounded retained state**: an archived prefix as pages, and a projection computed incrementally. | Restart handling becomes heap restore. But every read of a large transcript in one crank risks MeterAbort or HeapExhausted, so pages and incremental projection are required, not optional. Because host-owed answers reject on restart, an interrupted provider call must be recorded and re-issued by the guest (this matches the "dormant after restart" behaviour). |
| **Context compaction** | **Reuse as a dependency:** `lal/providers/context-compaction.js` (`planContextCompaction`, `summarizeContext(plan, invoke, signal)`). | Guest (the plan); the model call goes through the host. | Pure, with a callback for the model. Measure planning cost on a long transcript against the 10M computron budget. |
| **Subagents and workload limits** | **Reuse** `workload-limits.js` and `subagent-admission.js`. **Copy and adapt** `subagent-host.js` (exo, CAP). **Rewrite** `subagent.js` and `subagent-spawner.js`, which use the daemon locator and pet names. | Guest: a subagent is a session object created by a factory, held by its parent. | The object-passing rule replaces locators. A subagent can be another vat (`createWorker` from a guest; README §Workers creating workers). Its cost is the delivery floor per message. |
| **Attachments and images** | **Copy and adapt** `session-attachments.js` and `image-tool.js`. **Reuse** `image-result.js`. | Host: blob bytes in a content store resource. Guest: references and metadata only. | Bytes cannot cross into a guest (`Uint8Array` is not passable) except as base64 strings, and large strings risk heap exhaustion. |
| **Container runner (Podman) and network policy** | **Copy and adapt** `environment-runner.js`, `execution-envelope.js`, `public-egress*.js` and `@endo/sandbox` as one host native resource. **Reuse** `hosted-agent-policy.js` and `public-network.js` (pure) for policy decisions. **Copy and adapt** `fae/session/network-policy.js` and `development-environment.js` (CAP) into the guest. | Host: processes, sockets, the egress proxy. Guest: the per-session policy record and a container capability. | Everything effectful is Node. Thixotrope already has a native-process launcher bound to a vat (`daemon.makeResource(name, {workerId})`; README §System resources), so containers are retired with their vat. |
| **Git workspace capability** | **Reuse as a dependency:** `exo-git` (`makeGit`, `makeGitOperations({backend})`) in the host, with `git/src/native-git-backend.js`. **Reuse** `agent-tools/src/json-tools/git*.js` as tools. | Host: the repository on disk, branch tracking. Guest: a git capability. | Already capability-shaped with a pluggable backend. Forgejo pieces are out of scope. |
| **Workspace publishing and asset server** | **Copy and adapt** `endo-fs-asset-server/src/serve-tree.js`, `mime.js` and `type-guards.js` onto Thixotrope's `resources/http`. **Rewrite** `publish-tool.js` (depends on tool-makers and the daemon mount). | Host: files and HTTP. Guest: the published-tree capability and its URL (a URL is an allowed string). | `resources/http` passes string bodies only. Binary assets must be served directly by the host adapter from disk, not through a guest. |
| **Secrets manager** | **Copy and adapt** `daemon/src/secret-manager.js` (its exos, audit, generation counter) and `secret-backend.js` as a **host** native resource. Drop `petNamePaths` and `lookup(path)` in favour of returning `SecretBlob` and `SecretAdmin` objects. **Reuse** `secret-git-credential.js`. | **Host only.** Guests hold only a capability that *uses* a secret (for example a provider endpoint or git credential), never the value. | Plaintext heap snapshots and journals. Memory says the Tokyo Secrets manager is precious, so a migration or import path is needed and must be planned separately. |
| **STT and TTS services; client audio** | **Reuse** `floot/voice/audio-server-caplet.js`, `tts-server-caplet.js` and `moonshine_daemon.py` with small adaptation as host native resources (they already spawn subprocesses and expose exos). **Reuse** `speech-code-filter.js` as is. **Copy and adapt** `turn-speech.js` (the sentence chunker) to run host-side or in the UI. **Extract** the client audio code from `chat/floot-component.js` (l.2019–2774) into its own module. | Host: audio streams. Guest: voice preferences only (`voice-preferences.js`, copy and adapt). | Audio frames at speech rates cannot go through guest deliveries (≈4/s ceiling per vat). |
| **Chat UI** | **Reuse as a dependency:** `space-floot` (pure Preact), `fae/session/reply-fold.js` and `transcript-delta.js`. **Copy and adapt** `chat/floot-component.js` plus `floot-*.js` helpers, changing how it obtains the session object (a capability from the gateway rather than pet-name inventory) and how it watches (batched pages). Skip `chat/chat.js`, `spaces-gutter.js` and inventory/pet-name UI. | Browser. Session state lives in the guest. | The UI already talks to a session *object* (`E(session).watch/enqueue*`), which fits. `watch()` must deliver batches, because each pull is a guest delivery. |
| **Presets and prompt composition** | **Reuse** `BUILTIN_PRESETS`, `sessionPreset`, `presetHasShell`, `withSessionNetwork` and `composePresetPrompt` / `normalizePromptContext` (pure parts). **Rewrite** `makePresetCatalog(host)` as a heap object. | Guest | Strip the `E(`, `Date.now` and `Math.random` sites from `system-prompt.js`. Measure prompt composition (string building) against the in-crank heap limit; use `array.join` rather than `+=`. |

**Packaging note.**
- Taking the E modules as npm workspace dependencies from inside a guest bundle pulls duplicate `@endo/*` copies into every bundle, because `makeBundle` bundles the whole graph.
- Bundle size adds directly to install time (staging, evaluation under the meter) [inferred, not measured].
- For guest code, prefer copying the pure modules into a harness package that reads `E`, `M`, `makeExo` and `Fail` from `globalThis` (the `GuestGlobals` pattern, `packages/thixotrope/guest.js`).
- Host native adapters can import the E packages normally.

---

## 5. Endo tests worth porting as acceptance tests

All paths are in E at 1315bef86 (readable from T with `git show 1315bef86:<path>`).

**Providers and streaming**
- `packages/lal/test/subscription-responses.test.js`
- `packages/lal/test/subscription-messages.test.js`
- `packages/lal/test/openrouter.test.js`
- `packages/lal/test/image-messages.test.js`
- `packages/lal/test/provider-config.test.js`
- `packages/fae/test/session/openrouter.test.js`
- `packages/fae/test/session/anthropic-usage.test.js`
- `packages/fae/test/session/provider-cancellation.test.js`
- `packages/hosted-agent/test/provider-transport.test.js`
- `packages/hosted-agent/test/provider-http.test.js`
- `packages/hosted-agent/test/rate-limit-headers.test.js`
- `packages/hosted-agent/test/provider-usage.test.js`
- `packages/hosted-agent/test/provider-usage-settlement.test.js`

**Subscription pool and credentials**
- `packages/hosted-agent/test/subscription-pool.test.js`
- `packages/hosted-agent/test/subscription-share.test.js`
- `packages/hosted-agent/test/share-meter.test.js`
- `packages/hosted-agent/test/pool-identity-journal.test.js`
- `packages/hosted-agent/test/pool-member-lifecycle.test.js`
- `packages/hosted-agent/test/account.test.js`
- `packages/hosted-agent/test/account-oracle.test.js`
- `packages/hosted-agent/test/memory-oauth-credential.test.js`
- `packages/hosted-agent/test/managed-renewable-credentials.test.js`
- `packages/hosted-agent/test/secret-rotator.test.js`
- `packages/fae/test/credentials.test.js`
- `packages/fae/test/session/credential-rotation.test.js`

**Turn engine and tool rounds**
- `packages/fae/test/turn-engine.test.js`
- `packages/fae/test/session/tool-rounds.test.js`
- `packages/fae/test/session/tool-failure-status.test.js`
- `packages/fae/test/session/tool-output.test.js`
- `packages/fae/test/session/tool-evidence.test.js`
- `packages/fae/test/session/turn-evidence.test.js`
- `packages/fae/test/session/session-turn.test.js`
- `packages/fae/test/session/session-turn-slot.test.js`
- `packages/fae/test/session/reply-fold.test.js`
- `packages/fae/test/session/ordered-stream-recovery.test.js`
- `packages/fae/test/mock-provider-fixtures.test.js`

**Tools**
- `packages/agent-tools/test/tool.test.js`
- `packages/agent-tools/test/mount-fs-tools.test.js`
- `packages/agent-tools/test/shell-tool.test.js`
- `packages/agent-tools/test/http-tool.test.js`
- `packages/agent-tools/test/git-tool.test.js`
- `packages/agent-tools/test/git-flow.test.js`
- `packages/agent-tools/test/git-worked-loop.test.js`
- `packages/agent-tools/test/evaluate-tool.test.js`
- `packages/fae/test/edit-tool.test.js`
- `packages/fae/test/exec-tool.test.js`
- `packages/fae/test/search-tools.test.js`
- `packages/fae/test/source-tools.test.js`
- `packages/fae/test/image-tool.test.js`
- `packages/fae/test/session/tool-registry.test.js`

**Pending queue and submission**
- `packages/fae/test/session/pending-queue.test.js`
- `packages/fae/test/session/session-submissions.test.js`
- `packages/fae/test/session/session-mentions.test.js`
- `packages/chat/test/unit/floot-submission-client.test.js`

**Journal, transcript and restart**
- `packages/fae/test/session/turn-journal.test.js`
- `packages/fae/test/session/turn-journal-integration.test.js`
- `packages/fae/test/session/journal-history.test.js`
- `packages/fae/test/session/journal-transcript.test.js`
- `packages/fae/test/session/journal-usage.test.js`
- `packages/fae/test/session/journal-context-index.test.js`
- `packages/fae/test/session/transcript-projection.test.js`
- `packages/fae/test/session/transcript-continuity.test.js`
- `packages/fae/test/session/context-transcript.test.js`
- `packages/fae/test/session/context-evidence.test.js`
- `packages/fae/test/session/registry-recovery.test.js`
- `packages/fae/test/session/factory-private-journal.test.js`
- `packages/fae/test/session/private-turn-storage.test.js`
- `packages/hosted-agent/test/transcript-records.test.js`
- `packages/hosted-agent/test/turn-ledger.test.js`
- `packages/hosted-agent/test/snapshot-journal.test.js`
- `packages/hosted-agent/test/session-state-process-loss.test.js`

Tests about storage layout, such as `session-storage-layout.test.js`, test pet-name layout and should not be ported.

**Compaction and token accounting**
- `packages/lal/test/context-compaction.test.js`
- `packages/hosted-agent/test/token-usage.test.js`
- `packages/hosted-agent/test/workload-limits.test.js`
- `packages/hosted-agent/test/image-result.test.js`
- `packages/hosted-agent/test/bounded-json.test.js`
- `packages/fae/test/session/runtime-config.test.js`
- `packages/fae/test/session/workload-config.test.js`
- `packages/fae/test/workload-config.test.js`

**Subagents**
- `packages/fae/test/subagent.test.js`
- `packages/fae/test/subagent-host.test.js`
- `packages/fae/test/subagent-loop.test.js`
- `packages/fae/test/session/subagent-admission.test.js`
- `packages/fae/test/session/inbox-delegation.test.js`

**Attachments**
- `packages/fae/test/session/session-attachments.test.js`

**Containers and network**
- `packages/hosted-agent/test/environment-runner.test.js`
- `packages/hosted-agent/test/execution-envelope.test.js`
- `packages/hosted-agent/test/hosted-agent-policy.test.js`
- `packages/hosted-agent/test/public-egress.test.js`
- `packages/hosted-agent/test/public-egress-listener.test.js`
- `packages/hosted-agent/test/public-dns-listener.test.js`
- `packages/hosted-agent/test/public-network.test.js`
- `packages/hosted-agent/test/network-descriptor.test.js`
- `packages/hosted-agent/test/dev-image.test.js`
- `packages/fae/test/session/network-policy.test.js`
- `packages/fae/test/session/factory-network-policy.test.js`
- `packages/fae/test/session/development-environment.test.js`
- `packages/fae/test/session/container-mounts.test.js`

**Git**
- `packages/exo-git/test/kit-conformance.test.js`
- `packages/exo-git/test/git-remote-policy.test.js`
- `packages/exo-git/test/git-remote-result-bounds.test.js`
- `packages/exo-git/test/git-cloner.test.js`
- `packages/git/test/native-git-backend.test.js`
- `packages/agent-tools/test/git-mount-tool.test.js`
- `packages/agent-tools/test/git-remote-tool.test.js`

**Publishing and asset server**
- `packages/fae/test/session/publish-tool.test.js`
- `packages/endo-fs-asset-server/test/serve-tree.test.js`
- `packages/endo-fs-asset-server/test/asset-server.test.js`

**Secrets**
- `packages/daemon/test/secret-manager.test.js`
- `packages/daemon/test/secret-backend.test.js`
- `packages/daemon/test/secret-database.test.js`
- `packages/daemon/test/secret-git-credential.test.js`
- `packages/daemon/test/renewable-credential-restart.test.js`
- `packages/chat/test/component/secrets.test.js`

**Voice**
- `packages/floot/test/speech-code-filter.test.js`
- `packages/floot/test/turn-speech.test.js`
- `packages/floot/test/tts-server-caplet.test.js`
- `packages/floot/test/voice-preferences.test.js`
- `packages/chat/test/component/floot-audio-lifecycle.test.js`

**Chat UI**
- `packages/space-floot/test/turn-status.test.js`
- `packages/space-floot/test/session-status.test.js`
- `packages/space-floot/test/usage-label.test.js`
- `packages/space-floot/test/account-label.test.js`
- `packages/space-floot/test/actions.test.js`
- `packages/space-floot/test/linkify.test.js`
- `packages/chat/test/component/floot.test.js` (with `packages/chat/test/helpers/fake-floot.js`)
- `packages/chat/test/component/floot-recovery.test.js`
- `packages/chat/test/component/floot-network.test.js`
- `packages/chat/test/component/floot-execution.test.js`
- `packages/chat/test/component/floot-mentions-view.test.js`
- `packages/chat/test/component/preset-settings.test.js`
- `packages/chat/test/component/preset-settings-view.test.js`
- `packages/chat/test/unit/floot-session-state.test.js`
- `packages/chat/test/floot-history-pages.test.js`

**Presets and prompts**
- `packages/fae/test/session/preset-catalog.test.js`
- `packages/fae/test/session/system-prompts.test.js`
- `packages/floot/test/factory-system-prompt.test.js`

**End to end (behaviour reference, not directly portable)**
- `packages/fae/scripts/smoke.test.js`
- `packages/fae/test/session/factory-turn.test.js`
- `packages/fae/test/session/factory-watch.test.js`
- `packages/fae/test/session/hosted-agent.test.js`

---

## 6. Journal entries (fit / misfit / incompatibility)

- **FIT.** The provider wire layer is already capability-shaped: `subscription.openEndpoint()` returns an endpoint, and `endpoint.requestByteStream()` follows. The turn engine is callback-only. Tools take mount, shell and git capabilities. The UI talks to a session object. All of these follow the object-passing principle directly.
- **FIT.** The pet-name storage layers in the pending queue, turn journal, preset catalog, secret catalog paths and subagent locator exist only because of formula persistence. On Thixotrope they become heap `Map`s and arrays (consistent with Appendix F).
- **MISFIT (performance).**
  - An Ironhorse host→guest delivery costs about 200–260 ms, and calls to one vat are serialised (no pipelining gain), under load.
  - Per-token streaming, per-chunk SSE, audio frames and `watch()` pulls of one item per round trip cannot go through guest deliveries. Batch them, or keep them host-side.
  - This needs profiling (fsync versus per-crank GC versus hub writes) before more design is built on it.
- **MISFIT (robustness).** A crank that exceeds the computron budget (10M, roughly under 1M simple loop iterations) or the heap ceilings, with no GC inside a crank, **retires the vat's session**. Oversized model outputs, tool results, transcript projections and prompt builds can permanently break a session vat. Inputs must be bounded and work chunked across cranks.
- **INCOMPATIBILITY.**
  - The Ironhorse `TextDecoder` streaming mode is wrong across chunk boundaries for multi-byte UTF-8.
  - `Date.now`, `Math.random`, timers, `fetch`, `URL`, `atob`, `console` and `crypto` are absent or throwing in guests.
  - `Uint8Array` and immutable `ArrayBuffer` are not passable to guests over OCapN in this build.
- **INCOMPATIBILITY (security).** Guest heap snapshots and `journal.jsonl` store values in plaintext, so secrets must never enter a guest heap. Keep them in a host resource.
- **NOTE.** Host-owed answers are at-most-once across restart. An in-flight model call or container exec rejects at restart, so the guest must record intent and re-issue (or stay dormant until a message, per the user's decision).
- **NOTE.** The XS engine (`makeXsEngine`) binary is not built in T, so XS was not probed. XS has a correct `TextDecoder` and a different cost profile [inferred]. It is worth measuring once built (`cargo build --release -p thixotrope-xs-worker`, which needs the `c/moddable` submodule).
