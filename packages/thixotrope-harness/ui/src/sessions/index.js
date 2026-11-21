// @ts-check
/**
 * The sessions views (m3-interfaces.md 17; W3.5): the shell renders
 * `Sidebar` in the sidebar region and `NewSession` while
 * `state.newSessionOpen`.
 */
export { SessionInventory } from './SessionInventory.js';
export { Sidebar } from './Sidebar.js';
export { NewSession } from './NewSession.js';
export {
  countsLabel,
  discoveryNotes,
  lifecycleNote,
  matchesModel,
  runtimeLabel,
  sessionStatusOf,
  statusLabels,
} from './rows.js';
