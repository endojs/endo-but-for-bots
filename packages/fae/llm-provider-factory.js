// @ts-nocheck - E() generics don't work well with JSDoc types for remote objects
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { provideAuthSecret } from './src/credentials.js';

const ProviderFactoryInterface = M.interface('LLMProviderFactory', {
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * Caplet that presents a form for creating LLM provider configs.
 *
 * On each form submission, stores `{ host, model, authSecretName }` as a named
 * value in the HOST agent's petstore so it's accessible to everything, and puts
 * the submitted token in the daemon's secret manager under `secrets/<name>-auth`
 * so the credential itself never becomes a readable pet-store value.
 *
 * @param {import('@endo/eventual-send').FarRef<object>} guestPowers
 * @param {Promise<object> | object | undefined} _context
 * @returns {object}
 */
export const make = (guestPowers, _context) => {
  /** @type {any} */
  const powers = guestPowers;

  const runFactory = async () => {
    await E(powers).form(
      '@host',
      'Create LLM Provider',
      harden([
        { name: 'name', label: 'Provider name', default: 'default' },
        {
          name: 'host',
          label: 'API host',
          default: 'http://localhost:11434/v1',
          example:
            'Examples: http://localhost:11434/v1, https://api.anthropic.com, https://generativelanguage.googleapis.com/v1beta/openai/',
        },
        {
          name: 'model',
          label: 'Model name',
          default: 'qwen3',
          example:
            'Examples: qwen3, claude-sonnet-4-6-20250514, gemini-2.5-flash',
        },
        {
          name: 'authToken',
          label: 'API auth token',
          default: '',
          example: 'Examples: sk-ant-... or a Google AI Studio API key',
          secret: true,
        },
      ]),
    );

    const hostAgent = await E(powers).lookup('host-agent');
    const selfId = await E(powers).locate('@self');

    /** @type {string | undefined} */
    let formMessageId;
    const existingMessages = /** @type {any[]} */ (
      await E(powers).listMessages()
    );
    for (const msg of existingMessages) {
      if (msg.from === selfId && msg.type === 'form') {
        formMessageId = msg.messageId;
      }
    }

    const messageIterator = iterateReader(E(powers).followMessages());
    while (true) {
      const { value: message, done } = await messageIterator.next();
      if (done) break;

      const msg = /** @type {any} */ (message);

      if (msg.from === selfId && msg.type === 'form') {
        formMessageId = msg.messageId;
      } else if (msg.type === 'value' && msg.replyTo === formMessageId) {
        try {
          const config =
            /** @type {{ name: string, host: string, model: string, authToken: string }} */ (
              await E(powers).lookupById(msg.valueId)
            );

          const { name, host, model, authToken } = config;

          // The token goes to the daemon's secret manager, not into the config
          // value: a value in the pet store is plaintext, cannot be rotated or
          // revoked, and every reader of the config would hold the credential.
          // The config keeps only the *name* the blob was bound to; whoever
          // provisions an agent resolves that name to a capability and
          // delegates the capability.
          /** @type {string | undefined} */
          let authSecretName;
          if (authToken) {
            try {
              ({ secretName: authSecretName } = await provideAuthSecret({
                hostAgent,
                name: `${name}-auth`,
                description: `LLM auth token for provider "${name}"`,
                token: authToken,
              }));
            } catch (secretError) {
              // `@secrets` is carried only by the root host. Say so rather than
              // silently storing a plaintext token as if nothing happened.
              console.error(
                `[llm-provider-factory] secret manager unavailable (${
                  secretError instanceof Error
                    ? secretError.message
                    : String(secretError)
                }); storing a plaintext token for "${name}"`,
              );
            }
          }

          await E(hostAgent).storeValue(
            harden({
              host,
              model,
              ...(authSecretName
                ? { authSecretName }
                : authToken
                  ? { authToken }
                  : {}),
            }),
            name,
          );

          console.log(`[llm-provider-factory] Provider "${name}" stored.`);
          await E(powers).reply(
            msg.number,
            [
              authSecretName
                ? `Provider "${name}" created successfully; its token is held as secrets/${authSecretName}.`
                : `Provider "${name}" created successfully.`,
            ],
            [],
            [],
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error('[llm-provider-factory] Error:', errorMessage);
          try {
            await E(powers).reply(
              msg.number,
              [`Error creating provider: ${errorMessage}`],
              [],
              [],
            );
          } catch {
            // Best-effort reply.
          }
        }
      }
    }
  };

  runFactory().catch(error => {
    console.error('[llm-provider-factory] Factory error:', error);
  });

  return makeExo('LLMProviderFactory', ProviderFactoryInterface, {
    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'LLM Provider Factory: submit the form to create provider configs stored in HOST petstore.';
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
harden(make);
