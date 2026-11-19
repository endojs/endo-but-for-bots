// @ts-check
/**
 * The adapter-internal shapes the speech units build against
 * (`designs/m11-interfaces.md` section 3.3): speech-in and speech-out
 * engines, the sinks they report to, the speech text pipeline and the
 * speech view of a turn. JSDoc types only, so W11.1-W11.5 can be built in
 * parallel; nothing here crosses a vat or the hub (all are plain Node
 * objects of the agent-host process, made per incarnation).
 *
 * Rules every implementation keeps:
 * - Methods never throw for a stream's failure: they report it to the
 *   stream's sink once (`abort(reason)`, `reason` one of
 *   `audio-protocol.js` `speechTexts`), and the stream is then over. A
 *   sink method is called at most once after the stream is over: never.
 * - Every timer is a host timer (`node:timers`, unref'd) owned by the
 *   stream or engine that set it and cleared when it ends.
 * - No text, transcript, key, command argument or path is logged; log
 *   events are `engine-protocol.js` `speechLogEvents` with kinds and counts.
 */

/**
 * @typedef {'off' | 'idle' | 'starting' | 'ready' | 'failed'} DirectionState
 *   `idle`: configured, no engine running (lazy, D-16); `failed`: the last
 *   start failed and the restart pacing holds the next one
 *   (`engine-protocol.js` `engineRestart`)
 */

/**
 * @typedef {object} UtteranceSink where one utterance's results go (the
 *   audio route forwards each as an EVENT frame)
 * @property {(phase: 'listening' | 'transcribing') => void} phase
 * @property {(text: string) => void} partial the whole transcript so far
 *   (replace, not append; R5-14)
 * @property {(text: string) => void} final the whole transcript; the
 *   utterance is over
 * @property {(reason: string) => void} abort the utterance is over
 */

/**
 * @typedef {object} Utterance one open utterance of a speech-in engine
 * @property {(pcm: Uint8Array) => void} audio 16 kHz mono s16le; a
 *   trailing odd byte is dropped (R5-12); over `audioLimits.utteranceBytes`
 *   in all the engine ends the utterance itself (final follows)
 * @property {() => void} end the final follows within
 *   `audioTimeouts.engineTimeoutMs` or the utterance aborts with
 *   `speechTexts.engineTimeout`
 * @property {() => void} abort no further sink call
 */

/**
 * @typedef {object} SttEngine one per speech host and settings revision
 * @property {() => DirectionState} state
 * @property {(sink: UtteranceSink) => Utterance} open synchronous; starts
 *   the engine if it is not running (respawn on next use, R5-15); a start
 *   failure aborts the utterance with `speechTexts.engineUnavailable`
 * @property {() => Promise<void>} warm start now if idle (R5-15 "warmed
 *   when the service is created"); resolves when ready or failed; never
 *   rejects
 * @property {() => Promise<void>} stop abort every open utterance with
 *   `speechTexts.serviceStopped`, then end the engine (SIGTERM, SIGKILL
 *   after `audioTimeouts.killGraceMs`)
 */

/**
 * @typedef {object} TtsVoice one catalogue entry (R5-40)
 * @property {string} id
 * @property {string} name e.g. `English (US) — amy (medium)`
 * @property {number} sampleRate
 */

/**
 * @typedef {object} TtsCatalogue what `Speech.configuration()` reports
 *   for speech out
 * @property {readonly TtsVoice[]} voices at most `voiceFiles.maxVoices`
 * @property {{ voice: string, speed: number, noiseScale: number, noiseW: number, sentenceSilence: number }} defaults
 *   configured service defaults over `voice-preferences.js` `ttsDefaults`
 * @property {string} [warning] e.g. the default voice is unusable, so speech
 *   out is off (R5-40, R5-58)
 */

/**
 * @typedef {object} CheckedTtsOptions every field present, each checked
 *   (finite, in `ttsRanges`, a catalogue voice) by `checkTtsOptions`
 * @property {string} voice
 * @property {number} speed
 * @property {number} noiseScale
 * @property {number} noiseW
 * @property {number} sentenceSilence
 */

/**
 * @typedef {object} PlaybackSink where one playback's audio goes
 * @property {(pcm: Uint8Array, sampleRate: number) => void} pcm raw s16le
 *   mono, whole samples only (an odd byte is carried to the next call)
 * @property {() => Promise<void>} drained resolves when the socket's
 *   queued PCM is under `audioLimits.pcmBufferedBytes`; an engine awaits
 *   it before reading more from its source (backpressure, R5-68 fixed)
 * @property {(phase: 'synthesizing') => void} phase
 * @property {(index: number) => void} sentenceFailed sentence `index`
 *   (0-based, in `Synthesis.sentence` order) produced no audio within
 *   `audioTimeouts.synthTimeoutMs` or failed; playback continues
 * @property {() => void} end every sentence was synthesized; the playback
 *   is over
 * @property {(reason: string) => void} abort the playback is over
 */

/**
 * @typedef {object} Synthesis one playback's synthesis (R5-38: one
 *   process per reply for the `process` kind)
 * @property {(sentence: string) => void} sentence one spoken sentence,
 *   already filtered and split (`SpeechText`); started lazily on the
 *   first (R5-38)
 * @property {() => void} end no more sentences
 * @property {() => void} abort stop now: the engine's process is killed
 *   and its input released (R5-47); no further sink call
 */

/**
 * @typedef {object} TtsEngine one per speech host and settings revision
 * @property {() => DirectionState} state
 * @property {() => Promise<TtsCatalogue>} catalogue read once per
 *   revision, then kept
 * @property {(options: CheckedTtsOptions, sink: PlaybackSink) => Synthesis} open
 * @property {() => Promise<void>} stop abort every synthesis with
 *   `speechTexts.serviceStopped`
 */

/**
 * @typedef {object} SpeechText the text pipeline of one playback
 *   (`AH/speech/speech-text.js`; R5-35..R5-37, Endo
 *   `speech-code-filter.js` and the chunker of `tts-server-caplet.js`)
 * @property {(text: string) => string[]} push append reply text; answers
 *   the sentences now complete (code removed, markdown stripped, a chunk
 *   under 10 characters merged with the next)
 * @property {() => string[]} lineBreak a tool call between rounds (R5-34):
 *   no sentence spans it; answers sentences it completes
 * @property {() => string[]} finish the rest at the end
 * @property {() => number} pendingUnits text held back (bounded by
 *   `audioLimits.sentenceBacklogUnits` by the caller)
 */

/**
 * @typedef {object} TurnTextSink what the speech view of a turn feeds
 *   (the audio route connects it to a `SpeechText` and a `Synthesis`)
 * @property {(text: string) => void} text assistant text, in order
 * @property {() => void} lineBreak
 * @property {() => void} end the turn's text is complete
 * @property {(reason: string) => void} abort
 */

/**
 * @typedef {object} TurnSpeechView the speech view of one turn (R5-34;
 *   `AH/speech/turn-view.js`): a `Live` subscription of the session,
 *   in process, filtered to `turnId`
 * @property {() => void} close release the subscription (the turn keeps
 *   running, R5-47)
 */

/**
 * @typedef {object} OpenTurnViewOptions
 * @property {any} live the incarnation's `Live` (gateway context)
 * @property {any} content the incarnation's `Content`, for a staged final
 * @property {any} session the `Session` presence the page passed
 * @property {string} turnId
 * @property {TurnTextSink} sink
 */

export {};
