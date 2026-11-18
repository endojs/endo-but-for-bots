// @ts-check
/**
 * Interface guards and shapes of the speech objects the gateway serves to
 * pages (`designs/m11-interfaces.md` sections 3.2 and 4): the extras
 * service `Speech` (label `speech`) and the per-page `AudioPort`. Both are
 * gateway-local exos of the agent-host adapter (`AH/speech/`); no vat
 * holds one, and none is ever an argument toward a vat (they are marked
 * never to leave the gateway, m3-interfaces.md 4.4 rule 2).
 *
 * Node only: the gateway's vocabulary lists this module
 * (`vocabulary-tables.js`, one entry, seam H3), so the record keys a page
 * sends to these objects (`TtsOptions`) pass the key guard; no vat program
 * imports it. The guest prelude must be on `globalThis` before it is
 * imported.
 *
 * The factory's `Voice` and its records (`VoicePreferences`,
 * `SpeechSettings`, ...) are in `guards/factory.js` (contract section 3.1,
 * seam H1); this module only uses the shared values of
 * `voice-preferences.js`.
 *
 * The tables are answered by `speechGuards()`, built on first call and
 * kept (a guard costs about 1-25 ms to build, J-0201). A function export
 * is not a table to `test/adapter/gateway-vocabulary-tables.test.js`, so
 * this module does not turn that test red before WX.1 lists it in
 * `vocabulary-tables.js`; the fold (contract section 17, F-3) makes the tables
 * plain exports once the module is listed.
 */
import { limits } from './limits.js';
import { voiceLimits } from './voice-preferences.js';
import { text, list, record, count, R, done } from './guards/base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

/** Bounds of this module's records (UTF-16 units unless stated). */
export const speechGuardLimits = harden({
  /** `AudioPortGrant.token`: 32 bytes as 64 lowercase hex digits. */
  tokenUnits: 64,
  /** A voice's display name (R5-40: `English (US) — amy (medium)`). */
  voiceNameUnits: 256,
  /** Voices a configuration lists (`engine-protocol.js` `voiceFiles.maxVoices`). */
  voices: 128,
  /** A language tag (R5-16). */
  languageUnits: 32,
  /** A status or warning line. */
  noteUnits: 512,
  /** One inline replay piece: an inline text field (larger texts are Blobs). */
  replayPieceUnits: limits.inlineBytes,
  /** Pieces of one replay (`audio-protocol.js` `audioLimits.replayPieces`). */
  replayPieces: 64,
});

/** Method names per interface, in declaration order. */
export const speechMethodNames = harden({
  Speech: ['openAudio', 'configuration', 'status', 'replay'],
  AudioPort: ['transcribe', 'speak', 'close'],
});

/**
 * Build the tables (once, from `speechGuards`).
 */
const build = () => {
  /**
   * Synthesis options a page passes to `speak` and `replay` (R5-41). The
   * guard admits any number; the speech host checks finiteness, ranges
   * (`voice-preferences.js` `ttsRanges`) and the voice against its
   * catalogue and throws `speechTextOf.outOfRange` /
   * `speechTextOf.unknownVoice` (`AH/speech/audio-protocol.js`) before any
   * stream is opened.
   */
  const TtsOptions = record(
    {},
    {
      voice: text(voiceLimits.voiceUnits),
      speed: M.number(),
      noiseScale: M.number(),
      noiseW: M.number(),
      sentenceSilence: M.number(),
    },
  );
  /** One range of a numeric option (R5-42). */
  const OptionRange = record({
    min: M.number(),
    max: M.number(),
    step: M.number(),
  });
  /** One voice of the catalogue (R5-40). */
  const VoiceEntry = record({
    id: text(voiceLimits.voiceUnits),
    name: text(speechGuardLimits.voiceNameUnits),
    sampleRate: count,
  });
  /** The state of one direction of the speech host. */
  const DirectionState = M.or('off', 'idle', 'starting', 'ready', 'failed');

  const shapes = harden({
    TtsOptions,
    OptionRange,
    VoiceEntry,
    /**
     * A replay piece: an inline text (at most `inlineBytes` units), or the
     * Blob of a staged one (read through Content in process).
     */
    ReplayPiece: M.or(text(speechGuardLimits.replayPieceUnits), R('Blob')),
    /** What `transcribe`, `speak` and `replay` answer: the stream's number on the audio socket. */
    StreamGrant: record({ stream: count }),
    /** What `Speech.openAudio` answers: the port and the one-time token its socket sends in HELLO. */
    AudioPortGrant: record({
      port: R('AudioPort'),
      token: text(speechGuardLimits.tokenUnits),
    }),
    /** `Speech.configuration()` (A.5 `getConfiguration`, plus what is enabled). */
    SpeechConfiguration: record(
      {
        speechIn: M.boolean(),
        speechOut: M.boolean(),
        voices: list(VoiceEntry, speechGuardLimits.voices),
        defaults: TtsOptions,
        ranges: record({
          speed: OptionRange,
          noiseScale: OptionRange,
          noiseW: OptionRange,
          sentenceSilence: OptionRange,
        }),
      },
      {
        language: text(speechGuardLimits.languageUnits),
        warning: text(speechGuardLimits.noteUnits),
      },
    ),
    /** `Speech.status()`: the host's state, for the page and tests. */
    SpeechStatus: record(
      {
        speechIn: DirectionState,
        speechOut: DirectionState,
        ports: count,
        streams: count,
      },
      { error: text(speechGuardLimits.noteUnits) },
    ),
  });

  const interfaces = harden({
    /**
     * The extras service (label `speech`), one per adapter incarnation,
     * made by `GW/extensions/speech.js`.
     */
    Speech: M.interface('Speech', {
      openAudio: M.call().returns(shapes.AudioPortGrant),
      configuration: M.callWhen().returns(shapes.SpeechConfiguration),
      status: M.call().returns(shapes.SpeechStatus),
      /**
       * A replay of finished text on `port`'s socket (R5-45). On the
       * service, not the port, so the extension can name it a `LargeCall`
       * (one target per incarnation): a call up to `wsMessageBytes`.
       */
      replay: M.callWhen(
        R('AudioPort'),
        list(shapes.ReplayPiece, speechGuardLimits.replayPieces),
      )
        .optional(shapes.TtsOptions)
        .returns(shapes.StreamGrant),
    }),
    /**
     * One page's audio port, bound to one `/audio` socket by its token.
     * `speak` names the turn by its `turnId` inside the session's channel
     * (decision D-M11-7).
     */
    AudioPort: M.interface('AudioPort', {
      transcribe: M.callWhen().returns(shapes.StreamGrant),
      speak: M.callWhen(R('Session'), text(limits.idUnits))
        .optional(shapes.TtsOptions)
        .returns(shapes.StreamGrant),
      close: M.call().returns(done),
    }),
  });

  return harden({ shapes, interfaces });
};

/** @type {ReturnType<typeof build> | undefined} */
let built;

/**
 * The speech shapes (`TtsOptions`, `OptionRange`, `VoiceEntry`,
 * `ReplayPiece`, `StreamGrant`, `AudioPortGrant`, `SpeechConfiguration`,
 * `SpeechStatus`) and interface guards (`Speech`, `AudioPort`).
 */
export const speechGuards = () => {
  built ??= build();
  return built;
};
harden(speechGuards);

/** The gateway's vocabulary entry (`vocabulary-tables.js`, seam H3). */
export const vocabularyShapes = () => {
  const { shapes, interfaces } = speechGuards();
  return harden([...Object.values(shapes), ...Object.values(interfaces)]);
};
harden(vocabularyShapes);
