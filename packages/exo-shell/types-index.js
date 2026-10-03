export { makeShell } from './src/shell.js';
export { ShellInterface, ShellCommandGrammarShape } from './src/interfaces.js';
export {
  normalizeShellCommandGrammar,
  normalizeShellCommandGrammars,
  matchShellCommand,
  formatShellCommandUsage,
} from './src/command-grammar.js';
