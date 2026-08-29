// @ts-check

// Shared view types for the Floot space. The host controller (chat-side, see
// packages/chat/floot-component.js) produces these pure-data snapshots; the
// confined components only ever read them and call the controller's callbacks.
// No DOM nodes, audio handles, or capabilities appear in this shape.

export {};

/**
 * `pending` marks a submission the host has accepted but not yet run: it is
 * queued behind the turn in flight, and `pendingId` identifies it to
 * `sendPendingNow`.
 *
 * @typedef {{
 *   role: 'user' | 'assistant' | 'tool',
 *   text?: string,
 *   id?: string,
 *   name?: string,
 *   args?: string,
 *   result?: string | null,
 *   pending?: boolean,
 *   pendingId?: number,
 *   meta?: { mail?: { from?: string } },
 * }} FlootMessage
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   createdAt: number,
 *   presetId: string,
 *   runtime?: string,
 *   model?: string,
 *   status?: 'idle' | 'streaming' | 'error',
 *   messageCount?: number,
 *   loaded?: boolean,
 * }} FlootSessionMeta
 */

/**
 * @typedef {{ id: string, title: string, description?: string }} FlootPreset
 */

/**
 * A model selectable for a new session. `default` marks the model an unpinned
 * session runs (the factory's configured default).
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description?: string,
 *   default?: boolean,
 * }} FlootModel
 */

/**
 * A runtime selectable for a new session — the execution backend that carries
 * the conversation (`claude-cli` sandbox vs `claude-api`). Independent of the
 * chosen model. `default` marks the runtime an unpinned session runs.
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description?: string,
 *   default?: boolean,
 * }} FlootRuntime
 */

/**
 * The sanitized event facade the confined renderer (`@endo/preact-container`)
 * hands to event handlers — never a real DOM node or `Event`. Only the fields
 * the view actually reads are modelled here; `target.value` is always a string
 * for the inputs this view registers.
 * @typedef {{
 *   target: { value: string },
 *   key?: string,
 *   shiftKey?: boolean,
 *   preventDefault: () => void,
 *   stopPropagation: () => void,
 * }} FlootSafeEvent
 */

/**
 * @typedef {{
 *   hasMic: boolean,
 *   hasTts: boolean,
 *   micActive: boolean,
 *   speaking: boolean,
 *   ttsEnabled: boolean,
 *   ttsSpeaking: boolean,
 *   meterPct?: number,
 *   noisePct?: number,
 *   thresholdPct?: number,
 *   transcript?: string,
 *   replayingText?: string,
 *   micError?: string,
 *   ttsSettings?: {
 *     voice: string, speed: number, noiseScale: number, noiseW: number,
 *     sentenceSilence: number,
 *   },
 *   ttsConfiguration?: {
 *     voices: Array<{ id: string, name: string }>,
 *     ranges: Record<string, { min: number, max: number, step: number }>,
 *   },
 * }} FlootVoiceState
 */

/**
 * @typedef {{
 *   sessions: FlootSessionMeta[],
 *   activeSessionId: string | null,
 *   presets: FlootPreset[],
 *   models: FlootModel[],
 *   runtimes: FlootRuntime[],
 *   messages: FlootMessage[],
 *   streamingText: string,
 *   phase: string,
 *   busy: boolean,
 *   loaded: boolean,
 *   status: string,
 *   input: string,
 *   settingsOpen: boolean,
 *   secretRequest?: {
 *     id: string,
 *     label: string,
 *     petName: string,
 *     kind: string,
 *     audience: string,
 *     username?: string,
 *   } | null,
 *   usage: { inputTokens: number, outputTokens: number } | null,
 *   voice: FlootVoiceState,
 *   objects?: { controller?: string, stt?: string, tts?: string },
 * }} FlootState
 */

/**
 * @typedef {object} FlootController
 * @property {() => FlootState} getState
 * @property {(listener: () => void) => () => void} subscribe
 * @property {(text?: string) => void} send
 * @property {() => void} stop
 * @property {(pendingId: number) => void} [sendPendingNow]
 * @property {(pendingId: number, text: string) => void} [editPending]
 * @property {(pendingId: number) => void} [cancelPending]
 * @property {(id: string) => void} selectSession
 * @property {(presetId?: string, model?: string, runtime?: string) => void} newSession
 * @property {(id: string, title: string) => void} renameSession
 * @property {(id: string) => void} deleteSession
 * @property {() => void} toggleMic
 * @property {() => void} toggleTts
 * @property {(name: 'voice' | 'speed' | 'noiseScale' | 'noiseW' |
 *   'sentenceSilence', value: string | number) => void} setTtsSetting
 * @property {(text: string) => void} replayMessage
 * @property {() => void} toggleSettings
 * @property {(text: string) => void} setInput
 * @property {(value: string, username?: string) => void} [submitSecret]
 * @property {() => void} [cancelSecretRequest]
 */
