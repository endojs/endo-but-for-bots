// @ts-check
/**
 * The status row of a turn that did not complete (R6-51; m3-interfaces.md
 * 9.3; W3.6): the plain summary (`uiTexts.turnFailed`, `turnStopped`,
 * `turnInterrupted`), the daemon's reason and the acknowledgement note when
 * there are any, and "Details", which opens "Turn journal and recovery".
 * Adapted from Floot's `TurnStatus` at `1315bef86`: Floot opened the reason
 * in place; here Details opens the recovery panel (acceptance 7) and the
 * reason is shown under the summary.
 */
import { h } from 'preact';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import { labels } from './labels.js';
import { endingOf } from './transcript.js';

/**
 * The R6-51 summary of a settled state.
 *
 * @param {string} state
 */
export const statusSummary = state => {
  switch (state) {
    case 'failed':
      return uiTexts.turnFailed;
    case 'cancelled':
      return uiTexts.turnStopped;
    case 'interrupted':
    case 'outcome-unknown':
      return uiTexts.turnInterrupted;
    default:
      return labels.turnEnded(state || 'unknown state');
  }
};

/**
 * @param {{ entry: Record<string, any>, controller: any }} props
 */
export const StatusRow = ({ entry, controller }) => {
  const { error, resolution } = endingOf(entry);
  return h(
    'div',
    {
      class: 'floot-msg-row assistant status',
      'data-turn-state': entry.state,
    },
    h(
      'div',
      { class: 'floot-msg floot-turn-status' },
      h(
        'span',
        { class: 'floot-turn-status-summary' },
        statusSummary(entry.state),
      ),
      error ? h('div', { class: 'thix-turn-status-reason' }, error) : null,
      resolution
        ? h(
            'div',
            { class: 'thix-turn-status-note' },
            labels.acknowledged(resolution),
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'thix-details-btn',
          onClick: () => controller.openRecovery(),
        },
        uiTexts.details,
      ),
    ),
  );
};
