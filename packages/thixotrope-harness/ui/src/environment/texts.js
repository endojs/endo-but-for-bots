// @ts-check
/**
 * Browser-visible texts of the Sandbox execution section of Settings
 * (spec R6-50, R6-57; `designs/m6-interfaces.md` 4.5). Fae's words
 * (`space-floot` `SettingsPanel.js`) where they fit this harness; the
 * running line is the harness's own, since here cancelling a turn does
 * stop its environment (R4-7).
 *
 * The refusals the panel shows (`stopIncomplete`, `finishStopFirst`,
 * `noEnvironmentToStop`) and the composer's (`sessionStopped`) are the
 * session's own rejection messages, shown as received: no copy here.
 */

export const executionTexts = harden({
  /** R6-57 group heading. */
  heading: 'Sandbox execution',
  running: 'Running.',
  stopping: 'Stop incomplete. New work remains blocked; retry cleanup.',
  stopped: 'Stopped. Local sandbox cleanup completed.',
  changing: 'Waiting for session cleanup or resume…',
  explanation:
    'Emergency stop withdraws session authority and ends local sandbox execution. Already-dispatched remote effects may still finish. History and workspace are retained.',
  /** R6-50. */
  emergencyStop: 'Emergency stop',
  retryStop: 'Retry emergency stop',
  resume: 'Resume session',
  /** After resume: the queue stays held until a new message or send-now. */
  queueHeld: 'Queued messages stay held until you send a new message.',
});
