// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - shell: packages/exo-shell/src/types.ts (the `EndoShell` type alias),
 *     printed by the TypeScript compiler API.
 *
 * The generic extraction and rendering live in
 * scripts/code-mode-type-extract.js; this exo's source configuration lives in
 * its scripts/code-mode-*-extract.js extractor. The divergence gate in
 * test/code-mode-types.test.js keeps this artifact fresh.
 *
 * Each entry is consumed by formatGlobalDeclarations in code-mode/declarations.js via
 * the per-exo descriptor in code-mode-globals/shell.js:
 * `aux` is the supporting `type` aliases, `body` is the object type spliced
 * after the dynamic `declare const <name>:`.
 */

export const shellDeclarations = harden({
  shell: {
    aux: `type ShellCommandGrammar = {
    program: string;
    args: readonly ShellCommandElement[];
    description?: string;
};
type ShellResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    truncated: boolean;
};
type ShellInspectResult = {
    commands: readonly ShellCommandGrammar[];
    usage: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
};
type ShellSlotType = 'string' | 'path';
type ShellOptionMember = string | {
    prefix: string;
    type: ShellSlotType;
    name?: string;
};
type ShellCommandElement = {
    kind: 'literal';
    value: string;
} | {
    kind: 'slot';
    name: string;
    type: ShellSlotType;
    prefix?: string;
    optional?: boolean;
    description?: string;
} | {
    kind: 'options';
    options: readonly ShellOptionMember[];
    optional?: boolean;
    repeat?: boolean;
    name?: string;
    description?: string;
} | {
    kind: 'group';
    elements: readonly ShellCommandElement[];
    optional?: boolean;
    repeat?: boolean;
    description?: string;
} | {
    kind: 'rest';
    name: string;
    type: ShellSlotType;
    description?: string;
};`,
    body: `{
    attenuate: (commands: readonly ShellCommandGrammar[], options?: {
        timeoutMs?: number;
    }) => Promise<typeof shell>;
    exec: (command: string, args: readonly string[], options?: {
        timeoutMs?: number;
    }) => Promise<ShellResult>;
    inspect: () => Promise<ShellInspectResult>;
}`,
  },
});
harden(shellDeclarations);
