# Anthropic subscription inference

Fae uses the Anthropic Messages API through an Endo subscription capability. The package and broker module paths identify existing installations and sessions.

Use `login.js` for subscription OAuth and `setup-direct.js` to grant `claude-inference` to the Floot controller. The broker pools eligible accounts and renews credentials through Secrets. Session storage preserves the signed thinking blocks and tool results needed by later turns.

The container mount bridge is a separate privileged service used by Endo development environments.

See [Floot setup](../floot/README.md) for operator instructions.
