// @ts-check
//
// Tool-permission derivation (Design Decision 2).
//
// At grant time the harness takes ONE `tools/list` snapshot from the guest's
// facet-to-MCP bridge, prunes unsafe and code-eval names from it BEFORE pinning,
// and pins the pruned result as a `harden`ed null-prototype record. Both the
// server-side dispatch check (the bridge rejects any `tools/call` whose name is
// not in the pinned snapshot) and the client-side `--allowedTools` list are then
// derived from that ONE pruned value — so a name the filter removes is absent at
// the *boundary*, not merely omitted from the belt.
//
// The pinned value is a `harden`ed null-prototype record, never a bare `Map`:
// `harden(new Map())` freezes the object but `Map.prototype.set`/`delete` mutate
// internal slots freezing does not reach, so a "pinned" Map could be re-populated
// with `evaluate` after pinning and the bridge would dispatch it — reverting the
// boundary to belt-only.

import { makeError, X, q } from '@endo/errors';

/**
 * The one syntactic charset a tool name (and a server name) may use before it is
 * rendered into a comma/space-joined `--allowedTools` value or an
 * `mcp__<server>__<tool>` token. Membership in the catalog is validated
 * separately (§ Design Decision 2); this is the rendering-safety conjunct that
 * pins out `a,b` (splits into extra allow entries), `a b` (same), `*` and `read*`
 * (a wildcard grant after the literal `mcp__<server>__` prefix).
 *
 * Note it deliberately admits `_`, so `foo__bar` passes the charset yet is caught
 * by the separate `__`-sequence prune below (which would otherwise render
 * `mcp__endo__foo__bar`, ambiguous against the CLI's own grammar).
 */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Reserved / dunder property names an unguarded shim could dispatch into an
 * inherited intrinsic (prototype pollution / intrinsic-shadow). Pruned from the
 * snapshot at construction, not merely denied at the belt.
 */
const RESERVED_NAMES = harden([
  '__proto__',
  'constructor',
  'prototype',
  '__getMethodNames__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/**
 * Code-evaluation tool names. `mcp__endo__evaluate` would hand the confined
 * process arbitrary code execution against the guest; pruning `evaluate` (etc.)
 * from the snapshot means the *bridge itself* rejects a `tools/call` for it,
 * never relying on `--allowedTools` (belt) to cancel an injected entry.
 */
const CODE_EVAL_NAMES = harden(['evaluate', 'eval', 'define']);

/**
 * A tool name is admissible into the pinned snapshot iff it passes the charset,
 * contains no `__` sequence, and is neither a reserved/dunder nor a code-eval
 * name. This is deny-at-the-boundary: an inadmissible name never enters the
 * pinned record the bridge dispatches from.
 *
 * @param {unknown} name
 * @returns {name is string}
 */
export const isAdmissibleToolName = name => {
  if (typeof name !== 'string') return false;
  if (!SAFE_NAME.test(name)) return false;
  if (name.includes('__')) return false;
  if (RESERVED_NAMES.includes(name)) return false;
  if (CODE_EVAL_NAMES.includes(name)) return false;
  return true;
};
harden(isAdmissibleToolName);

/**
 * A server name flows into the `mcp__<server>__<tool>` grammar and into JSON /
 * argv, so it is charset-validated and `__`-free like a tool name (a server name
 * containing `__` would fracture the three-part `mcp__server__tool` split).
 *
 * @param {unknown} serverName
 * @returns {serverName is string}
 */
export const isAdmissibleServerName = serverName => {
  if (typeof serverName !== 'string') return false;
  if (!SAFE_NAME.test(serverName)) return false;
  if (serverName.includes('__')) return false;
  return true;
};
harden(isAdmissibleServerName);

/**
 * @typedef {object} McpToolDescriptor
 * @property {string} name
 * @property {string} [description]
 * @property {unknown} [inputSchema]
 */

/**
 * @typedef {Readonly<Record<string, McpToolDescriptor>>} PinnedCatalog
 *   A `harden`ed null-prototype record mapping each SURVIVING tool name to its
 *   (hardened) descriptor. This is the authoritative pinned snapshot: both the
 *   allow-list and the bridge's dispatch check derive from it.
 */

/**
 * Take a raw `tools/list` result (an array of tool descriptors) and produce the
 * pinned, pruned catalog. Runs the filter ONCE, at snapshot construction, so the
 * boundary and the belt derive from the same pruned value.
 *
 * A well-behaved Endo facet catalog already satisfies the admissibility rules;
 * the prune defends against a malformed or adversarial catalog, and against a
 * future capability-scoped surface whose names are less controlled.
 *
 * @param {Iterable<McpToolDescriptor>} rawToolsList
 * @returns {PinnedCatalog}
 */
export const pruneAndPinCatalog = rawToolsList => {
  /** @type {Record<string, McpToolDescriptor>} */
  const record = Object.create(null);
  for (const descriptor of rawToolsList) {
    const name = descriptor && descriptor.name;
    // A name that is not admissible is silently pruned: it never reaches the
    // pinned record.
    if (isAdmissibleToolName(name)) {
      if (Object.hasOwn(record, name)) {
        // A duplicate name in the raw catalog is itself suspect (which descriptor
        // wins would otherwise be catalog-order dependent); fail closed rather
        // than let a later entry shadow an earlier one.
        throw makeError(
          X`duplicate tool name in tools/list snapshot: ${q(name)}`,
        );
      }
      record[name] = harden({
        name,
        ...(descriptor.description !== undefined
          ? { description: descriptor.description }
          : {}),
        ...(descriptor.inputSchema !== undefined
          ? { inputSchema: descriptor.inputSchema }
          : {}),
      });
    }
  }
  return harden(record);
};
harden(pruneAndPinCatalog);

/**
 * The surviving tool names, sorted for determinism.
 *
 * @param {PinnedCatalog} pinnedCatalog
 * @returns {readonly string[]}
 */
export const catalogToolNames = pinnedCatalog =>
  harden(Object.keys(pinnedCatalog).sort());
harden(catalogToolNames);

/**
 * The server-side dispatch check: a `tools/call` is dispatchable iff its name is
 * an OWN key of the pinned snapshot. Uses `Object.hasOwn` against a
 * null-prototype record, so a designator like `__proto__` or `toString` (already
 * pruned, but defense in depth) cannot resolve through a prototype.
 *
 * @param {PinnedCatalog} pinnedCatalog
 * @param {unknown} toolName
 * @returns {boolean}
 */
export const isDispatchable = (pinnedCatalog, toolName) =>
  typeof toolName === 'string' && Object.hasOwn(pinnedCatalog, toolName);
harden(isDispatchable);

/**
 * Compose the exact per-tool `--allowedTools` entries from the pinned catalog.
 * Every entry is `mcp__<server>__<tool>` for a surviving, charset-valid tool
 * name. `mcp__*` does NOT work as an allow-rule wildcard (it is silently skipped
 * and grants nothing), so the list is generated per guest, never hand-wildcarded.
 *
 * Each name is re-validated at the rendering step as a conjunct with the
 * membership it already passed at prune time: fail closed on any violation
 * rather than emit a malformed flag value.
 *
 * @param {PinnedCatalog} pinnedCatalog
 * @param {string} serverName
 * @returns {readonly string[]}
 */
export const deriveAllowList = (pinnedCatalog, serverName) => {
  if (!isAdmissibleServerName(serverName)) {
    throw makeError(X`invalid MCP server name: ${q(serverName)}`);
  }
  const entries = [];
  for (const name of catalogToolNames(pinnedCatalog)) {
    // Re-assert at render time (the pinned record could, in principle, have been
    // built by a path that skipped `pruneAndPinCatalog`).
    if (!isAdmissibleToolName(name)) {
      throw makeError(X`inadmissible tool name reached allow-list: ${q(name)}`);
    }
    entries.push(`mcp__${serverName}__${name}`);
  }
  if (entries.length === 0) {
    // A post-prune catalog exposing no tools is a hard error, not a silent
    // confinement pass (§ Design Decision 2, the empty-catalog boundary). The
    // caller (`makeGuestInference`) surfaces this before any spawn.
    throw makeError(
      X`empty post-prune tool catalog for server ${q(serverName)}: refusing to grant a zero-tool inference`,
    );
  }
  return harden(entries);
};
harden(deriveAllowList);

/**
 * The known built-in tool names denied as a redundant belt over `--tools ""`
 * (which is the deny-by-construction baseline). This list is measured against one
 * CLI version and is NOT trusted as the baseline; re-derive on CLI upgrade.
 * Deliberately NOT `"*"`: a `"*"` deny outranks allow and would cancel every
 * `mcp__<server>__<tool>` allow entry, granting nothing.
 */
export const KNOWN_BUILTIN_TOOLS = harden([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
]);
