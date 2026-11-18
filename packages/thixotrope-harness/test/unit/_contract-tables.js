// @ts-check
/**
 * The M1b and M2 contracts' own entries, picked from the plain tables, for
 * the contract tests that check a milestone's entries one by one
 * (`m1b-interfaces.test.js`, `m2-interfaces.test.js`). Until the fold (F2,
 * HR-SYN-1) `guest/lib/interfaces.js` exported these as views
 * (`m1bShapes`, `m1bInterfaces`, `m1bMethodNames`, `m2Interfaces`,
 * `m2MethodNames`); the product no longer has them. The name lists are the
 * views' lists, unchanged; each entry is the plain table's (the same
 * object), so where a later milestone widened an interface the entry is the
 * widened guard.
 *
 * Needs the guest prelude on globalThis (`_m1a-prelude.js` first).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  interfaces,
  m1bMethodLists,
  methodNames,
  shapes,
} from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/**
 * @param {Record<string, any>} table
 * @param {readonly string[]} names
 * @returns {Record<string, any>}
 */
const pick = (table, names) =>
  harden(Object.fromEntries(names.map(name => [name, table[name]])));

/** The ten interfaces M2 extends (m2-interfaces.md 1.3). */
const m2Names = harden([
  'Session',
  'SessionInternal',
  'QueueEntry',
  'ContextSource',
  'SessionFactory',
  'HarnessRoot',
  'Operator',
  'AgentHostAdmin',
  'Backend',
  'Composer',
]);

export const m2Interfaces = pick(interfaces, m2Names);
/** @type {Record<string, readonly string[]>} */
export const m2MethodNames = pick(methodNames, m2Names);

export const m1bShapes = pick(shapes, [
  'StagedText',
  'Progress',
  'ContentRange',
  'ContentPage',
  'SleepMs',
  'ExecScopeInfo',
  'ExecRequest',
  'ExecOutcome',
  'ContextPage',
  'TurnContentPage',
  'BlobStockEntry',
  'BlobStock',
  'BlobKeys',
  'BlobPage',
  'CloseReason',
  'ListEvent',
  'ListPublishBatch',
  'ListSnapshotEvent',
  'ListDelivery',
  'ListBatch',
  'ListFeedInfo',
  'PoolCounts',
  'PoolStatus',
  'HarnessSettings',
  'ProgramInfo',
  'HarnessStatus',
]);

export const m1bInterfaces = pick(interfaces, [
  'Blob',
  'BlobWriters',
  'BlobWriter',
  'Content',
  'Timer',
  'TurnSink',
  'Turn',
  'ContextSource',
  'ExecScope',
  'ExecHandle',
  'ListPublisher',
  'ListSubscription',
  'Live',
  'AgentHostAdmin',
  'StartListener',
  'SessionFactory',
  'HarnessRoot',
]);

/** M1b's method lists (the build ingredients of `methodNames`). */
export const m1bMethodNames = m1bMethodLists;

/**
 * What the fold brought into the plain tables from M5's tables, so that an
 * earlier milestone's "nothing else" checks still name only that
 * milestone's entries: M5's new shapes and interfaces, and the methods M5
 * added at the end of an interface an earlier milestone defined.
 */
export const m5Later = harden({
  shapes: harden([
    'EdgeLabel',
    'Attachment',
    'Attachments',
    'SubmitOptions',
    'JsonValue',
    'PowersValue',
    'InspectOp',
    'InspectRequest',
    'InspectOutcome',
    'ToolGrantInfo',
    'SourceReadRequest',
    'SourceReadResult',
    'TemplateName',
    'NetworkPolicyName',
    'TemplateObject',
    'Endowment',
    'PresetRecord',
    'PresetView',
    'PresetConfiguration',
    'PresetCreated',
    'InventoryRow',
    'InventoryPage',
  ]),
  interfaces: harden([
    'ExecPowersSource',
    'SessionGrants',
    'ToolGrant',
    'SourceReader',
    'PresetCatalog',
    'Inventory',
    'InventoryEntry',
  ]),
  /** @type {Readonly<Record<string, readonly string[]>>} */
  methods: harden({
    Session: harden(['enqueueMessageOnce', 'grants']),
    Operator: harden(['getPresets', 'getInventory']),
    ExecScope: harden(['inspect']),
    Preset: harden(['save', 'delete', 'reset']),
  }),
});

/**
 * An interface's method names without the ones M5 added at its end.
 * @param {string} name
 * @param {readonly string[]} names
 */
export const beforeM5 = (name, names) =>
  names.slice(0, names.length - (m5Later.methods[name]?.length ?? 0));
