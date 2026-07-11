// @ts-check
/* eslint-disable no-await-in-loop */

import { Fail } from '@endo/errors';
import harden from '@endo/harden';

/** @import { ConversationNode, ConversationTree, TreeBackend } from '../types.js' */

/**
 * The on-disk session format version. Version 3 corresponds to Pi's v3
 * transcript shape (the "tree + custom" unification), which is the format this
 * projection is compatible with. See docs/session-format.md.
 */
export const SESSION_FORMAT_VERSION = 3;

/**
 * The entry `type` values a session file may contain. `header` is the single
 * leading line; the remaining four are the node-bearing entry types.
 */
export const ENTRY_TYPE_HEADER = 'header';
export const ENTRY_TYPE_MESSAGE = 'message';
export const ENTRY_TYPE_COMPACTION = 'compaction';
export const ENTRY_TYPE_BRANCH_SUMMARY = 'branchSummary';
export const ENTRY_TYPE_CUSTOM = 'custom';

const NODE_ENTRY_TYPES = harden([
  ENTRY_TYPE_MESSAGE,
  ENTRY_TYPE_COMPACTION,
  ENTRY_TYPE_BRANCH_SUMMARY,
  ENTRY_TYPE_CUSTOM,
]);

/**
 * Structural keys the projection owns on every node entry. A node's metadata
 * may not carry any of these (they are promoted from, or reconstructed into,
 * the node structure), nor any header-only key. Serialization rejects a
 * collision rather than silently dropping data.
 */
const RESERVED_ENTRY_KEYS = harden([
  'type',
  'id',
  'parentId',
  'timestamp',
  'messages',
  'version',
  'sessionId',
  'createdAt',
  'cwd',
]);

/**
 * Build the canonical on-disk path for one session's transcript file.
 *
 * ```
 * <stateDirectory>/sessions/<guestId>/<timestamp>_<sessionId>.jsonl
 * ```
 *
 * The `timestamp` prefix keeps a guest's session files sorted chronologically
 * by a plain directory listing; the `sessionId` suffix disambiguates sessions
 * started within the same timestamp granularity.
 *
 * @param {object} parts
 * @param {string} parts.stateDirectory - The daemon state root (`$ENDO_STATE`).
 * @param {string} parts.guestId - The guest whose sessions these are.
 * @param {string} parts.timestamp - A sortable timestamp label (for example an
 *   ISO-8601 string with separators removed).
 * @param {string} parts.sessionId - The session identifier.
 * @returns {string}
 */
export const sessionFilePath = ({
  stateDirectory,
  guestId,
  timestamp,
  sessionId,
}) => {
  return `${stateDirectory}/sessions/${guestId}/${timestamp}_${sessionId}.jsonl`;
};
harden(sessionFilePath);

/**
 * Serialize the session header to a single JSONL line (without the trailing
 * newline).
 *
 * @param {object} fields
 * @param {string} fields.sessionId
 * @param {number} fields.createdAt - Milliseconds since the Unix epoch.
 * @param {string} [fields.cwd] - The working directory the session ran in.
 * @returns {string}
 */
export const serializeHeader = ({ sessionId, createdAt, cwd }) => {
  /** @type {Record<string, unknown>} */
  const header = {
    type: ENTRY_TYPE_HEADER,
    version: SESSION_FORMAT_VERSION,
    sessionId,
    createdAt,
  };
  if (cwd !== undefined) {
    header.cwd = cwd;
  }
  return JSON.stringify(header);
};
harden(serializeHeader);

/**
 * Serialize one conversation node to a single JSONL entry line (without the
 * trailing newline).
 *
 * The node's `metadata.entryType` (when present) selects the entry `type`;
 * every other metadata key is promoted to a top-level field so operators can
 * `jq` them directly (`firstKeptEntryId` on a compaction entry, `summary` on a
 * branchSummary entry, `endo:*` discriminators on a custom entry). A metadata
 * key that collides with a reserved structural key is an error.
 *
 * @param {ConversationNode} node
 * @returns {string}
 */
export const serializeNode = node => {
  const { id, parentId, messages, metadata, timestamp } = node;
  const { entryType, ...promoted } = metadata;
  const type = entryType === undefined ? ENTRY_TYPE_MESSAGE : String(entryType);
  NODE_ENTRY_TYPES.includes(type) ||
    Fail`unknown conversation node entryType ${entryType}`;
  for (const key of Object.keys(promoted)) {
    !RESERVED_ENTRY_KEYS.includes(key) ||
      Fail`node metadata key ${key} collides with a reserved session-entry key`;
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    type,
    id,
    parentId,
    timestamp,
    messages,
    ...promoted,
  };
  return JSON.stringify(entry);
};
harden(serializeNode);

/**
 * Serialize an entire conversation tree to a JSONL string: one header line
 * followed by one line per node, emitted parent-before-child so a reader can
 * reconstruct the graph in a single forward pass.
 *
 * @param {ConversationTree} tree
 * @param {object} header
 * @param {string} header.sessionId
 * @param {number} header.createdAt
 * @param {string} [header.cwd]
 * @returns {Promise<string>}
 */
export const serializeTreeToJsonl = async (tree, header) => {
  const lines = [serializeHeader(header)];
  const roots = await tree.getRoots();
  // Breadth-first from the roots guarantees every parent is emitted before its
  // children.
  const frontier = [...roots];
  while (frontier.length > 0) {
    const node = frontier.shift();
    if (node === undefined) {
      break;
    }
    lines.push(serializeNode(node));
    const children = await tree.getChildren(node.id);
    frontier.push(...children);
  }
  return `${lines.join('\n')}\n`;
};
harden(serializeTreeToJsonl);

/**
 * Truncate a session file's text to its last complete line. The append-only
 * writer flushes `O_APPEND` writes, so a crash can leave a partial final line
 * with no terminating newline; a reader recovers by discarding it. Text that
 * already ends in a newline is returned unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export const truncateToLastCompleteLine = text => {
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    return '';
  }
  return text.slice(0, lastNewline + 1);
};
harden(truncateToLastCompleteLine);

/**
 * Parse a session file's text into its entry objects, in file order. Blank
 * lines are skipped; a trailing partial line (no terminating newline) is
 * discarded per {@link truncateToLastCompleteLine}.
 *
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export const parseSessionEntries = text => {
  const complete = truncateToLastCompleteLine(text);
  /** @type {Record<string, unknown>[]} */
  const entries = [];
  for (const line of complete.split('\n')) {
    if (line.trim() !== '') {
      entries.push(JSON.parse(line));
    }
  }
  return entries;
};
harden(parseSessionEntries);

/**
 * Reconstruct the {@link ConversationNode} a node-bearing entry projects from.
 * The inverse of {@link serializeNode}: the reserved structural keys become the
 * node fields, `type` becomes `metadata.entryType` (omitted for a plain
 * message), and every remaining top-level key returns to `metadata`.
 *
 * @param {Record<string, unknown>} entry
 * @returns {ConversationNode}
 */
export const entryToNode = entry => {
  const { type, id, parentId, timestamp, messages, ...rest } = entry;
  (typeof type === 'string' && NODE_ENTRY_TYPES.includes(type)) ||
    Fail`entry is not a conversation node entry: ${type}`;
  /** @type {Record<string, unknown>} */
  const metadata = { ...rest };
  if (type !== ENTRY_TYPE_MESSAGE) {
    metadata.entryType = type;
  }
  return /** @type {ConversationNode} */ (
    harden({
      id,
      parentId: parentId ?? null,
      messages,
      metadata,
      timestamp,
    })
  );
};
harden(entryToNode);

/**
 * Load a session file's text into the given backend, reconstructing the
 * conversation tree. Returns the parsed header alongside the populated tree so
 * the agent can resume a session from disk (the "the claw uses these as a form
 * of memory" path).
 *
 * @param {string} text
 * @param {TreeBackend} backend
 * @param {(backend: TreeBackend) => ConversationTree} makeTree
 * @returns {Promise<{ header: Record<string, unknown>, tree: ConversationTree }>}
 */
export const loadTreeFromJsonl = async (text, backend, makeTree) => {
  const entries = parseSessionEntries(text);
  entries.length >= 1 || Fail`session file has no header entry`;
  const [header, ...nodeEntries] = entries;
  header.type === ENTRY_TYPE_HEADER ||
    Fail`first session entry is not a header: ${header.type}`;
  await null;
  for (const entry of nodeEntries) {
    await backend.putNode(entryToNode(entry));
  }
  return { header, tree: makeTree(backend) };
};
harden(loadTreeFromJsonl);

/**
 * @typedef {object} JsonlSessionWriter
 * @property {(header: { sessionId: string, createdAt: number, cwd?: string }) => Promise<void>} writeHeader
 * @property {(node: ConversationNode) => Promise<void>} writeNode
 */

/**
 * Create an append-only session writer over an injected line sink. The sink
 * receives one already-serialized entry per call and is responsible for the
 * terminating newline and for the atomicity guarantee (a guest binds it to an
 * `O_APPEND`, mode-0600 file under `$ENDO_STATE/sessions/`). Keeping the sink
 * injected leaves this package free of any filesystem dependency and keeps the
 * projection unit-testable against an in-memory sink.
 *
 * @param {object} parts
 * @param {(line: string) => Promise<void> | void} parts.appendLine - Append one
 *   entry, adding the line terminator.
 * @returns {JsonlSessionWriter}
 */
export const makeJsonlSessionWriter = ({ appendLine }) => {
  /** @type {JsonlSessionWriter} */
  const writer = {
    async writeHeader(header) {
      await appendLine(serializeHeader(header));
    },
    async writeNode(node) {
      await appendLine(serializeNode(node));
    },
  };
  return harden(writer);
};
harden(makeJsonlSessionWriter);
