// @ts-check
/**
 * What the sessions views say about a row, a catalogue and a preset
 * (m3-interfaces.md 9.3; W3.5). Pure functions over the controller's state
 * records, adapted from `space-floot` `SessionSidebar.js` and the preset
 * modal of `FlootApp.js`: rows are found by the key the controller gave
 * them, never by a string the page made up.
 */
import {
  uiTexts,
  uiTextOf,
} from '../../../resources/agent-host/impl/gateway/protocol.js';

/** What the status circle says, for a reader who cannot see its colour. */
export const statusLabels = Object.freeze({
  passive: 'Passive',
  working: 'Working',
  error: 'Error',
});

/**
 * The circle of a row (R6-36, A-7): Working while it is created or deleted,
 * Error for any other state that is not `ready`, else its activity (an
 * unknown activity reads as Passive).
 *
 * @param {{ state?: string, activity?: string }} row
 * @returns {'passive' | 'working' | 'error'}
 */
export const sessionStatusOf = row => {
  if (row.state === 'creating' || row.state === 'deleting') return 'working';
  if (row.state !== undefined && row.state !== 'ready') return 'error';
  if (row.activity === 'working') return 'working';
  if (row.activity === 'error') return 'error';
  return 'passive';
};

/**
 * The note above the title of a row that is not ready.
 *
 * @param {string | undefined} state
 * @returns {string | undefined}
 */
export const lifecycleNote = state => {
  if (state === undefined || state === 'ready') return undefined;
  if (state === 'creating') return 'Starting…';
  if (state === 'deleting') return 'Deleting…';
  return `Unavailable: ${state}`;
};

/**
 * R6-36's first line: `backend · model · effort`, leaving out what the row
 * does not carry.
 *
 * @param {{ backendTitle?: string, modelId?: string, effort?: string }} row
 */
export const runtimeLabel = row =>
  [row.backendTitle, row.modelId, row.effort].filter(Boolean).join(' · ');

/**
 * R6-36's second line.
 *
 * @param {{ messageCount?: number, queuedCount?: number }} row
 */
export const countsLabel = row =>
  uiTextOf.rowCounts(row.messageCount ?? 0, row.queuedCount ?? 0);

/**
 * Whether a catalogue row matches the dialog's search (A-9: the page
 * filters loaded rows; `ModelPage` has no search argument).
 *
 * @param {{ title?: string, modelId?: string }} row
 * @param {string} query
 */
export const matchesModel = (row, query) => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [row.title ?? '', row.modelId ?? ''].some(value =>
    value.toLowerCase().includes(needle),
  );
};

/**
 * The note under the model picker when discovery failed (R6-38): a stale
 * list ("Showing the last available model list.") or none at all ("Some
 * accounts could not be reached.", with the catalogue's own text).
 *
 * @param {{ rows: any[], state: string, error?: string }} models
 * @returns {string[]} lines, empty when discovery is fine
 */
export const discoveryNotes = models => {
  const failed = models.state === 'unavailable' || models.error !== undefined;
  if (!failed) return [];
  if (models.rows.length > 0) return [uiTexts.lastModelList];
  return models.error === undefined
    ? [uiTexts.accountsUnreachable]
    : [uiTexts.accountsUnreachable, models.error];
};
