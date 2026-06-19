# Record Meeting Mode — implementation status (overnight 2026-06-16)

Implementing `RECORD-MEETING-MODE.md`. Foundational + prioritized pieces done & proven; the rest scoped.

## ✅ M0 — diarizing transcriber, DEPLOYED on tinix
The design's main de-risk (§4 speaker labelling) and the operator's explicit priority ("diarization would be great").
- **Backend: `meeting-diarize` service on tinix** (`docker`, `--restart unless-stopped`, `--network host`, port **8004**). Self-hosted **sherpa-onnx** offline diarization (non-gated models, **no HF token**, **CPU** — GPU5 untouched) + **speaches/whisper** (existing :8000) for text, aligned by time-overlap.
  - `GET tinix:8004/health` → `{ok, sample_rate:16000, threshold:0.7, backend:"sherpa-onnx+speaches"}`
  - `POST tinix:8004/diarize` (multipart wav) → `{segments:[{speaker,text,t0,t1}], speakers, nDiarSegments}`
  - Reachable from archua (LAN 192.168.50.226:8004 + tailnet 100.65.15.63:8004), like /stt reaches speaches.
  - Files on tinix: `~/meeting-diarize/` (diarize-server.py, models/, pylibs/). Models: `sherpa-onnx-pyannote-segmentation-3-0` + `3dspeaker…eres2net` embedding (both non-gated, from sherpa-onnx GH releases).
  - Manage: `docker {logs,restart,stop} meeting-diarize`.
- **Proven**: a 57s multi-speaker clip → 13 speaker-labelled segments, threshold-tunable (0.7 → 5 speakers; the clip is ~4-5). The diarized transcript reads correctly (narrator vs distinct voices).

## ✅ M1 (cap) — the `meetingScribe` capability
- `meeting-scribe.mjs` — `makeMeetingScribe({diarizeUrl})` → a hardened cap: `start({hints})`, `ingest(sid, audioBytes, mime)→{segments}`, `end(sid)→{transcript,speakers,segments}`, `help()`. The backend URL is **confined inside** the cap (callers get only the verbs — the design's "swappable Endo cap"). Self-host today; a cloud streaming diarizer drops into the same slot.
- **Proven**: `meeting-scribe-test.mjs` — the field agent ingested a real chunk via the cap → tinix backend → diarized transcript. ✅

## ⏳ Remaining (scoped — live-app / multi-day; needs operator product calls)
- **M1 rest (server + client):** a `/meeting/ingest` route (sibling of `/stt`) that calls `meetingScribe` + persists per-cap under `~/.local/state/voice-agent/meetings/`; `/meeting/load` for replay; client `startMeeting()` (open-mic + `MediaRecorder` timeslices) + live diarized-transcript view + Scribe advisor panel. (server.mjs + public/ — additive but live; needs a restart.)
- **M2 — PIN trusted-path:** in meeting mode, force destructive/auth verbs down the propose path (disable `dontAskAgain`); `/confirm` gains a PIN check before `commitProposal`. Salted PIN hash per root cap, rate-limited. (Voice can only PROPOSE; only a PIN-confirmed on-screen tap commits.)
- **M3 — Participant mode:** agent speaks (browser TTS → Moshi on tinix GPU4 :8998 for full-duplex); addressed-only → proactive; suppress self-audio from diarization.
- **M4 — Endo sharing:** `meetingSession` cap with attenuated `transcript`/`live` facets; share/revoke a read-only live transcript over the network — **rides the now-proven Iroh transport** (`makeIrohTransport`).
- **M5 — cloud backend opt-in:** Deepgram/AssemblyAI behind `meetingScribe` (per-session toggle, audio-leaves-building indicator).

## Known risks (from the design, confirmed)
- **Cross-chunk speaker-label continuity (§4, the hard one):** the backend diarizes each chunk OFFLINE, so labels are consistent within a chunk, not yet stitched across chunks. Fix at the backend: a streaming diarizer (diart), a rolling re-diarize window, or server-side embedding centroids per session. Solve before building much UI on top.
- **Participant latency** likely needs Moshi (full-duplex); Scribe mode has no such constraint → ship Scribe first.
- **Consent/retention/PIN-UX** are product calls (default Quiet/Scribe; visible recording indicator; PIN scoped to meeting sessions only).
