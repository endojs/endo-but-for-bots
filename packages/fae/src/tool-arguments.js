// @ts-check

/**
 * Validate the named argument envelope before dispatch, not after destructuring
 * has silently discarded a model's invented fields. Tool-specific guards still
 * enforce values and nested contracts.
 * @param {any} schema
 * @param {unknown} args
 */
export const assertToolArguments = (schema, args) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw Error('Tool arguments must be an object');
  }
  const parameters = schema.function.parameters;
  const properties = parameters.properties ?? {};
  if (parameters.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) {
        throw Error(
          `Unexpected argument ${JSON.stringify(key)} for ${schema.function.name}; allowed arguments: ${Object.keys(properties).join(', ') || '(none)'}`,
        );
      }
    }
  }
  for (const key of parameters.required ?? []) {
    if (!Object.hasOwn(args, key)) {
      throw Error(`Missing required argument ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    if (
      (type === 'string' && typeof value !== 'string') ||
      (type === 'array' && !Array.isArray(value)) ||
      (type === 'object' &&
        (value === null ||
          typeof value !== 'object' ||
          Array.isArray(value))) ||
      (type === 'integer' && !Number.isInteger(value)) ||
      (type === 'boolean' && typeof value !== 'boolean')
    ) {
      throw Error(`Argument ${key} must be ${type}`);
    }
  }
};
harden(assertToolArguments);
