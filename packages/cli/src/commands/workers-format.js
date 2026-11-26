/**
 * @typedef {object} Tenant
 * @property {string} name
 * @property {string} type
 */

/**
 * @typedef {object} WorkerListing
 * @property {string} name
 * @property {Array<Tenant>} tenants
 */

/**
 * Format the workers listing for display.
 *
 * In JSON mode the whole listing is pretty-printed (an empty listing renders as
 * `[]`). In text mode each worker is a line with its tenant count, followed by
 * one indented line per tenant. An empty listing renders as an empty string in
 * text mode; the caller is responsible for emitting the "No workers found."
 * diagnostic to stderr.
 *
 * @param {Array<WorkerListing>} listing
 * @param {object} [options]
 * @param {boolean} [options.json] - Output as JSON.
 * @returns {string}
 */
export const formatWorkers = (listing, { json = false } = {}) => {
  if (json) {
    return JSON.stringify(listing, null, 2);
  }
  const lines = [];
  for (const { name, tenants } of listing) {
    const count = tenants.length;
    lines.push(`${name} (${count} tenant${count !== 1 ? 's' : ''})`);
    for (const tenant of tenants) {
      lines.push(`  ${tenant.name} [${tenant.type}]`);
    }
  }
  return lines.join('\n');
};
