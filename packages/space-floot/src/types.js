// @ts-check

// Shared view types for the Floot space. The host controller (chat-side, see
// packages/chat/floot-component.js) produces these pure-data snapshots; the
// confined components only ever read them and call the controller's callbacks.
// No DOM nodes, audio handles, or capabilities appear in this shape.

export {};

/**
 * `pending` marks a submission that has been accepted but not yet run: it is
 * queued behind the turn in flight, and `pendingId` identifies it to
 * `sendPendingNow`, `editPending` and `cancelPending`. The queue is the
 * daemon's, so it survives the page; `pendingState` says where a message is:
 * `queued`, `sending` (on its way, nothing left to edit) or `interrupted` (the
 * daemon restarted while sending it, so it may or may not have arrived).
 *
 * @typedef {{
 *   role: 'user' | 'assistant' | 'tool',
 *   text?: string,
 *   id?: string,
 *   name?: string,
 *   args?: string,
 *   result?: string | null,
 *   pending?: boolean,
 *   pendingId?: number | string,
 *   pendingState?: 'queued' | 'sending' | 'interrupted',
 *   meta?: { mail?: { from?: string } },
 * }} FlootMessage
 */

/**
 * `backendLabel` and `modelLabel` say what the session runs on, in words the
 * host resolved from the factory's catalogs (ids are not for reading).
 * `status` is what the session's status circle shows: `passive` (nothing
 * running), `working` (a turn in flight) or `error`. `idle` and `streaming`
 * are the older names for the first two and still read the same way.
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   createdAt: number,
 *   presetId: string,
 *   model?: string,
 *   backendLabel?: string,
 *   modelLabel?: string,
 *   reasoningEffort?: string,
 *   status?: 'passive' | 'working' | 'error' | 'idle' | 'streaming',
 *   messageCount?: number,
 *   pendingCount?: number,
 *   loaded?: boolean,
 *   lifecycle?: string,
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
 *   defaultReasoningEffort?: string | null,
 *   backendId?: string,
 *   backendTitle?: string,
 *   modelId?: string,
 *   selectionId?: string,
 *   reasoningEfforts?: string[],
 * }} FlootModel
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
 * `busy` is a turn this page can stop; `working` is the session doing anything
 * at all, which includes a turn that arrived by mail and has no Stop.
 * `pendingHold` is why queued messages are not moving, when they are not.
 *
 * @typedef {{
 *   sessions: FlootSessionMeta[],
 *   activeSessionId: string | null,
 *   presets: FlootPreset[],
 *   models: FlootModel[],
 *   messages: FlootMessage[],
 *   streamingText: string,
 *   phase: string,
 *   busy: boolean,
 *   working?: boolean,
 *   pendingHold?: string,
 *   loaded: boolean,
 *   status: string,
 *   input: string,
 *   settingsOpen: boolean,
 *   recovery?: FlootRecovery,
 *   network?: FlootNetwork,
 *   execution?: { state: string, supported: boolean, changing: boolean, action: string, error: string, blocked: boolean },
 *   unavailable?: boolean,
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
 * @property {(pendingId: number | string) => void} [sendPendingNow]
 * @property {(pendingId: number | string, text: string) => void} [editPending]
 * @property {(pendingId: number | string) => void} [cancelPending]
 * @property {(id: string) => void} selectSession
 * @property {(presetId?: string, model?: string, reasoningEffort?: string) => void} newSession
 * @property {(id: string, title: string) => void} renameSession
 * @property {(id: string) => void} deleteSession
 * @property {() => void} toggleMic
 * @property {() => void} toggleTts
 * @property {(name: 'voice' | 'speed' | 'noiseScale' | 'noiseW' |
 *   'sentenceSilence', value: string | number) => void} setTtsSetting
 * @property {(text: string) => void} replayMessage
 * @property {() => void} toggleSettings
 * @property {() => void} [emergencyStop]
 * @property {() => void} [resumeSession]
 * @property {(text: string) => void} setInput
 * @property {() => void} [refreshRecovery]
 * @property {(turnId: string, note: string, confirmed: boolean) => void} [resolveTurn]
 * @property {() => void} [refreshNetworkPolicy]
 * @property {(policy: string) => void} [setNetworkPolicy]
 * @property {(id: string, approve: boolean, note: string) => void} [resolveNetworkPolicyRequest]
 */

/**
 * @typedef {{ status: string, message: string, policy: string | null,
 *   supportedPolicies: string[], changing: boolean, canSet: boolean,
 *   pendingPolicy?: string, blocked?: boolean,
 *   canResolve: boolean, current?: boolean,
 *   request?: { id: string, policy: string, reason: string } }} FlootNetwork
 */

/**
 * @typedef {{ turnId: string, state: string, error?: string,
 *   tools?: unknown[], activity?: unknown[], resolution?: string }} FlootJournalTurn
 * @typedef {{ status: string, message: string, turns: FlootJournalTurn[],
 *   canResolve: boolean, resolving: boolean, blocked?: boolean, current?: boolean,
 *   capacity?: { usedEvents: string, retainedTurns: number, archivedTurns: number,
 *     storage: string } | null }} FlootRecovery
 */
