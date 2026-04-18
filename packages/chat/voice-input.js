// @ts-check

/**
 * Voice Input Module
 *
 * Adds a microphone button to the chat bar that uses the Web Speech
 * API (SpeechRecognition) for voice-to-text transcription.  The
 * transcribed text is inserted into the message input field.
 *
 * Falls back gracefully: if SpeechRecognition is not available
 * (Firefox, non-browser), the button is hidden.
 *
 * @module
 */

/**
 * @typedef {object} VoiceInputAPI
 * @property {() => void} destroy - Remove event listeners and DOM.
 */

/**
 * Initialize voice input for the chat bar.
 *
 * @param {object} options
 * @param {HTMLElement} options.$container - Element to append the mic button to.
 * @param {HTMLElement} options.$input - The contenteditable message input.
 * @param {string} [options.lang] - BCP-47 language code (default: 'en-US').
 * @returns {VoiceInputAPI | null} API for cleanup, or null if not supported.
 */
export const makeVoiceInput = ({ $container, $input, lang = 'en-US' }) => {
  // Feature detection for Web Speech API.
  const SpeechRecognition =
    /** @type {any} */ (globalThis).SpeechRecognition ||
    /** @type {any} */ (globalThis).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    // Browser doesn't support speech recognition.
    return null;
  }

  const $micButton = document.createElement('button');
  $micButton.id = 'voice-input-button';
  $micButton.type = 'button';
  $micButton.title = 'Voice input (click to speak)';
  $micButton.textContent = '\u{1F399}'; // studio microphone emoji
  $micButton.setAttribute('aria-label', 'Voice input');
  $container.appendChild($micButton);

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = lang;

  let isListening = false;

  /** @type {string} */
  let savedContent = '';

  const startListening = () => {
    if (isListening) return;
    isListening = true;
    savedContent = $input.textContent || '';
    $micButton.classList.add('listening');
    $micButton.title = 'Listening... (click to stop)';
    try {
      recognition.start();
    } catch {
      // Already started — ignore.
    }
  };

  const stopListening = () => {
    if (!isListening) return;
    isListening = false;
    $micButton.classList.remove('listening');
    $micButton.title = 'Voice input (click to speak)';
    try {
      recognition.stop();
    } catch {
      // Already stopped — ignore.
    }
  };

  const handleClick = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  $micButton.addEventListener('click', handleClick);

  recognition.addEventListener('result', (/** @type {any} */ event) => {
    const results = event.results;
    if (!results || results.length === 0) return;

    // Collect all results into a single transcript.
    let transcript = '';
    for (let i = 0; i < results.length; i += 1) {
      transcript += results[i][0].transcript;
    }

    // Show interim results in the input.
    $input.textContent = savedContent + transcript;

    // Place cursor at end.
    const range = document.createRange();
    const sel = /** @type {Selection} */ (window.getSelection());
    range.selectNodeContents($input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  recognition.addEventListener('end', () => {
    stopListening();
    // Trigger input event so the chat bar detects content.
    $input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  recognition.addEventListener('error', (/** @type {any} */ event) => {
    console.warn('[voice-input] Speech recognition error:', event.error);
    stopListening();
  });

  const destroy = () => {
    stopListening();
    $micButton.removeEventListener('click', handleClick);
    $micButton.remove();
  };

  return { destroy };
};
