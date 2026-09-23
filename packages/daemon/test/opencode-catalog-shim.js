// @ts-check
// Dedicated trusted shim for the acceptance broker's isolated worker only.
// Never use real networking or read/record the supplied credential.
/** @type {typeof globalThis.fetch} */
globalThis.fetch = async (input, options) => {
  if (
    input !== 'https://openrouter.ai/api/v1/models/user' ||
    options?.method !== 'GET'
  ) {
    throw Error('Unexpected network request in OpenCode acceptance fixture');
  }
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'openrouter/free',
          name: 'Inert free route',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
