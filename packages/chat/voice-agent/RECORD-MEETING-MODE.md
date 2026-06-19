# Record Meeting Mode — design

A second microphone mode for the field agent: leave the mic open in a room with
other people, diarize who-said-what, and let the agent be helpful throughout —
either as a spoken **participant** or a silent **scribe & advisor** — while making
*authentication/authorization actions impossible to trigger by voice alone*.

Status: design only (worker-fork deliverable). Grounded in the current pipeline so it's actionable.

---

## 0. TL;DR

- Add a **meeting session** alongside today's turn-taking mic mode. It captures continuously, **chunks** audio, and runs it through a **diarizing transcriber** (speaker-labelled segments) instead of the single-blob `/stt` path.
- **Two sub-modes:** **Noisy (Participant)** — the agent can speak into the room (TTS / Moshi). **Quiet (Scribe & Advisor)** — the agent **never speaks**, only writes a live diarized transcript + private on-screen notes/advice to the operator.
- **The threat model flips:** anyone in the room can utter "unlock the door." So in meeting mode, **designation-by-voice is NOT authorization** — every destructive/auth action becomes an on-screen proposal gated by a **PIN** the operator enters on their own device. Voice can *propose*; only a PIN-confirmed on-screen tap can *commit*.
- **Diarization is a swappable Endo cap** (`meetingScribe`) — backend is **self-hosted by default** (whisperX/diart on tinix, reusing the existing faster-whisper) with a **cloud option for this mode only** (Deepgram/AssemblyAI streaming diarization). The client/agent never know which.
- Because the scribe is an **Endo object**, a live meeting (or a read-only transcript) is **shareable/revocable over the network boundary** (Iroh/ocapn) — e.g. hand another participant a read-only live-transcript cap.

---

## 1. What it is, vs the mic mode we have (the diff)

Today (`public/app.js`): `startMic` (`:427`) opens `getUserMedia({audio:{echoCancellation,noiseSuppression}})`, runs **VAD continuous listening + barge-in** (`:281`) assuming **one speaker** (you), records a `webm` blob per utterance (`:408`), POSTs it to **`/stt`** (`:393`) → one transcript → `/chat`. STT is **self-hosted faster-whisper** (`server.mjs:33`, `192.168.50.226:8000`, `faster-whisper-large-v3-turbo-ct2`, `vad_filter:true`, with a hallucination filter `:197`). TTS is **browser `speechSynthesis`** (`app.js:285 speak()`).

Meeting mode changes four things:

| | Mic mode (today) | Meeting mode |
|---|---|---|
| Speakers | one (you); barge-in = you over TTS | **many**; the agent is one optional voice among them |
| Capture | per-utterance blob on VAD-end | **continuous, rolling chunks** (e.g. 5–10s `MediaRecorder` timeslices) |
| Transcribe | `/stt` → flat text | **`/meeting/ingest`** → `[{speaker, text, t0, t1}]` diarized segments |
| Agent posture | always responds (spoken) | **mode-dependent**: Participant speaks, Scribe stays silent |
| Auth actions | propose → on-screen confirm | propose → **PIN-gated** on-screen confirm (voice can never commit) |

Everything else (the cap model, `/chat`, proposals, the trace) is reused.

---

## 2. The two modes

Picked when the session starts (long-press the 🎤 → mode sheet), switchable mid-meeting.

**Noisy — Participant.** The agent is a meeting attendee. It hears the diarized stream, and *responds out loud* when addressed (a wake-word/name, or an explicit "agent, …") or when it judges a contribution is wanted (configurable: addressed-only vs proactive). Speaking uses today's `speak()` (browser TTS) or, ideally, **Moshi** (the full-duplex voice model standing up on tinix GPU4) so it can converse naturally without clobbering the room. Echo-cancellation already on; in Participant mode the agent must also **not transcribe its own TTS** as a participant (tag/suppress self-audio).

**Quiet — Scribe & Advisor.** The agent **emits zero audio**. It maintains a **live diarized transcript** and a **private advisor panel** on the operator's screen: running summary, action items, "you were asked X / you said you'd Y", fact lookups it did silently, and *draft* responses/proposals the operator can use. Nothing leaves the operator's screen; the agent is an earpiece-less teleprompter. This is the safer default and the one most useful in real meetings.

Both modes share the same capture + diarization; they differ only in **output channel** (room audio vs operator screen) and **proactivity**.

---

## 3. Speaker diarization — a swappable Endo cap

Whisper alone does **not** diarize. We need a transcriber that returns speaker-labelled segments, and the spec calls for self-host-preferred with a cloud option *for this mode*. Model it as **one Endo capability, `meetingScribe`**, with a small interface and interchangeable backends (this mirrors the existing **"swappable audioProcessor endo cap"** pattern from the iOS voice-capture pipeline):

```
meetingScribe = Far('MeetingScribe', {
  start({ hints }) -> sessionId            // open a diarization session (rolling speaker state)
  ingest(sessionId, audioChunkBytes, mime) -> { segments:[{speaker, text, t0, t1, conf}], partial? }
  end(sessionId) -> { transcript, speakers, summaryHints }
  help()
})
```

Backends behind that cap (chosen by config, invisible to caller):

- **Self-host (default): whisperX or diart on tinix.**
  - *whisperX* = faster-whisper (we already run it) + **pyannote** alignment + diarization; batch/near-real-time on a rolling window. Highest reuse of existing infra; needs a HF token for pyannote + a GPU slot.
  - *diart* = streaming diarization built on pyannote — true incremental speaker labels, better for live. More moving parts.
  - Either keeps **audio on tinix** (privacy-preferred) and reuses the LAN whisper service.
- **Cloud (this-mode opt-in): Deepgram / AssemblyAI / Gladia / Speechmatics** — first-class **streaming diarization**, lowest latency, consistent speaker labels across the whole session (the hard part — see §4). Cost + **audio leaves the building** (consent/privacy — §7). The user explicitly OK'd cloud *for this mode only*; gate it behind an explicit per-session toggle, never the default.

Because it's one cap, switching self-host↔cloud is a config flip with no client/agent change, and a future better self-hosted diarizer drops in the same slot.

---

## 4. The capture pipeline

```
client open-mic ──(MediaRecorder timeslice ~5–10s)──▶ POST /meeting/ingest {cap, sessionId, chunk}
   server ──▶ meetingScribe.ingest() ──▶ diarized segments
   server ──▶ append to the session's live transcript (per-cap, like CHATS_DIR)
   segments ──▶ (Scribe) advisor panel  |  (Participant) feed the agent for a spoken reply
```

- **Client:** new `startMeeting()` beside `startMic()` — same `getUserMedia`, but `MediaRecorder` with a **timeslice** so chunks stream during the meeting rather than one blob at the end. Keep echo-cancel/noise-suppress on. A **visible recording indicator** is mandatory (consent).
- **Server:** a `/meeting/ingest` route (sibling of `/stt` at `server.mjs:332`) that calls `meetingScribe` instead of `transcribe()`, and a `/meeting/load` (like `/memos/load`) for reconnect/replay. Persist the diarized transcript per-cap under `~/.local/state/voice-agent/meetings/`.
- **The hard problem — label continuity.** Per-chunk diarization gives *inconsistent* speaker numbers across chunks (chunk A's "Speaker 1" ≠ chunk B's). Three ways out, in order of preference: (a) a **streaming diarizer** that holds speaker state across the session (diart, or cloud streaming) — cleanest; (b) **re-diarize a rolling window** (last N seconds) and stitch; (c) **voice-embedding centroids** kept server-side per session and matched per chunk. Pick (a) if the backend supports it; this is the main technical risk.
- **Optional speaker naming:** diarization yields anonymous labels. Optionally enroll the operator's voice → "you" and known contacts' embeddings → names (privacy-heavy; opt-in). **Not load-bearing for auth** — the PIN is (see §5) — but nice for the transcript.

---

## 5. Trusted-path auth: PIN-gated, on-screen, never voice

The code already flags the core risk (`server.mjs:667`: *a mistranscribed "unlock the door" must never auto-fire*) and has `NEVER_AUTO={home-assistant,spawn-specialist}`. Meeting mode makes this **structural**, because now *anyone in the room* — or a TV in the background — can speak a command:

- **Voice can only PROPOSE.** In a meeting session, the agent's destructive/auth verbs are forced down the existing **propose path** (`getProposal`/`commitProposal`); *no* "don't ask again" / auto-confirm rule fires (meeting mode disables `dontAskAgain` entirely). This reuses what's there — it just removes the auto-fire escape hatch.
- **Commit requires a PIN on the operator's device.** The on-screen confirm card (today `/confirm`) gains a **PIN entry** in meeting mode. The server checks the PIN before `commitProposal`. This is the **trusted path**: an unspoofable operator→system channel that neither a room speaker nor agent-rendered content can forge. (Same principle as the trusted-path work in the visionOS handoff: authority transfers only by an explicit operator action the environment can't fake.)
- **Why a PIN and not just a tap:** in a room the device may be visible/handed around; a bare tap can be coerced or fat-fingered by someone else. The PIN binds the commit to *the operator who knows it*. Store a salted PIN hash per root cap; rate-limit attempts; the PIN is **never** spoken back or shown.
- **Designation≠authorization, in meeting mode.** The field's usual "designation IS authorization" (speak it → it's authorized) is **suspended for auth actions here** — by design. Plain talk still *drives* the agent (look things up, draft, summarize); it just can't *cross the authority boundary* without the PIN. Quiet/Scribe mode goes further: the agent never auto-acts at all, only drafts proposals.
- Read-only / harmless verbs (search, summarize, draft, look up a contact) stay frictionless — only the propose-gated kinds get the PIN.

---

## 6. Endo-object wrapping + sharing over the boundary

Wrap the whole thing as Endo objects so a meeting is a **capability**, not an endpoint:

- **`meetingScribe`** (§3) — the transcription/diarization service as a cap. Self-host or cloud behind it.
- **`meetingSession`** — a live meeting as a cap: `transcript()` (read), `live()` (subscribe to new segments), `note()` (scribe advice), `propose()`/`commit(pin)`. Attenuable: hand a **read-only `transcript`/`live` facet** to another participant so they see the running transcript on their own device without any authority to act. Revocable from the operator's inventory (the same caretaker-revocation pattern used for GpuLease).
- **Over the network boundary:** because these are Endo objects on CapTP, they ride the planned **Iroh** transport — a meeting cap becomes a dial-by-pubkey link with no open port, attenuated (read-only share) and revocable. "Share the live transcript with Alice" = mint an attenuated `live`-only cap and send the link; "kick Alice" = revoke it. This is exactly the share/revoke story the field already has for other caps, applied to a meeting.

---

## 7. Where it runs · privacy · consent

- **Self-host (default, privacy-preferred):** whisperX/diart on tinix; audio never leaves the LAN; reuses the faster-whisper service. This should be the default and the only mode used for sensitive meetings.
- **Cloud (opt-in, this-mode-only):** Deepgram/AssemblyAI for best streaming diarization/latency — but **audio leaves the building**. Gate behind an explicit, per-session, clearly-labelled toggle; never default; show "audio is going to <provider>" in the recording indicator. (The user explicitly allowed cloud *just for this mode*.)
- **Consent:** open-mic capture of other people is an ethics/consent surface, not just a tech one. Mandatory **visible recording indicator**; a spoken/ళshown notice option; default to **Quiet/Scribe** (notes for you) rather than anything that broadcasts; retention controls on the stored transcript. Worth a short norms note before shipping.

---

## 8. UI sketch

- **Entry:** long-press 🎤 (today it's tap-to-talk, `app.js:438`) → a small sheet: **Talk** (today's mode) · **Meeting: Scribe** · **Meeting: Participant** · [self-host ⇄ cloud toggle].
- **Meeting view:** a live **diarized transcript** (speaker chips: "You", "Speaker 2", or enrolled names), auto-scrolling; a persistent **recording indicator**; a **mode switch** (Scribe⇄Participant). In Scribe mode, a side **Advisor panel**: running summary, action items, "you owe X an answer", silent lookups, draft replies (tap to speak/send). Cap-hygiene holds (no swissnum rendered).
- **Auth card:** the existing confirm card + a **PIN field**; "✓ confirmed" only after PIN check. Voice never reaches it.

---

## 9. Milestones

- **M0 — diarizing transcriber cap.** Stand up `meetingScribe` with a self-hosted whisperX/diart backend on tinix; prove `ingest(chunk) → speaker-labelled segments` on a 2-person recording. (De-risks §4 label continuity first — the main unknown.)
- **M1 — Scribe mode, no auth.** Client open-mic + chunked `/meeting/ingest`; live diarized transcript + a basic advisor panel; agent silent. Read-only, no destructive verbs.
- **M2 — PIN trusted-path.** Meeting-mode proposals + PIN-gated `/confirm`; disable auto-confirm in meeting mode; verify a spoken "unlock" only ever *proposes*.
- **M3 — Participant mode.** Agent speaks (browser TTS first, then Moshi); addressed-only → proactive; self-audio suppression.
- **M4 — Endo sharing.** `meetingSession` cap with attenuated `live`/`transcript` facets; share/revoke a read-only transcript over the network (rides Iroh once that lands).
- **M5 — Cloud backend option.** Deepgram/AssemblyAI behind `meetingScribe` as an explicit per-session toggle, with the audio-leaves-building indicator.

---

## 10. Open questions / risks

- **Streaming speaker-label continuity** (§4) is the main technical risk — solve it at the backend (streaming diarizer) before building UI on top.
- **Latency in Participant mode:** chunked diarize→transcribe→LLM→TTS is too slow for natural turn-taking; Participant mode probably *needs* Moshi (full-duplex) to feel real — Scribe mode has no such constraint and should ship first.
- **PIN UX vs friction:** a PIN on every auth action is correct for a room but annoying solo — scope the PIN to **meeting sessions only**; keep solo mic mode on the current tap-confirm.
- **Self-audio loop in Participant mode:** the agent's TTS must be excluded from diarization (don't transcribe yourself as "Speaker 5").
- **Consent/retention** (§7): decide defaults (auto-delete? keep in the vault?) and a norms note before real use.
- **Cost (cloud):** streaming diarization APIs bill per-minute; meetings are long — show running cost if cloud is on.
- **Enrollment/voiceprints** (optional naming) is privacy-sensitive PII — keep opt-in and local.
