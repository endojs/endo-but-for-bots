// @ts-check
/**
 * "Turn journal and recovery" (R6-51; m3-interfaces.md 9.1, 9.3; W3.6):
 * the session's turns newest first as `History.page` gives them (kept
 * turns and archived ones alike), paged on demand with "Older turns"
 * (`controller.moreRecovery`). A turn opens to its reason, its tool calls
 * and results, and its acknowledgement; an unresolved `outcome-unknown`
 * turn offers "Record acknowledgement" (`controller.resolveTurn(turnId,
 * note)`) once the operator has written a note and confirmed checking
 * external effects. Adapted from Floot's `RecoveryPanel` at `1315bef86`:
 * Floot read one journal with tool and activity evidence; here the
 * evidence is the turn's transcript records.
 */
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import { labels } from './labels.js';
import { formatPayload } from './ToolGroup.js';
import { endingOf, messagesOfRecords } from './transcript.js';

/**
 * The acknowledgement of a turn: the page's, else the one the view learnt
 * after `resolveTurn`.
 *
 * @param {Record<string, any>} turn
 * @param {Record<string, any> | null} view
 */
const resolutionOf = (turn, view) => {
  const { resolution } = endingOf(turn);
  if (resolution !== undefined) return resolution;
  const entry =
    view &&
    view.messages.find(
      (/** @type {Record<string, any>} */ item) => item.turnId === turn.turnId,
    );
  return entry ? entry.resolution : undefined;
};

/**
 * @param {{ turn: Record<string, any>, view: Record<string, any> | null, controller: any }} props
 */
const RecoveryTurn = ({ turn, view, controller }) => {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [resolving, setResolving] = useState(false);
  // What this panel recorded: `resolveTurn` updates the transcript's entry
  // but not the panel's page (an archived turn may have no entry).
  const [recorded, setRecorded] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const { error } = endingOf(turn);
  const resolution = resolutionOf(turn, view) ?? recorded;
  const unknown = turn.state === 'outcome-unknown' && !resolution;
  const busy = Boolean(view && view.busy);
  const tools = expanded
    ? messagesOfRecords(turn.records ?? []).filter(
        message => message.role === 'tool',
      )
    : [];
  const acknowledge = () => {
    setResolving(true);
    const text = note.trim();
    const before = controller.getState().status;
    Promise.resolve(controller.resolveTurn(turn.turnId, text))
      .then(() => {
        // `resolveTurn` reports a failure in the status line and answers
        // undefined either way: a status that did not change means it
        // worked.
        if (controller.getState().status === before) setRecorded(text);
      })
      .finally(() => setResolving(false));
  };
  return h(
    'div',
    {
      class: `floot-recovery-turn${unknown ? ' unknown' : ''}${
        resolution ? ' acknowledged' : ''
      }${turn.sealed ? ' sealed' : ''}`,
      'data-turn': turn.turnId,
    },
    h(
      'button',
      {
        type: 'button',
        class: 'thix-recovery-head',
        'aria-expanded': expanded ? 'true' : 'false',
        onClick: () => setExpanded(!expanded),
      },
      `Turn ${turn.turnId}: ${turn.state}${resolution ? ' (acknowledged)' : ''}`,
    ),
    expanded
      ? h(
          'div',
          { class: 'floot-recovery-turn-body' },
          error ? h('pre', { class: 'thix-recovery-error' }, error) : null,
          h('h4', null, labels.toolEvidence),
          tools.length === 0
            ? h('p', null, labels.noToolEvidence)
            : tools.map((tool, index) =>
                h(
                  'div',
                  { key: `tool-${index}`, class: 'thix-recovery-tool' },
                  h(
                    'div',
                    { class: 'floot-tool-label' },
                    `${tool.name || 'tool'}${tool.failed ? ' (failed)' : ''}`,
                  ),
                  h(
                    'pre',
                    { class: 'floot-tool-pre' },
                    formatPayload(tool.args),
                  ),
                  tool.result === null || tool.result === undefined
                    ? null
                    : h(
                        'pre',
                        { class: 'floot-tool-pre' },
                        formatPayload(tool.result),
                      ),
                ),
              ),
          resolution ? h('p', null, labels.acknowledged(resolution)) : null,
          unknown
            ? h(
                'div',
                { class: 'thix-acknowledge' },
                h('p', null, labels.unknownOutcome),
                h(
                  'label',
                  null,
                  labels.recoveryNote,
                  h('textarea', {
                    class: 'thix-recovery-note',
                    value: note,
                    disabled: resolving,
                    /** @param {any} event */
                    onInput: event => setNote(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { class: 'floot-panel-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'thix-confirm-effects',
                      disabled: resolving,
                      'aria-pressed': confirmed ? 'true' : 'false',
                      onClick: () => setConfirmed(!confirmed),
                    },
                    confirmed ? labels.effectsChecked : labels.checkEffects,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'primary thix-acknowledge-btn',
                      disabled: busy || resolving || !confirmed || !note.trim(),
                      onClick: acknowledge,
                    },
                    uiTexts.recordAcknowledgement,
                  ),
                ),
              )
            : null,
        )
      : null,
  );
};

/**
 * @param {{ state: any, controller: any }} props
 */
export const Recovery = ({ state, controller }) => {
  const recovery = state.recovery;
  if (!recovery) return null;
  return h(
    'section',
    {
      class: 'floot-recovery floot-operator-panel',
      'aria-label': uiTexts.recoveryTitle,
    },
    h(
      'div',
      { class: 'thix-recovery-title' },
      h('h3', null, uiTexts.recoveryTitle),
      h(
        'button',
        {
          type: 'button',
          class: 'thix-recovery-close',
          onClick: () => controller.closeRecovery(),
        },
        labels.close,
      ),
    ),
    !recovery.loading && recovery.turns.length === 0
      ? h('p', null, labels.noTurns)
      : null,
    recovery.turns.map((/** @type {Record<string, any>} */ turn) =>
      h(RecoveryTurn, {
        key: turn.turnId,
        turn,
        view: state.view,
        controller,
      }),
    ),
    recovery.next !== undefined || recovery.loading
      ? h(
          'div',
          { class: 'floot-panel-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'thix-recovery-more',
              disabled: recovery.loading,
              onClick: () => controller.moreRecovery(),
            },
            recovery.loading ? labels.loadingText : labels.olderTurns,
          ),
        )
      : null,
  );
};
