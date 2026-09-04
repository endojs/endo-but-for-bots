# Familiar for Android: System Assistant and Settings Bridge

| | |
|---|---|
| **Created** | 2026-06-30 |
| **Author** | Aaron Kumavis (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

A user wants their Endo-daemon AI agent (Floot) to do two things on their
Android phone:

1. **Configure system settings** for them — brightness, Do Not Disturb, Wi-Fi,
   volume, launching apps, and similar device state.
2. **Replace the built-in voice assistant** (Gemini / Google Assistant) so the
   assist gesture and "talk to my assistant" entry point reaches Floot instead.

Neither is possible from where Floot lives today.
A browser PWA has no access to Android system state, and a remote Endo daemon
cannot reach into the phone either.
Android gates both capabilities behind **on-device, privileged OS
integration**: changing secure settings requires privileged authority, and
becoming the assistant requires implementing a specific Android service and
being selected by the user as the default.

The naive solution — a normal Android app that holds every permission and wraps
an LLM — throws away the property that makes Endo worth using.
That app would have *ambient authority*: the model behind it could change
anything, with no structural limit.
The problem is therefore not just "get the bits to move" but "let the agent act
on the device **under least authority**, holding only the specific, revocable
powers the user granted."

## Design

### Overview

Add **Familiar for Android**: a thin native Android app that acts as an *Endo
host node on the phone*.
It is the Android analog of the desktop Familiar
([familiar-electron-shell](familiar-electron-shell.md)).

The app does three jobs and nothing more:

1. **Be the assistant.** It registers as the system's default digital assistant
   so the assist gesture launches Floot.
2. **Hold delegated OS authority.** It owns whatever privileged channel the user
   grants (Shizuku, ADB, Device Owner, …) for writing settings.
3. **Bridge that authority to the agent as object capabilities.** It connects to
   the user's Endo daemon over CapTP and introduces typed, narrow system
   capabilities into the agent's petstore.

Crucially, **the brain stays in the daemon.**
The Floot factory, the LLM, the API key, and the conversation history remain
where they already are (`packages/floot/agent.js`).
The phone app is a *capability provider* and *voice front-end*, not an LLM
runtime.
This mirrors the rest of Floot: the UI and the device are clients; the agent is
a daemon caplet.

```
   Android phone                          Endo daemon (your PC / edge / tailnet)
 ┌───────────────────────────┐          ┌──────────────────────────────────────┐
 │ Familiar for Android      │          │  floot-factory (LLM brain, history)   │
 │  • VoiceInteractionService│  CapTP   │                                       │
 │    (default assistant)    │◀────────▶│  agent's petstore receives:           │
 │  • privilege backend      │  (TCP/   │    android  → AndroidSystem cap        │
 │    (Shizuku/ADB/DO/…)     │   iroh/  │    screen   → ScreenContext cap        │
 │  • AndroidSystem exo ─────┼──ws)─────┼▶   (mic/tts → device voice, optional)  │
 │  • mic + assist gesture   │          │                                       │
 └───────────────────────────┘          └──────────────────────────────────────┘
```

### Component 1 — Replace the assistant

Android explicitly supports replacing the assistant:

- Implement a `VoiceInteractionService` plus a `VoiceInteractionSessionService`,
  and request `RoleManager.ROLE_ASSISTANT`.
- The user selects Familiar as the **default digital assistant** in Settings.
- The assist gesture (long-press home / power-button hold) then launches
  Familiar's session, which opens the mic and runs the voice loop.
- The session can receive on-screen context via `onHandleAssist`
  (the assist structure plus a screenshot), which becomes a *separate,
  revocable* screen-context capability the agent may use for "what's on my
  screen" tasks.

The trigger is the **assist gesture/button**, not a third-party always-on
hotword.
Reliable always-on hotword detection is restricted for third-party apps on
Android; once the session mic is open, Floot's existing VAD
(`packages/chat/floot-component.js`) handles endpointing.

The voice loop reuses Floot's existing streaming wires unchanged —
`transcribe(audioReader) -> textReader`, `converse(text) -> replyReader`, and
`synthesize(textReader) -> audioReader`.
The STT/TTS implementation behind those wires is swappable (see Design Decision
5): Android-native `SpeechRecognizer`/`TextToSpeech`, the in-browser
[`@endo/floot-web-voice`](../packages/floot-web-voice) WASM backends running in
a WebView (WebGPU on the Tensor GPU), or the daemon's voice caplets over the
network.

### Component 2 — Configure system settings, as a capability

The app exposes **one typed capability**, not a raw shell.
It is a `makeExo` with an `M.interface` guard, granted into the agent's
petstore under a pet-name (e.g. `android`):

```js
const AndroidSystemInterface = M.interface('AndroidSystem', {
  // Reads/writes are restricted to an allowlisted set of setting keys.
  getSetting: M.callWhen(M.string()).returns(M.string()),
  setSetting: M.callWhen(M.string(), M.string()).returns(M.undefined()),
  setBrightness: M.callWhen(M.number()).returns(M.undefined()),
  setDoNotDisturb: M.callWhen(M.boolean()).returns(M.undefined()),
  setWifiEnabled: M.callWhen(M.boolean()).returns(M.undefined()),
  launchApp: M.callWhen(M.string()).returns(M.undefined()),
  help: M.call().returns(M.string()),
});
```

The agent calls it the same way it calls any capability —
`await E(android).setBrightness(0.5)` — exactly the idiom the `full-control`
preset already uses for the `endo` host reference (`packages/floot/agent.js`),
except this reference is the phone's system facet, scoped down to an
allowlisted, typed surface.

Behind the exo sits a **pluggable privilege backend** that supplies the actual
OS write authority.
The capability is the boundary; the backend is an implementation detail,
swappable the way `floot-stt` / `floot-tts` are swappable:

| Backend | Authority | Friction | Notes |
|---|---|---|---|
| **Shizuku / Dhizuku** | `WRITE_SECURE_SETTINGS` via a user-run ADB-privileged service | User runs a service once; no root | Recommended on-device default |
| **ADB over wireless debugging** | `settings put`, `cmd`, `input` driven by the daemon off-device | Pair once | The daemon holds the ADB cap; the phone need not run the agent |
| **Device Owner** (`DevicePolicyManager`) | Broad, policy-grade settings + restrictions | Factory-reset provisioning | Locked-down / enterprise |
| **Accessibility Service** | Drives the Settings UI like a human | Brittle; Play-restricted | Fallback for toggles unreachable above |
| **Root (`su`)** | Everything | Unlocked bootloader | Power-user |

### Connection and identity

The phone app joins the daemon as a networked Endo node over the daemon's
existing transports (CapTP over TCP / iroh / WebSocket; see
`packages/daemon/src/networks/`).
Pairing reuses the daemon's invitation/locator mechanism and the gateway's
bearer-token auth ([gateway-bearer-token-auth](gateway-bearer-token-auth.md)).
Once paired, the app *introduces* its capabilities into the target agent's
petstore — the same provisioning move `provisionPresetObjects` makes for the
`full-control` preset, but the introduced objects are the phone's system facets.

### Security model

This is where the object-capability model earns its keep, and it is the same
advantage [endoclaw](endoclaw.md) draws against OpenClaw's ambient authority:

- The agent holds **only** the specific typed methods the host granted — not a
  shell, not raw `WRITE_SECURE_SETTINGS`.
- Each capability is independently grantable and **revocable** via the daemon's
  caretaker pattern; the agent can hold `android` without `screen`, or
  brightness control without app-launch, by handing out attenuated facets.
- Every method is guarded by `M.interface`, so malformed calls are rejected at
  the boundary.
- Destructive or irreversible changes follow the `full-control` persona's
  rule — "say plainly what you are about to do and wait for the user to agree"
  (`packages/floot/agent.js`) — enforced by a confirmation step in the app.

**Risk register.** `WRITE_SECURE_SETTINGS`, Device Owner, and raw ADB are
powerful. Mitigations are structural: keep the cap surface narrow and typed,
allowlist settable keys, never expose raw shell to the agent, require
confirmation for destructive writes, and log every write the app performs.

## Dependencies

| Design | Relationship |
|---|---|
| [familiar-electron-shell](familiar-electron-shell.md) | Sibling — this is the Android analog of the desktop Familiar companion. |
| [endoclaw-voice](endoclaw-voice.md) | Related — voice-input approaches for the assistant surface. |
| `@endo/floot` + `@endo/floot-web-voice` | Reused — the agent brain (`converse`) and the WASM STT/TTS backends behind the voice wires. |
| [gateway-bearer-token-auth](gateway-bearer-token-auth.md) | Required — authenticated remote link between phone and daemon. |
| [daemon-capability-bank](daemon-capability-bank.md) | Extends — adds an `AndroidSystem` / device-control category to the capability taxonomy. |

## Phased Implementation

1. **Off-device prototype (validate the loop).** A daemon-side `android-adb`
   caplet holds a wireless-debugging ADB connection and exposes the typed
   `AndroidSystem` cap; a minimal sideloaded assistant app provides the trigger
   and mic, bridging voice to the daemon. Proves the end-to-end
   "agent changes a setting by voice" loop with the least new native code.
2. **On-device companion.** The Familiar-for-Android app becomes the default
   assistant *and* uses Shizuku for settings (no cable, no root), exposing the
   typed cap to the daemon over CapTP and reusing the
   `transcribe`/`converse`/`synthesize` wires.
3. **Screen context and app control.** Add the `onHandleAssist` screen-context
   capability and an app-launch / intent capability; broaden the device caps
   (DND, media, connectivity).
4. **Policy-grade control.** Device Owner provisioning for first-class settings
   and restrictions, plus an in-app grant/revoke UI for each capability.

## Design Decisions

1. **A capability bridge, not an ambient app.** The whole point of using Endo is
   least authority; a mega-permission assistant app would discard it. The agent
   gets typed, revocable facets, not the device.
2. **The brain stays in the daemon.** The phone is a capability provider and
   voice front-end; the LLM, the API key, and conversation history stay central,
   matching the existing Floot factory topology. This also keeps secrets off the
   phone's trust boundary.
3. **One typed capability, pluggable privilege backend.** Shizuku, ADB, Device
   Owner, accessibility, and root all sit behind the same `AndroidSystem` exo, so
   the privilege mechanism can change without touching the agent — the same swap
   seam as `floot-stt` / `floot-tts`.
4. **Assistant via `VoiceInteractionService` + `ROLE_ASSISTANT`.** This is the
   only OS-sanctioned way to replace Gemini, and it also yields the gesture
   trigger and on-screen context for free.
5. **Reuse Floot's voice wires.** `transcribe`/`converse`/`synthesize` are
   unchanged; only the STT/TTS implementation behind them varies by surface
   (native, WASM-in-WebView, or remote caplet), so nothing is re-specified.
6. **Trigger on the assist gesture, not a third-party hotword.** Always-on
   hotword is unreliable/restricted for third-party apps; the gesture is
   dependable and Floot's VAD takes over once the mic is open.

## Known Gaps and TODOs

- [ ] Pick the first privilege backend to ship (Shizuku vs daemon-driven ADB).
- [ ] Decide the voice surface: Android-native vs `@endo/floot-web-voice` in a
      WebView vs remote caplets.
- [ ] Define the allowlist of settable keys and the full typed cap surface.
- [ ] Pairing/auth flow between the phone host and the daemon (reuse invitation
      + bearer token).
- [ ] Confirmation UX for destructive / irreversible setting writes.
- [ ] Distribution: Play Store policy (assistant role, accessibility,
      `WRITE_SECURE_SETTINGS`) vs sideload-only.
- [ ] Always-on hotword feasibility (Porcupine / openWakeWord) within battery
      and policy limits.
- [ ] Revocation UI: per-capability grant/revoke surfaced in the app and the
      daemon.

## Prompt

> how can I get an endo daemon based AI agent to configure my android system
> settings for me and replace the built in voice assistant
>
> (Follow-up: "Design the Android host" — a designs/ doc for an Endo Android
> companion: VoiceInteractionService assistant role + a typed settings
> capability bridge connecting to the daemon over CapTP, planning before code.)
