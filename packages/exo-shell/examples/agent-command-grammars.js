// @ts-check

/** @import { ShellCommandGrammar } from '../src/types.js' */

/**
 * Reviewable examples of command grammars that close common argv-level
 * delegation paths. Path-bearing examples still require the sandbox engine
 * before they are suitable for an untrusted agent: `relative-path` is lexical
 * and deliberately makes no symlink-confinement claim.
 *
 * @type {ShellCommandGrammar[]}
 */
export const agentCommandGrammarExamples = [
  {
    program: 'printf',
    description: 'Print strings with a fixed, non-evaluated format',
    argumentVector: [
      { kind: 'literal', value: '%s\\n' },
      { kind: 'rest', name: 'words', type: 'string' },
    ],
  },
  {
    program: 'git',
    description: 'Inspect the concise repository status',
    argumentVector: [
      { kind: 'literal', value: 'status' },
      { kind: 'literal', value: '--short' },
      { kind: 'literal', value: '--branch' },
    ],
  },
  {
    program: 'cat',
    description: 'Read one or more workspace files',
    argumentVector: [
      { kind: 'literal', value: '--' },
      { kind: 'slot', name: 'source', type: 'relative-path' },
      { kind: 'rest', name: 'moreSources', type: 'relative-path' },
    ],
  },
  {
    program: 'grep',
    description: 'Search workspace files for a pattern',
    argumentVector: [
      {
        kind: 'options',
        optional: true,
        repeat: true,
        options: ['-n', '-l', '-i'],
      },
      { kind: 'literal', value: '--' },
      { kind: 'slot', name: 'pattern', type: 'string' },
      { kind: 'slot', name: 'path', type: 'relative-path' },
      { kind: 'rest', name: 'morePaths', type: 'relative-path' },
    ],
  },
  {
    program: 'find',
    description: 'Find regular workspace files by name',
    argumentVector: [
      { kind: 'slot', name: 'root', type: 'relative-path' },
      { kind: 'literal', value: '-type' },
      { kind: 'literal', value: 'f' },
      { kind: 'literal', value: '-name' },
      { kind: 'slot', name: 'pattern', type: 'string' },
    ],
  },
  {
    program: 'sha256sum',
    description: 'Hash one or more workspace files',
    argumentVector: [
      { kind: 'literal', value: '--' },
      { kind: 'slot', name: 'path', type: 'relative-path' },
      { kind: 'rest', name: 'morePaths', type: 'relative-path' },
    ],
  },
];
