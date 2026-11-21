// @ts-check
/**
 * Browser-visible texts of the voice feature (spec R5-46, R5-56;
 * `designs/m11-interfaces.md` sections 9 and 15). Word for word where the
 * spec quotes one.
 */

export const voiceUiTexts = Object.freeze({
  /** R5-56 compose bar. */
  micOn: 'Start listening',
  micOff: 'Stop listening',
  muteReplies: 'Mute replies',
  speakReplies: 'Speak replies',
  /** R5-46. */
  continuingInBackground: 'continuing in background…',
  /** R5-56 settings. */
  panelLabel: 'Voice',
  spokenReplies: 'Spoken replies',
  spokenRepliesOn: 'On — autoplay',
  spokenRepliesOff: 'Off',
  voice: 'Voice',
  speed: 'Speed',
  expression: 'Expression',
  phonemeVariation: 'Phoneme variation',
  sentencePause: 'Sentence pause',
  voiceShortcut: 'Voice shortcut',
  /** The per-turn replay control (decision D-M11-17). */
  replay: 'Replay',
  /** The voice shortcut button (a spoken session from the shortcut preset). */
  talk: 'Talk',
  /** Shown when the page has no microphone permission or no secure context. */
  captureFailure: Object.freeze({
    denied: 'Allow microphone access in your browser to start listening.',
    insecure:
      'Open this page over HTTPS or on localhost to use the microphone.',
    notFound: 'Connect a microphone and try again.',
    unreadable:
      'The microphone could not start. Check your audio input and try again.',
  }),
  micUnavailable: 'The microphone is not available on this page',
  speechInOff: 'Speech input is not configured on this server',
  speechOutOff: 'Speech output is not configured on this server',
});
