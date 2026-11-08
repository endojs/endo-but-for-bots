# @endo/floot

Floot is the web and Android presentation for Fae sessions and owns their speech input and output pipeline. Its retained controller entry point adds speech to the Fae factory. See [Fae sessions](../fae/SESSIONS.md) for execution, storage, recovery, and provider configuration.

For the Secrets-backed OpenRouter API provider, see [OpenRouter setup](./OPENROUTER.md).

## Assistant presets

In the shared web/Android UI, open Settings → Assistant presets → Manage presets.
Edit a preset's instructions, model, reasoning effort, default objects and internet policy;
save a copy to create a custom preset, or reset a built-in preset.
The Voice shortcut selector chooses which preset Android assistant invocations use.

The built-in voice preset uses the OpenAI subscription pool and gpt-5.6-sol with an isolated Podman shell,
a workspace, and public internet enabled.
Internet policy belongs to the attached shell, independently of the inference backend.
With internet enabled, General receives a shell backed by private scratch storage.
Chat only starts offline with an empty object list. RSI includes a workspace,
shell, and capabilities for proposing PRs and reviewed updates on Tokyo Forgejo.
The new-session picker uses saved defaults unless explicitly overridden.

Additional endowments are explicit object paths, resolved once when granted.
Editing a name or copying a preset preserves that object identity across devices.
Presets are scoped to a Floot factory and stored in one bounded record.
Changes apply to new sessions; existing sessions and their delegates retain their
original instructions and authority recipe, even after a preset is deleted.
Delegates inherit their parent's current approved network policy.
Existing sessions without a shell need a new session to gain one.

Factory API: `getPresetConfiguration()` returns a revision and presets;
`savePreset(preset, revision)`, `deletePreset(id, revision)`,
`resetPreset(id, revision)` and `setVoicePreset(id, revision)` reject stale edits.
After a conflict or uncertain save, reload before retrying.
`createAssistantSession()` creates a spoken session from the selected voice preset.
Explicit grants have `{petName, sourcePath, value}` where `value` is an object capability;
these references stay in the host controller and are never passed to the confined view.

## Demo dependencies

Everything below must be present on the machine running the Endo daemon (the
caplets are unconfined and spawn these as subprocesses).

| Dependency | Used by | Notes |
| --- | --- | --- |
| Endo daemon + `endo` CLI | everything | Built from this monorepo (`yarn build`); start with `endo start`. |
| `ANTHROPIC_API_KEY` | factory | Anthropic API key for the LLM. Passed via a capability handle, never stored in caplet env. |
| [`uv`](https://docs.astral.sh/uv/) | `floot/stt` | Runs `voice/moonshine_daemon.py`, which is PEP-723 self-contained — `uv` installs `moonshine-voice` and downloads the model on first run. No project Python env needed. Optional: `FLOOT_STT_ENABLE=0` skips STT. |
| [`piper`](https://github.com/rhasspy/piper) binary | `floot/tts` | Standalone TTS engine. Point `FLOOT_TTS_BINARY` at it (default `piper` on PATH). |
| A piper voice model | `floot/tts` | A `<voice>.onnx` plus its companion `<voice>.onnx.json` (the `.json` supplies `audio.sample_rate`). `FLOOT_TTS_MODEL` is the absolute path to the `.onnx`. |

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

   Re-running the script is safe: it keeps the factory host and every session,
   re-creates only the factory caplet against the current checkout, and replaces
   the secret only when a key is given.
   A daemon that runs it from `ENDO_EXTRA` forwards only `ENDO_`-prefixed
   variables, so every knob is also read as `ENDO_FLOOT_*` and the key as
   `ENDO_FLOOT_AUTH_TOKEN`.
   `FLOOT_MAX_TOOL_ROUNDS` (default 1024, shared with standalone Fae) caps
   direct-provider rounds before the tool-step fallback. Each round is a model
   response plus all requested tool results; parallel calls share one round.
   The model's context window is accounted for separately.

3. **Provision the voice caplets.** Ensure `uv`, `piper`, and a voice model are
   present, then:

   ```sh
   FLOOT_TTS_MODEL=~/.floot/piper-voices/en_GB-alba-medium.onnx ./setup-voice.sh
   ```

   Or with an `.env` that sets `FLOOT_TTS_MODEL` (plus optional
   `FLOOT_TTS_BINARY`, `FLOOT_TTS_SPEED`, `FLOOT_STT_LANG`, `FLOOT_STT_UV`,
   `FLOOT_STT_ENABLE`, `FLOOT_DIR`):

   ```sh
   ./setup-voice.sh
   ```

   Stands up `floot/tts` first, then `floot/stt` (warms up Moonshine).
   The two halves are independent: STT is best-effort, so a missing `uv` or a
   failed Moonshine warmup only skips STT, and `FLOOT_STT_ENABLE=0` leaves it
   out of a TTS-only deployment.
   Like the factory setup, every knob is also read as `ENDO_FLOOT_*`, so a
   daemon can run `voice-setup.js` from `ENDO_EXTRA`.

4. **Open the UI.** In [`@endo/chat`](../chat): `yarn dev`.
   Create a Chat Space and set its object paths to `floot-factory`, STT path
   `floot/stt`, TTS path `floot/tts`.

## Swapping an implementation

`floot/stt` and `floot/tts` are separate daemon formulas, each behind its own
pet-name. To use a different engine, provision a replacement object exposing the
same interface (`transcribe` / `synthesize`) under the same pet-name — no change
to the factory or UI is required.

## Interactive replies

Floot and Fae can return local interactive widgets using an `endowidget` fence.
See [the widget protocol](../spaces-util/INTERACTIVE-WIDGETS.md) for examples,
confinement, lifecycle, and tests.


Session controls, pending submissions, and private journals share one owned
session directory.
See [factory-owned session storage](designs/session-storage-layout.md) for the
inventory layout, upgrade behavior, and recovery constraints.
