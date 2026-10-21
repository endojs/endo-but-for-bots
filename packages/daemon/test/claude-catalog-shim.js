// @ts-check
// Trusted shim for the acceptance broker only. No credential or real network
// leaves this worker; the catalog is the only HTTP operation allowed here.
/** @type {typeof globalThis.fetch} */
globalThis.fetch = async (input, options) => {
  if (
    input !== 'https://api.anthropic.com/v1/models?limit=100' ||
    options?.method !== 'GET'
  ) {
    throw Error('Unexpected network request in Claude acceptance fixture');
  }
  return Response.json({
    data: [
      {
        id: 'claude-sonnet-4-6',
        type: 'model',
        display_name: 'Acceptance Sonnet',
      },
    ],
    has_more: false,
  });
};
