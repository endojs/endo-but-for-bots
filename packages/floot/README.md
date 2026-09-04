# @endo/floot

A streaming LLM agent harness for the Endo daemon, plus the two voice caplets
that make it a hands-free voice assistant.

- **Factory** (`agent.js`) — a fae-like factory that owns one guest per chat
  session and exposes `converse(text) -> replyReader`, a pull-based stream of
  reply-token deltas (`src/stream.js`).
- **Voice caplets** (`voice/`) — two independent, swappable daemon objects:
  - `floot-stt` — speech-to-text via [Moonshine](https://github.com/moonshine-ai/moonshine)
    (`voice/audio-server-caplet.js`): `transcribe(audioReader) -> textReader`.
  - `floot-tts` — text-to-speech via [piper](https://github.com/rhasspy/piper)
    (`voice/tts-server-caplet.js`): `synthesize(textReader) -> audioReader`.

The browser UI lives in [`@endo/chat`](../chat); a Chat Space looks these three
objects up by pet-name and streams to/from them.

## Demo dependencies

Everything below must be present on the machine running the Endo daemon (the
caplets are unconfined and spawn these as subprocesses).

| Dependency | Used by | Notes |
| --- | --- | --- |
| Endo daemon + `endo` CLI | everything | Built from this monorepo (`yarn build`); start with `endo start`. |
| `ANTHROPIC_API_KEY` | factory | Anthropic API key for the LLM. Passed via a capability handle, never stored in caplet env. |
| [`uv`](https://docs.astral.sh/uv/) | `floot-stt` | Runs `voice/moonshine_daemon.py`, which is PEP-723 self-contained — `uv` installs `moonshine-voice` and downloads the model on first run. No project Python env needed. |
| [`piper`](https://github.com/rhasspy/piper) binary | `floot-tts` | Standalone TTS engine. Point `FLOOT_TTS_BINARY` at it (default `piper` on PATH). |
| A piper voice model | `floot-tts` | A `<voice>.onnx` plus its companion `<voice>.onnx.json` (the `.json` supplies `audio.sample_rate`). `FLOOT_TTS_MODEL` is the absolute path to the `.onnx`. |

### Getting a piper voice

Download a voice and its companion config from the official
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) mirror.
For `en_GB-alba-medium`:

```sh
mkdir -p ~/.floot/piper-voices && cd ~/.floot/piper-voices
base=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium
curl -LO $base/en_GB-alba-medium.onnx
curl -LO $base/en_GB-alba-medium.onnx.json
```

The voice id encodes its path: `en_GB-alba-medium` → `en/en_GB/alba/medium/`.

## Setup

1. **Start the daemon** (once): `endo start`.

2. **Provision the factory.** Copy `.env.example` to `.env`, fill in
   `ANTHROPIC_API_KEY` (and optionally `FLOOT_MODEL`), then:

   ```sh
   ./setup-factory.sh           # or: ./setup-factory.sh path/to/.env
   ```

   Creates the pinned `floot-factory` and a default session.

3. **Provision the voice caplets.** Ensure `uv`, `piper`, and a voice model are
   present, then:

   ```sh
   FLOOT_TTS_MODEL=~/.floot/piper-voices/en_GB-alba-medium.onnx ./setup-voice.sh
   ```

   Or with an `.env` that sets `FLOOT_TTS_MODEL` (plus optional
   `FLOOT_TTS_BINARY`, `FLOOT_TTS_SPEED`, `FLOOT_STT_LANG`):

   ```sh
   ./setup-voice.sh
   ```

   Stands up `floot-stt` (warms up Moonshine) and `floot-tts`.

4. **Open the UI.** In [`@endo/chat`](../chat): `yarn dev`.
   Create a Chat Space and set its object paths to `floot-factory`, STT path
   `floot-stt`, TTS path `floot-tts`.

## Swapping an implementation

`floot-stt` and `floot-tts` are separate daemon formulas, each behind its own
pet-name. To use a different engine, provision a replacement object exposing the
same interface (`transcribe` / `synthesize`) under the same pet-name — no change
to the factory or UI is required.

## Subagents

A session may delegate to a subagent session and converse with it over the
daemon mailbox, using `spawnSubagent`, `askSubagent`, and `stopSubagent`.
A subagent session runs on its parent's backend and model, records its parent in
the session registry, and is released with it.
Set `FLOOT_MAX_SUBAGENT_DEPTH=0` to withhold the tools entirely.
See [@endo/fae's SUBAGENTS.md](../fae/SUBAGENTS.md).

## Provider credentials

`floot-factory-setup.js` puts `ANTHROPIC_API_KEY` in the daemon's secret manager
under `secrets/floot-auth` and hands the factory the `SecretBlob`; the
`floot/llm-provider` value carries no credential.
Re-running setup without the key in the environment keeps the secret already in
the manager, and re-running it *with* a key replaces the bytes of the existing
record rather than minting a second one, so delegated capabilities stay valid.

A turn reads the secret afresh and the provider cache is keyed on the bytes, so
a rotation or a revocation reaches every open session by itself, on that
session's next turn — no daemon restart, and no call to make.
`refreshCredentials()` is for a change to the provider *config* — a different
host, provider kind, or default model bound at `floot/llm-provider` — which is
read once and would otherwise need a restart.

## Plan and rate limits

`getAccount(refresh?)` on the factory, and on each session facet, reports the
subscription plan behind this deployment's credential, how much of each rate
limit is left, and — per session — what the conversation has cost at the current
list price.
A provider-backed session also gets an `accountStatus` tool, so the model can
answer those questions where the user asked them.
A session on a hosted backend does not: it runs the backend's own tool loop over
a tool set projected before the session agent exists.
`getAccount(refresh?)` answers the same questions to a UI either way.

Every figure carries `observedAt` and a source of `observed`, `declared`,
`remembered`, or `unavailable`, so a declared figure is never mistaken for a
measured one.
Provision it by pointing `FLOOT_ACCOUNT_PROFILE` at a JSON profile when running
setup; without one, `getAccount()` reports that no oracle is available and the
tool is absent.
See [@endo/hosted-agent's ACCOUNT-ORACLE.md](../hosted-agent/ACCOUNT-ORACLE.md).
