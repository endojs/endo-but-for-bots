// @ts-check
/// <reference types="ses"/>

/**
 * Build-time codegen for the per-exo code-mode global type declarations.
 *
 * Composes the per-exo extractors (`code-mode-git-extract.js`,
 * `code-mode-fs-extract.js`), each of which pairs a source with the generic
 * renderer it needs, and writes one checked-in runtime artifact per exo:
 *
 *   - `generated/code-mode-globals/git-declarations.js` (git, gitReadOnly)
 *   - `generated/code-mode-globals/git-remote-declarations.js` (gitRemote)
 *   - `generated/code-mode-globals/fs-declarations.js`  (workspace, filesystem)
 *   - `generated/code-mode-globals/shell-declarations.js` (shell)
 *   - `generated/code-mode-globals/http-declarations.js` (http)
 *
 * Run with: `yarn workspace @endo/agent-tools gen:code-mode-types`
 *
 * `test/code-mode-types.test.js` is the divergence gate: it re-runs the same
 * extraction and fails if a checked-in artifact is stale, so a change to any
 * source (the exo-git or platform filesystem types) or to a renderer must be
 * regenerated and committed. It also checks each printed capability type
 * against the runtime `M.interface` guard that enforces it.
 *
 * `typescript` and `@endo/patterns` are dev dependencies and are only used here
 * and in the gate, never at agentry runtime: the artifacts are plain checked-in
 * data.
 */

import '@endo/init';

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildGitTypeDeclarations } from './code-mode-git-extract.js';
import { buildFsTypeDeclarations } from './code-mode-fs-extract.js';
import { buildGitRemoteTypeDeclarations } from './code-mode-git-remote-extract.js';
import { buildHttpTypeDeclarations } from './code-mode-http-extract.js';
import { buildShellTypeDeclarations } from './code-mode-shell-extract.js';

/**
 * @param {string} descriptorFile The per-exo runtime descriptor module that
 *   consumes this artifact (e.g. `git.js`).
 * @param {string} sourceDoc Provenance note for the generated file header.
 * @returns {string}
 */
const header = (descriptorFile, sourceDoc) => `// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
${sourceDoc}
 *
 * The generic extraction and rendering live in
 * scripts/code-mode-type-extract.js; this exo's source configuration lives in
 * its scripts/code-mode-*-extract.js extractor. The divergence gate in
 * test/code-mode-types.test.js keeps this artifact fresh.
 *
 * Each entry is consumed by formatGlobalDeclarations in code-mode/declarations.js via
 * the per-exo descriptor in code-mode-globals/${descriptorFile}:
 * \`aux\` is the supporting \`type\` aliases, \`body\` is the object type spliced
 * after the dynamic \`declare const <name>:\`.
 */
`;

/**
 * @param {string} s
 * @returns {string}
 */
const escapeTemplateLiteral = s =>
  s.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');

/**
 * @param {Record<string, { aux: string, body: string }>} declarations
 * @returns {string}
 */
const renderEntries = declarations =>
  Object.entries(declarations)
    .map(
      ([key, { aux, body }]) =>
        `  ${key}: {\n    aux: \`${escapeTemplateLiteral(
          aux,
        )}\`,\n    body: \`${escapeTemplateLiteral(body)}\`,\n  },`,
    )
    .join('\n');

/**
 * @param {object} artifact
 * @param {string} artifact.outPath Path relative to this script's directory.
 * @param {string} artifact.exportName The `export const <name>` to emit.
 * @param {string} artifact.descriptorFile The per-exo runtime descriptor module
 *   that consumes this artifact.
 * @param {string} artifact.sourceDoc Provenance note for the header.
 * @param {Record<string, { aux: string, body: string }>} artifact.declarations
 */
const writeArtifact = ({
  outPath,
  exportName,
  descriptorFile,
  sourceDoc,
  declarations,
}) => {
  const outUrl = new URL(outPath, import.meta.url);
  const body = `${header(descriptorFile, sourceDoc)}
export const ${exportName} = harden({
${renderEntries(declarations)}
});
harden(${exportName});
`;
  writeFileSync(fileURLToPath(outUrl), body);
  console.error(
    `wrote ${fileURLToPath(outUrl)} (${Object.keys(declarations).join(', ')})`,
  );
};

writeArtifact({
  outPath: '../generated/code-mode-globals/git-declarations.js',
  exportName: 'gitDeclarations',
  descriptorFile: 'git.js',
  sourceDoc: ` *   - git / gitHistory / gitReadOnly: packages/exo-git/src/types.ts (the
 *     \`ReadWriteEndoGit\`, \`HistoryRewriteEndoGit\`, and \`ReadOnlyEndoGit\`
 *     type alias), printed by the typescript compiler API
 *     (TypeScript-canonical).`,
  declarations: buildGitTypeDeclarations(),
});

writeArtifact({
  outPath: '../generated/code-mode-globals/fs-declarations.js',
  exportName: 'fsDeclarations',
  descriptorFile: 'fs.js',
  sourceDoc: ` *   - workspace: packages/daemon/src/types.d.ts (the \`EndoMount\` interface),
 *     reached through the re-export in
 *     packages/agent-tools/src/code-mode-globals/daemon-mount-types.ts and
 *     printed by the TypeScript compiler API.
 *   - filesystem: packages/platform/src/fs/extended/types.ts (the local
 *     \`Filesystem\` type alias and the capability types it reaches), printed
 *     by the TypeScript compiler API.`,
  declarations: buildFsTypeDeclarations(),
});

writeArtifact({
  outPath: '../generated/code-mode-globals/shell-declarations.js',
  exportName: 'shellDeclarations',
  descriptorFile: 'shell.js',
  sourceDoc: ` *   - shell: packages/exo-shell/src/types.ts (the \`EndoShell\` type alias),
 *     printed by the TypeScript compiler API.`,
  declarations: buildShellTypeDeclarations(),
});

writeArtifact({
  outPath: '../generated/code-mode-globals/http-declarations.js',
  exportName: 'httpDeclarations',
  descriptorFile: 'http.js',
  sourceDoc: ` *   - http: packages/exo-http-client/src/types.ts (the \`HttpClient\` type
 *     alias), printed by the TypeScript compiler API, with
 *     \`PassableBytesReader\` and the stream nodes it reaches followed into
 *     packages/exo-stream/types.d.ts.`,
  declarations: buildHttpTypeDeclarations(),
});

writeArtifact({
  outPath: '../generated/code-mode-globals/git-remote-declarations.js',
  exportName: 'gitRemoteDeclarations',
  descriptorFile: 'git-remote.js',
  sourceDoc: ` *   - gitRemote: packages/exo-git/src/types.ts (the \`GitRemote\` type alias),
 *     printed by the TypeScript compiler API.`,
  declarations: buildGitRemoteTypeDeclarations(),
});
