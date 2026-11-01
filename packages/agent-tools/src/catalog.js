// @ts-check
/// <reference types="ses"/>

/** @import { ToolRecord } from './types.js' */

// Internal to @endo/agent-tools: this module is not a package export. It holds
// the catalog-composition guard that workspace.js builds on, kept separate so
// the guard is testable without widening the public workspace surface.

/**
 * Apply a group's explicit catalog names without changing a capability tool
 * maker's standalone surface. The rename table is a `Map` so a tool name that
 * coincides with an `Object.prototype` property (`constructor`, `toString`)
 * cannot resolve to an inherited value.
 *
 * @param {ToolRecord[]} records
 * @param {Map<string, string>} [names]
 * @returns {ToolRecord[]}
 */
const nameWorkspaceTools = (records, names) => {
  if (names === undefined) {
    return records;
  }
  return records.map(record => {
    const name = names.get(record.name);
    return name === undefined ? record : harden({ ...record, name });
  });
};

/**
 * Concatenate tool-group record arrays into one catalog, failing closed if two
 * groups would emit the same tool name. A catalog with two identically-named
 * tools is ambiguous the moment a harness dispatches by name, so the collision
 * is an error at composition time rather than a silent shadow.
 *
 * Each group may carry its own `names` table, attached where the group is
 * composed, so the qualification travels with the records it renames.
 *
 * @param {{ group: string, records: ToolRecord[], names?: Map<string, string> }[]} groups
 * @returns {ToolRecord[]}
 */
export const concatDistinctTools = groups => {
  /** @type {ToolRecord[]} */
  const catalog = [];
  /** @type {Map<string, string>} */
  const sourceByName = new Map();
  for (const { group, records, names } of groups) {
    for (const record of nameWorkspaceTools(records, names)) {
      const priorGroup = sourceByName.get(record.name);
      if (priorGroup !== undefined) {
        throw new Error(
          `agent-tool catalog name collision: "${record.name}" is emitted by both the "${priorGroup}" and "${group}" tool groups; grant only one to a single catalog, or disambiguate the tool names before composing`,
        );
      }
      sourceByName.set(record.name, group);
      catalog.push(record);
    }
  }
  return harden(catalog);
};
harden(concatDistinctTools);
