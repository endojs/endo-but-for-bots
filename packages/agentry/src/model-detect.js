// @ts-check
/* global fetch */

/** @param {string} host */
export const fetchAvailableModels = async host => {
  try {
    const response = await fetch(host.replace(/\/v1\/?$/, '/v1/models'), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body = /** @type {{ data?: Array<{ id?: unknown }> }} */ (
      await response.json()
    );
    return (Array.isArray(body.data) ? body.data : [])
      .map(entry => entry?.id)
      .filter(id => typeof id === 'string');
  } catch {
    return null;
  }
};
harden(fetchAvailableModels);

/** @param {string[]} available @param {string} preferred */
export const chooseModel = (available, preferred) =>
  available.includes(preferred)
    ? preferred
    : (available.find(id => id.startsWith(preferred)) ?? available[0]);
harden(chooseModel);

/**
 * @param {{ host: string, explicitModel?: string, fallback?: string }} options
 */
export const resolveModel = async ({
  host,
  explicitModel,
  fallback = 'qwen3',
}) => {
  if (explicitModel) {
    return harden({ model: explicitModel, fallback, substituted: false });
  }
  const available = await fetchAvailableModels(host);
  const chosen = available ? chooseModel(available, fallback) : undefined;
  return harden({
    model: chosen ?? fallback,
    fallback,
    substituted: chosen !== undefined && chosen !== fallback,
  });
};
harden(resolveModel);
