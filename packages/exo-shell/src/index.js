// @ts-check
// reexport-policy-exempt: this package root is the canonical public path.

export { makeShell } from './shell.js';
export { ShellInterface, ShellCommandGrammarShape } from './interfaces.js';
export {
  normalizeShellCommandGrammar,
  normalizeShellCommandGrammars,
  matchShellCommand,
  formatShellCommandUsage,
} from './command-grammar.js';
