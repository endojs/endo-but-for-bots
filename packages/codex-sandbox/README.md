# OpenAI subscription inference

Fae reaches the OpenAI Responses API through an Endo subscription capability. The existing package and broker module names identify persisted installations and sessions.

Run `setup-direct.js` with the Floot installation's host powers and OpenAI subscription configuration. The setup grants the controller `codex-inference` for inference and `codex-model-catalog` for discovery. The broker owns account selection and renewal through Secrets. Agents receive model responses and only the tools granted by their presets.

See [Floot setup](../floot/README.md) for operator instructions.
