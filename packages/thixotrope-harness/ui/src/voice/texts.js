// @ts-check
/**
 * Browser-visible texts of the voice feature (spec R5-46, R5-56;
 * `designs/m11-interfaces.md` sections 9 and 15). Word for word where the
 * spec quotes one.
 */

export const voiceUiTexts = Object.freeze({
  /**
   * The compose bar's mode switch (m11-interfaces.md 9.1): its accessible
   * name, with `aria-pressed` for the state, and the tooltips of the two
   * states.
   */
  spokenMode: 'Spoken mode',
  toSpokenMode: 'Switch to spoken mode: speak your messages, hear the replies',
  toTextMode: 'Switch to text mode',
  /** The level meter's name while listening. */
  inputLevel: 'Input level',
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
  playMessage: 'Play message',
  playbackUnavailable: 'This message could not be played.',
  /**
   * The voice shortcut button (a spoken session from the shortcut preset),
   * in the Voice panel since M11 9.1.
   */
  talk: 'Talk',
  talkHint: 'Start a new session with the Voice shortcut, in spoken mode',
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
