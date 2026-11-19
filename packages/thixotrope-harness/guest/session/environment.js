// @ts-check
/**
 * The `environment` runtime part and the shell tools (m6-interfaces.md
 * 3.8, 4.2, 4.4, 4.5, D-M6-4, D-M6-5, D-M6-9, D-M6-17): the session's side
 * of its shell environment. One module, as `tools/exec.js` holds the exec
 * entry and part: the contract's `tools/shell.js` would cost the session
 * program a module of its own (about 570 bytes, J-12041).
 *
 * - The shell tools `runCommand` and `inspectShell` (`shellToolEntries`,
 *   static tool-table entries, A.3) are offered when the session has a
 *   `Shell` (`services.shell`) and the turn's ports carry the agent-host
 *   writers a large result is staged through. Their `execute` hands the
 *   model's argument JSON, unparsed, to the part's `shell(inspect,
 *   request, ports, context)` (`inspect` true for `inspectShell`; the
 *   contract's two members, 3.8, as one); the adapter parses and
 *   validates it (R4-43). `site: 'guest'`: no retired break from the
 *   environments adapter reaches the runner (D-M6-5). Each call is opened in the part's call table
 *   (`tools/call-table.js`), then sent straight to the adapter's
 *   `ShellPort`, which the part asks once per adapter incarnation with
 *   `E(control).port()` (one manager crank) and keeps (as the promise of
 *   that ask) until a call through it fails. A retired break is the
 *   command's unknown outcome, never a restart signal (D-M6-5: the
 *   environments adapter is not the turn's adapter): the call fails with
 *   `texts.commandOutcomeUnknown`. Any other failure, a refusal of
 *   `port()` among them (the manager's stopped or released text), fails
 *   the call with its message. Either drops the port, so the next call
 *   asks again. A call cancelled while its port was being asked is never
 *   sent.
 * - `hooks.onCancel` settles the turn's shell calls with
 *   `texts.commandStopped` and, when the turn used the shell and no
 *   emergency stop is under way, sends `E.sendOnly(control).stop()`
 *   (R4-7); a turn that never ran a command sends nothing (no message on a
 *   turn that does not use the feature). `hooks.onRecover` settles them
 *   quietly (recovery wrote the unknown results) and drops the port.
 *   `hooks.admit` refuses user-facing starts while stopping or stopped.
 * - The execution state `running | stopping | stopped` (D-M6-9):
 *   `beginStop`, `resume` and `executionState` serve the `Session` methods
 *   (`session.js` adds the queue hold, the cancel and the publish, which a
 *   part may not hold); `exportExecution` / `importExecution` carry it
 *   through the export's head page (seam X-E). A session that is not
 *   running exports `stopped` (a `stopping` one too: nothing of the old
 *   environment comes along).
 *
 * State in the closure: `execution`, `port` (the promise of the last
 * `port()` ask, or undefined), `usedBy` (the Turn of the last shell call)
 * and the call table (at most `callWindow` open calls, entries deleted
 * when settled). Without `services.environment` the part is unsupported:
 * the tools are not offered (their `available` asks for `services.shell`)
 * and `beginStop` throws `texts.noEnvironmentToStop`.
 *
 * Guest rules; no module-level state.
 */
import { shellToolDescriptions, texts } from '../lib/guards/session.js';
import { messageOf } from '../lib/bounded.js';
import { isRetiredBreak } from '../lib/retired.js';
import { makeCallTable } from './tools/call-table.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { HookTurn, Runtime } from './runtime-parts.js' */
/** @import { ToolTableEntry } from './tool-table.js' */
const { E, Fail } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/**
 * @param {{ name: string, description: string, parameters: string }} description
 * @param {boolean} inspect
 * @returns {ToolTableEntry}
 */
const shellEntry = (description, inspect) =>
  harden({
    name: description.name,
    site: 'guest',
    describe: () => description,
    available: (ports, services) =>
      services?.shell !== undefined && ports?.writers !== undefined,
    execute: (request, ports, context) =>
      context.runtime.environment.shell(inspect, request, ports, context),
  });

export const shellToolEntries = harden([
  shellEntry(shellToolDescriptions.runCommand, false),
  shellEntry(shellToolDescriptions.inspectShell, true),
]);

/**
 * @typedef {'running' | 'stopping' | 'stopped'} Execution
 * @typedef {{ state: Execution, supported: boolean }} ExecutionState
 */

export const environmentPart = harden({
  name: /** @type {const} */ ('environment'),
  /** @param {Runtime} runtime */
  make: runtime => {
    /** @returns {any} the EnvironmentControl, or undefined */
    const control = () => runtime.services?.environment;
    /** @type {Execution} */
    let execution = 'running';
    /** @type {Promise<any> | undefined} */
    let port;
    /** @type {any} */
    let usedBy;
    const calls = makeCallTable();

    /** @returns {ExecutionState} */
    const executionState = () =>
      harden({ state: execution, supported: control() !== undefined });

    /**
     * Send one opened call through the port; its ending settles the entry.
     * @param {any} entry
     * @param {boolean} inspect
     * @param {any} args the model's JSON text, or a StagedText
     * @param {any} ports the turn's TurnPorts
     */
    const send = async (entry, inspect, args, ports) => {
      await null;
      /** @type {any} */
      let asked;
      try {
        port ??= E(control()).port();
        asked = port;
        const held = await asked;
        if (calls.get(entry.opId) !== entry) return;
        /** @type {Record<string, any>} */
        const request = { opId: entry.opId, args, writers: ports.writers };
        if (typeof args !== 'string' && ports.content !== undefined) {
          request.content = ports.content;
        }
        calls.end(
          entry,
          await (inspect
            ? E(held).inspect(harden(request))
            : E(held).runCommand(harden(request))),
        );
      } catch (error) {
        if (port === asked) port = undefined;
        calls.end(
          entry,
          failed(
            isRetiredBreak(error)
              ? texts.commandOutcomeUnknown
              : messageOf(error),
          ),
        );
      }
    };

    /**
     * @param {boolean} inspect `ShellPort.inspect` rather than `runCommand`
     * @param {{ opId: string, args: any }} request
     * @param {any} ports
     * @param {any} context the ToolContext
     */
    const call = (inspect, { opId, args }, ports, context) => {
      if (execution !== 'running') {
        return Promise.resolve(failed(texts.sessionStopped));
      }
      const { turn, generation } = context;
      // The runner issues at most `callWindow` calls at once, each op id
      // once, and the table holds as many: a refusal here is a bug.
      const entry =
        calls.open({ opId, turn, generation }) ??
        Fail`shell call ${opId} not opened`;
      usedBy = turn;
      void send(entry, inspect, args, ports);
      return entry.promise;
    };

    return harden({
      hooks: harden({
        /** @param {HookTurn} hookTurn */
        onCancel: ({ active: { turn } }) => {
          const ended = calls.endTurn(
            turn,
            failed(texts.commandStopped),
            false,
          );
          if (
            (ended > 0 || usedBy === turn) &&
            execution === 'running' &&
            control() !== undefined
          ) {
            E.sendOnly(control()).stop();
          }
        },
        /** @param {HookTurn} hookTurn recovery wrote the unknown results */
        onRecover: ({ active: { turn } }) => {
          calls.endTurn(turn, failed(texts.toolOutcomeUnknown), true);
          port = undefined;
        },
        admit: () =>
          execution === 'running' ? undefined : texts.sessionStopped,
      }),
      /** The shell tools' `execute` (`shellToolEntries`). */
      shell: call,
      executionState,
      /**
       * Crank E1's part (4.5): `stopping`, then the control's emergency
       * stop; answers `stopped` once it is done (E2), or throws
       * `stopIncomplete` with the state left `stopping` (a retry sends
       * again). A stopped session answers at once.
       * @returns {Promise<ExecutionState>}
       */
      beginStop: () => {
        if (control() === undefined) throw Error(texts.noEnvironmentToStop);
        if (execution === 'stopped') return Promise.resolve(executionState());
        execution = 'stopping';
        return E(control())
          .emergencyStop()
          .then(
            () => {
              if (execution === 'stopping') execution = 'stopped';
              return executionState();
            },
            () => {
              throw Error(texts.stopIncomplete);
            },
          );
      },
      /**
       * `Session.resume` (4.5): refused while stopping; the control's
       * resume, then `running`. The queue's hold is not this part's.
       * @returns {Promise<ExecutionState>}
       */
      resume: async () => {
        await null;
        if (execution === 'stopping') throw Error(texts.finishStopFirst);
        if (execution === 'stopped' && control() !== undefined) {
          await E(control()).resume();
        }
        execution = 'running';
        return executionState();
      },
      /** Seam X-E: the head page's `execution`, or undefined when running. */
      exportExecution: () =>
        execution === 'running'
          ? undefined
          : harden({ ...executionState(), state: 'stopped' }),
      /**
       * Seam X-E, the import's head chunk: stopped again, and the imported
       * session's own new environment withdrawn too (`export.js` sets the
       * queue hold).
       * @param {ExecutionState} state
       */
      importExecution: state => {
        if (state.state === 'running') return;
        execution = 'stopped';
        if (control() !== undefined) E.sendOnly(control()).emergencyStop();
      },
    });
  },
});
