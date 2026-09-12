// @ts-check

// Exact inference paths the broker family admits, inbound at the listener and
// outbound through a lease's route allowlist. Paths are exact (no query,
// normalization, or escaping) and each is POST. `/api/v1/chat/completions`
// is OpenRouter's OpenAI-compatible route, alongside the direct-family paths
// used by ChatGPT, Anthropic, and OpenAI-compatible gateways.
export const INFERENCE_PATHS = harden([
  '/v1/responses',
  '/v1/messages',
  '/v1/chat/completions',
  '/api/v1/chat/completions',
]);
