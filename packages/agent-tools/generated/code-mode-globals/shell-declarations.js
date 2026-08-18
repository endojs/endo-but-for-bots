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
    aux: `type ShellResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    truncated: boolean;
};`,
    body: `{
    exec: (command: string, args: readonly string[], options?: {
        timeoutMs?: number;
    }) => Promise<ShellResult>;
    inspect: () => Promise<{
        allowedCommands: readonly string[];
        timeoutMs: number;
        maxOutputBytes: number;
    }>;
}`,
  },
});
harden(shellDeclarations);
