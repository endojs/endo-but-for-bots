// @ts-check

/**
 * One open terminal session: a line reader plus helpers for the screen
 * idioms the CLI views share. `write` resolves when the text has been
 * flushed, so a caller can pace refreshes.
 *
 * @typedef {object} TerminalSession
 * @property {boolean} isTTY
 * @property {(text: string) => Promise<void>} write
 * @property {(text: string) => void} writeError
 * @property {() => void} clearScreen
 * @property {() => AsyncIterable<string>} lines
 * @property {(listener: () => void) => void} onClose
 * @property {(text: string) => void} setPrompt
 * @property {() => void} prompt
 * @property {() => void} close
 *
 * Opening a session is a power because a host without an interactive
 * terminal (a daemon, an embedder) can refuse it; each session owns
 * stdin/stdout until closed.
 *
 * @typedef {object} TerminalPowers
 * @property {() => TerminalSession} open
 */

// Port only: the host implementation is `node/terminal.js`.
export {};
