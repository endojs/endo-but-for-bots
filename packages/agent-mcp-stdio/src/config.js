// @ts-check
/// <reference types="ses"/>

// The harness half of the catalog contract: the same static declaration the
// server serves renders the `--allowedTools` entries and the `--mcp-config`
// entry. The catalog itself is never in the config; only the formula id (and a
// non-default daemon socket path) rides the entry's `env`.

import { renderAllowedTools } from '@endo/agent-tools/adapters/mcp.js';

import { makeAgentTools } from './agent-interface.js';
import { FORMULA_ID_ENV, SERVER_LABEL, readFormulaId } from './server.js';

/**
 * @param {ReadonlyArray<{ name: string }>} [tools]
 * @returns {string[]}
 */
export const renderGuestAllowedTools = (tools = makeAgentTools()) =>
  renderAllowedTools({ names: tools.map(({ name }) => name) }, SERVER_LABEL);
harden(renderGuestAllowedTools);

/**
 * Render the `--mcp-config` JSON naming exactly one stdio server.
 *
 * @param {object} options
 * @param {string} options.formulaId - the guest's 64-hex formula identifier.
 * @param {string} [options.command] - the server command.
 * @param {string[]} [options.commandArguments] - the server command's
 *   arguments, rendered as the entry's `args`.
 * @param {string} [options.endoSock] - a non-default daemon socket path.
 */
export const makeMcpConfig = ({
  formulaId,
  command = 'endo-mcp-stdio',
  commandArguments = [],
  endoSock,
}) => {
  readFormulaId({ [FORMULA_ID_ENV]: formulaId });
  return harden({
    mcpServers: {
      [SERVER_LABEL]: {
        command,
        args: [...commandArguments],
        env: {
          [FORMULA_ID_ENV]: formulaId,
          ...(endoSock === undefined ? {} : { ENDO_SOCK: endoSock }),
        },
      },
    },
  });
};
harden(makeMcpConfig);
